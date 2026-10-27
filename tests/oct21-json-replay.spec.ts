import { test, expect, Page } from '@playwright/test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { ensureDashboard, skipIfNoCalculator } from './helpers';
import {
  compareRows,
  resolveTolerances,
  type SummaryField,
  type SummaryRow,
  type Tolerances,
} from './summary-compare';

/**
 * Replays the sheets in oct21.json through the calculator UI, one new sheet
 * per entry, in a new workbook. Run headed to watch it:
 *
 *   npx playwright test tests/oct21-json-replay.spec.ts --project=chrome --workers=1 --reporter=list
 */

type Sheet = {
  vessel: {
    name: string;
    dwt: number;
    hasScrubber?: boolean;
    fullConsumption?: Record<string, Record<string, number>>;
    ecoConsumption: Record<string, Record<string, number>>;
    speedProfile?: 'eco' | 'full';
  };
  sequence: {
    port: string;
    type: string;
    operation?: string;
    quantity: number;
    productivity: number;
    turnTime: number;
    expDa: number;
    distance: number;
    ecaDistance: number;
    seaMargin: number;
    coefficientFactor: number;
    extraTime: number;
    draft: number;
    assignedCargoIds?: number[];
  }[];
  cargos: {
    rate: number;
    voyageCommission: number;
    demurrageRate: number;
    despatchRate: number;
    ntcBase: number;
    tcCommission: number;
    gtcTarget: number;
  }[];
  bunker: {
    hsfo: { price: number; robStart: number };
    lsmgo: { price: number; robStart: number };
    vlsfo: { price: number; robStart: number };
    euEtsPrice: number;
    ukEtsPrice: number;
    fuelMode: 'fifo' | 'average';
    ignoreBOB: boolean;
    portBunkering: {
      id: number;
      portName: string;
      hsfo: { price: number; quantity: number };
      lsmgo: { price: number; quantity: number };
      vlsfo: { price: number; quantity: number };
    }[];
  };
  misc: {
    miscCost: number;
    extraFees: number;
    extraInsurance: number;
    canalCost1: number;
    extraTime: { canal1: { value: number; unit: 'days' | 'hours' } };
  };
  ecoConsumption: Record<string, Record<string, number>>;
  // Top-level totals in the new.json format.
  gtc?: number;
  ntc?: number;
  tcCommission?: number;
  grossBB?: number;
  netBB?: number;
};

const FILE = process.env.REPLAY_FILE ?? 'oct21.json';

// The backend returns same-name ports from several countries. These JSON ports mean the UK one;
// picking the US Bristol or Belfast leaves the port without its uk_zone flag and UK ETS reads 0.
const PORT_COUNTRY: Record<string, string> = {
  Belfast: 'united kingdom',
  Bristol: 'united kingdom',
};

async function searchAndPick(page: Page, input: ReturnType<Page['getByPlaceholder']>, query: string, api: string) {
  // A blank name has no backend row (an opening leg can be exported without a port); the caller
  // leaves that field empty rather than spending six retries on an empty suggestion list.
  if (!query.trim()) return '';
  // The port/vessel lookup hits the backend, which is occasionally slow or empty on the first
  // keystrokes, so retry a few times with generous waits before giving up.
  for (let attempt = 1; attempt <= 6; attempt++) {
    await input.click();
    await input.fill('');
    // Alternate between setting the value and typing it: the field usually reacts to both, but
    // one of them can miss when the suggestion popover takes focus first.
    if (attempt % 2 === 1) await input.fill(query);
    else await input.pressSequentially(query, { delay: 120 });
    const overlay = page.locator(
      'div.absolute.z-50:has(button), div[style*="z-index: 2147483647"], div[class*="bg-popover"]',
    );
    const rows = overlay.locator('button[role="option"], button, [role="option"]');
    // Continue as soon as the options appear, instead of waiting a fixed time.
    await rows.first().waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {});
    // Only pick the backend row whose name matches; never take an arbitrary first row.
    const named = rows.filter({ hasText: query });
    const wantedCountry = PORT_COUNTRY[query];
    const inCountry = wantedCountry ? named.filter({ hasText: wantedCountry }) : named;
    if (wantedCountry && (await inCountry.count()) === 0 && (await named.count()) > 0) {
      console.log(`${query}: backend has no ${wantedCountry} row, using the first name match`);
    }
    const matching = ((await inCountry.count()) > 0 ? inCountry : named).first();
    await matching.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
    if ((await matching.count()) > 0) {
      // DEBUG_PORT logs what the backend row said, which reveals a wrong same-name port
      // (e.g. Belfast, Maine instead of Belfast, UK) that would break the UK ETS zone.
      if (process.env.DEBUG_PORT === '1') {
        const text = (await matching.first().textContent().catch(() => ''))?.replace(/\s+/g, ' ').trim();
        console.log(`port pick "${query}" -> ${text}`);
      }
      await matching.click();
      // The field fills once the pick is accepted, which can trail the click.
      for (let check = 0; check < 10; check++) {
        await page.waitForTimeout(200);
        const val = await input.inputValue().catch(() => '');
        if (val.trim()) return val;
      }
    }
    console.log(`${query}: no suggestion on attempt ${attempt}`);
    await page.waitForTimeout(700 * attempt);
  }
  throw new Error(`no backend suggestion for "${query}"`);
}

// Search text typed into the port field when it differs from the JSON port name.
const PORT_SEARCH: Record<string, string> = {
  Dundee: 'dundee',
};

// Maps the JSON operation to the Type dropdown label. Missing keys are left unset.
const OPERATION_LABEL: Record<string, string> = {
  loading: 'Load',
  discharging: 'Disch',
  bunkering: 'Bkrg',
  pssg: 'Pssg',
};

const missingFields = new Set<string>();
const mismatches: string[] = [];

async function expectDerived(page: Page, id: string, expected: number, label: string) {
  const got = Number((await page.locator(id).first().inputValue()).replace(/,/g, ''));
  // Derived values are rounded to cents in the app; allow half a cent of slack.
  if (Math.abs(got - expected) > 0.005) mismatches.push(`${label} (${id}): wanted ${expected}, got ${got}`);
}

// quiet: do not record a mismatch. Matrix cells are checked once the app has settled on its own
// values, because the immediate read can miss a recalculation that has not run yet.
async function setField(page: Page, id: string, value: string | number, quiet = false) {
  const el = page.locator(id).first();
  if ((await el.count()) === 0) {
    missingFields.add(id);
    return;
  }
  await el.fill(String(value));
  await page.keyboard.press('Tab');
  const got = await el.inputValue();
  if (!quiet && Number(got.replace(/,/g, '')) !== Number(value)) mismatches.push(`${id}: wanted ${value}, got "${got}"`);
}

// Fills the consumption matrix from the JSON. Eco uses ecoConsumption, Full uses fullConsumption.
async function fillMatrix(page: Page, s: Sheet) {
  const matrix = s.vessel.speedProfile === 'full' ? s.vessel.fullConsumption : s.vessel.ecoConsumption;
  if (!matrix) throw new Error(`no consumption matrix for speedProfile ${s.vessel.speedProfile}`);
  await setField(page, '#v-vessel-matrix_speed_laden-_', matrix.speed.laden);
  await setField(page, '#v-vessel-matrix_speed_ballast-_', matrix.speed.ballast);
  // Fill AE last: the app resets AE to the vessel default when other matrix rows are edited after it.
  const order = Object.keys(matrix).filter((f) => f !== 'ae').concat('ae');
  for (const fuel of order) {
    const modes = matrix[fuel] as Record<string, number>;
    if (fuel === 'speed') continue;
    // The app shows one AE row: 'aeScrubber' (AE+Scr) when hasScrubber is true, 'ae' (AE) when false.
    // Each JSON row goes to the id with its own name; the row the app does not show is skipped.
    if (fuel === (s.vessel.hasScrubber ? 'ae' : 'aeScrubber')) continue;
    // An all-zero VLSFO row is not shown for this vessel, so there is nothing to fill.
    const allZero = Object.values(modes).every((v) => v === 0);
    if (fuel === 'vlsfo' && allZero) continue;
    // HSFO rows only exist for scrubber vessels; without one the JSON values are zero.
    if (fuel === 'hsfo' && !s.vessel.hasScrubber) {
      if (Object.values(modes).some((v) => v !== 0)) throw new Error(`${fuel} has values but vessel has no scrubber`);
      continue;
    }
    for (const [mode, value] of Object.entries(modes)) {
      if (mode.startsWith('misc')) continue;
      await setField(page, `#v-vessel-matrix_${fuel}_${mode}-_`, value, true);
    }
  }
}

// The matrix rows the app shows for this vessel, using the same rules as fillMatrix.
function shownMatrixRows(s: Sheet): [string, Record<string, number>][] {
  const matrix = s.vessel.speedProfile === 'full' ? s.vessel.fullConsumption : s.vessel.ecoConsumption;
  if (!matrix) return [];
  const rows: [string, Record<string, number>][] = [];
  for (const [fuel, modes] of Object.entries(matrix)) {
    if (fuel === 'speed') continue;
    if (fuel === (s.vessel.hasScrubber ? 'ae' : 'aeScrubber')) continue;
    if (fuel === 'vlsfo' && Object.values(modes).every((v) => v === 0)) continue;
    if (fuel === 'hsfo' && !s.vessel.hasScrubber) continue;
    rows.push([fuel, modes as Record<string, number>]);
  }
  return rows;
}

// Cells that do not hold the JSON value right now, optionally limited to one fuel row.
async function matrixMismatches(page: Page, s: Sheet, only?: string): Promise<string[]> {
  const out: string[] = [];
  for (const [fuel, modes] of shownMatrixRows(s)) {
    if (only && fuel !== only) continue;
    for (const [mode, value] of Object.entries(modes)) {
      if (mode.startsWith('misc')) continue;
      const el = page.locator(`#v-vessel-matrix_${fuel}_${mode}-_`).first();
      if ((await el.count()) === 0) continue;
      const got = Number((await el.inputValue()).replace(/,/g, ''));
      if (Math.abs(got - value) > 0.005) out.push(`${fuel} ${mode}: wanted ${value}, got ${got}`);
    }
  }
  return out;
}


// Writes the whole AE row in one burst, without blurring between cells. The app recalculates AE on
// every change, so blurring each cell makes those recalcs race and overwrite each other; one blur
// after all six values are in lets the app recalculate once, against the finished row.
async function fillAeRowBurst(page: Page, ae: Record<string, number>) {
  let last: ReturnType<Page['locator']> | undefined;
  for (const [mode, value] of Object.entries(ae)) {
    if (mode.startsWith('misc')) continue;
    const id = `#v-vessel-matrix_ae_${mode}-_`;
    const el = page.locator(id).first();
    if ((await el.count()) === 0) {
      missingFields.add(id);
      continue;
    }
    await el.click();
    await el.fill(String(value));
    last = el;
  }
  if (last) await last.press('Tab');
}

// The app restores its own matrix defaults when the vessel or sequence changes, and its recalculation
// is delayed, so rewrite the matrix until every shown cell holds the JSON value once it settles.
async function settleMatrix(page: Page, s: Sheet, label: string) {
  const ae = shownMatrixRows(s).find(([fuel]) => fuel === 'ae')?.[1];
  for (let pass = 1; pass <= 5; pass++) {
    await fillMatrix(page, s);
    // The AE row is written in one burst: blurring each cell lets its recalcs overwrite each other.
    if (ae) await fillAeRowBurst(page, ae);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(700);
    let bad = await matrixMismatches(page, s);
    if (bad.length === 0) {
      // Confirm the values survive one more render before calling it settled.
      await page.waitForTimeout(700);
      bad = await matrixMismatches(page, s);
      if (bad.length === 0) return;
    }
    console.log(`${label}: matrix not settled on pass ${pass}: ${bad.join('; ')}`);
  }
}

async function fillMatrixSettled(page: Page, s: Sheet, label: string) {
  await settleMatrix(page, s, label);
}

// The UK ETS price is rewritten by the app when its neighbours recalculate, so keep setting it
// until it holds, and log what the field finally shows (a mismatch here explains UK ETS rows).
async function settleUkEts(page: Page, want: number, label: string) {
  const el = page.locator('#v-bunker-ukEtsPrice-_').first();
  if ((await el.count()) === 0) {
    // The UK ETS card only renders for sequences with a UK port; a zero price has nothing to set.
    if (Number(want) !== 0) missingFields.add('#v-bunker-ukEtsPrice-_');
    return;
  }
  let shown = '';
  for (let pass = 1; pass <= 4; pass++) {
    await el.fill(String(want));
    await el.press('Tab');
    await page.waitForTimeout(500);
    shown = await el.inputValue().catch(() => '');
    if (Number(shown.replace(/,/g, '')) === Number(want)) {
      await page.waitForTimeout(600);
      const again = await el.inputValue().catch(() => '');
      if (Number(again.replace(/,/g, '')) === Number(want)) {
        console.log(`${label}: UK ETS price = ${want}`);
        return;
      }
      shown = again;
    }
    console.log(`${label}: UK ETS price not held on pass ${pass}: wanted ${want}, shows "${shown}"`);
  }
  console.log(`${label}: UK ETS price NOT held: wanted ${want}, shows "${shown}"`);
}

// Accepts either an array of sheets or a single sheet object (e.g. new.json).
function loadSheets(path: string): Sheet[] {
  let parsed: Sheet | Sheet[];
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Sheet | Sheet[];
  } catch (e) {
    throw new Error(`cannot read sheet file ${path}: ${(e as Error).message}`);
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

// REPLAY_LIST: a named test — JSON { name, sheets: ["balast/sheet1.json", …] } — whose sheets may come
// from any folder, in the order listed. A path may be { path, index } to pick one sheet from a file.
type ListEntry = string | { path: string; index?: number };
type ReplayList = { name?: string; sheets: ListEntry[] };
const LIST_FILE = process.env.REPLAY_LIST;
const LIST: ReplayList | null = LIST_FILE
  ? (JSON.parse(readFileSync(LIST_FILE, 'utf8')) as ReplayList)
  : null;

// REPLAY_DIR: every .json file in the folder, in natural name order (sheet2 before sheet10), becomes sheets in one workbook.
const DIR = process.env.REPLAY_DIR;
const SOURCES = LIST
  ? LIST.sheets.map((e) => (typeof e === 'string' ? e : e.path))
  : DIR
    ? readdirSync(DIR)
        .filter((f) => f.endsWith('.json'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((f) => join(DIR, f))
    : [FILE];
const SOURCE_LABEL = LIST ? (LIST.name ?? 'workbook') : (DIR ?? FILE);
// Project-relative key for a source file, so two folders holding a sheet1.json stay distinct.
const relKey = (f: string) => relative(process.cwd(), resolve(f)).split(sep).join('/');
// Keep each sheet's source file name so its expected Voyage Summary can be found by the same name.
const ALL_ENTRIES = SOURCES.flatMap((f, i) => {
  const all = loadSheets(f);
  const entry = LIST?.sheets[i];
  const index = entry && typeof entry === 'object' ? entry.index : undefined;
  const picked = typeof index === 'number' ? all.slice(index, index + 1) : all;
  return picked.map((s) => ({ s, file: basename(f), key: relKey(f) }));
});

// Sharded run: N browsers append into ONE workbook, each taking every Nth sheet (round-robin, so
// every shard gets a mix of vessels). Sheet numbers stay global and the workbook is created by the
// first shard only, so the dashboard can merge all shard logs into a single run.
const SHARD_COUNT = Math.max(1, Number(process.env.REPLAY_SHARD_COUNT ?? 1) || 1);
const SHARD_INDEX = Math.min(Math.max(0, Number(process.env.REPLAY_SHARD_INDEX ?? 0) || 0), SHARD_COUNT - 1);
const PICKED = ALL_ENTRIES.map((entry, idx) => ({ entry, g: idx + 1 })).filter(
  ({ g }) => SHARD_COUNT === 1 || (g - 1) % SHARD_COUNT === SHARD_INDEX,
);
const ENTRIES = PICKED.map((p) => p.entry);
// 1-based global sheet number for each entry this shard replays.
const SHEET_NO = PICKED.map((p) => p.g);
const TOTAL_SHEETS = ALL_ENTRIES.length;
const sheets: Sheet[] = ENTRIES.map((e) => e.s);
if (TOTAL_SHEETS === 0) throw new Error(`nothing to replay: ${SOURCE_LABEL} holds no sheets`);
if (sheets.length === 0)
  throw new Error(`shard ${SHARD_INDEX + 1}/${SHARD_COUNT} of ${SOURCE_LABEL} has no sheets to replay`);

// Voyage Summary expectations: the matching file name in SUMMARY_DIR holds the expected values.
const SUMMARY_DIR = process.env.SUMMARY_DIR ?? 'sheets/ballast-op';

// Allowed difference, set from the dashboard. Amounts (currency totals) get their own slack because
// they are summed from many rounded figures; rates, ratios and quantities stay tight. A per-field
// override wins over both, so a field can be exact even when its group is not.
const SUMMARY_TOLERANCES: Tolerances = (() => {
  const file = process.env.SUMMARY_TOLERANCES;
  try {
    const raw = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
    return resolveTolerances(raw, process.env.SUMMARY_TOLERANCE);
  } catch {
    return resolveTolerances(undefined, process.env.SUMMARY_TOLERANCE);
  }
})();

// SUMMARY_MAP: optional JSON file mapping an input sheet's file name to its expected output file.
// Keys are file names (e.g. "sheet6.json"), values are paths; unmapped sheets use SUMMARY_DIR.
const SUMMARY_MAP_FILE = process.env.SUMMARY_MAP;
const SUMMARY_MAP: Record<string, string> =
  SUMMARY_MAP_FILE && existsSync(SUMMARY_MAP_FILE) ? (JSON.parse(readFileSync(SUMMARY_MAP_FILE, 'utf8')) as Record<string, string>) : {};
// A mapping may be keyed by project path (a workbook, or a folder run) or by bare file name.
const expectedFor = (entry: { file: string; key: string }) =>
  resolve(SUMMARY_MAP[entry.key] ?? SUMMARY_MAP[entry.file] ?? join(SUMMARY_DIR, entry.file));

// The [label, value] rows of the Voyage Summary card, in the order the app renders them.
async function readVoyageSummary(page: Page): Promise<SummaryRow[]> {
  const header = page.getByRole('button', { name: /^voyage summary$/i }).first();
  if ((await header.count()) > 0 && (await header.getAttribute('aria-expanded')) === 'false') {
    await header.click().catch(() => {});
    await page.waitForTimeout(500);
  }
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')].filter((b) => /voyage summary/i.test(b.textContent ?? ''));
    const card = buttons[buttons.length - 1]?.closest('.calc-card-compact');
    if (!card) return [];
    const rows: { label: string; value: string }[] = [];
    for (const div of [...card.querySelectorAll('div')]) {
      // A row is a pair of spans (label, value). Most rows are their own div with exactly two spans;
      // the two-column grids hold those pairs directly, so pair them up as well.
      const kids = [...div.children];
      if (kids.length === 0 || kids.length % 2 !== 0) continue;
      if (!kids.every((k) => k.tagName === 'SPAN')) continue;
      for (let i = 0; i < kids.length; i += 2) {
        const label = (kids[i].textContent ?? '').trim();
        const value = (kids[i + 1].textContent ?? '').trim();
        if (label && value) rows.push({ label, value });
      }
    }
    return rows;
  });
}

// Which Voyage Summary row each expected output field appears on, in rendering order.
// The table lives in dashboard/summary-fields.json so the dashboard can list the same fields with
// their kinds (money | quantity | rate | text) for per-field tolerances.
const SUMMARY_FIELDS: SummaryField[] = JSON.parse(
  readFileSync(resolve('dashboard', 'summary-fields.json'), 'utf8'),
) as SummaryField[];

// Compares the Voyage Summary on screen with the expected output file's values.
type SequenceRow = { id: number; type: string };

/**
 * The Sequence table's physical rows, in leg order.
 *
 * The app always ends the table with a permanent Repos row, and Add inserts new legs *before* it,
 * so ids run Open=1, Load=2, Disch=3, then 5, 6, … for added legs, with the Repos row keeping a
 * lower id while sitting last. Sorting by id and moving Repos rows to the end therefore gives the
 * leg order, and each leg must be addressed by its row id — never by its position.
 */
async function readSequenceRows(page: Page): Promise<{ legs: SequenceRow[]; repos: SequenceRow[] }> {
  const rows = await page.evaluate(() => {
    const out: { id: number; type: string }[] = [];
    document.querySelectorAll('tr').forEach((tr) => {
      const wrap = tr.querySelector('[id^="v-sequence-port-"]') as HTMLElement | null;
      if (!wrap) return;
      const id = Number((wrap.id.match(/(\d+)$/) ?? [])[1]);
      const btn = tr.querySelector('button[title="Type / reorder"]') as HTMLElement | null;
      const first = tr.querySelector('td');
      const type = btn ? (btn.textContent ?? '').trim() : (first?.textContent ?? '').trim();
      out.push({ id, type });
    });
    return out;
  });
  const isRepos = (row: SequenceRow) => /^repos$/i.test(row.type);
  return {
    legs: rows.filter((r) => !isRepos(r)).sort((a, b) => a.id - b.id),
    repos: rows.filter(isRepos),
  };
}

/** True when the open sheet has no port picked yet, i.e. it is safe to fill from leg 1. */
async function sheetIsBlank(page: Page): Promise<boolean> {
  const values = await page
    .getByPlaceholder('Select port...')
    .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
  return values.every((value) => !value.trim());
}

async function compareSummary(page: Page, expected: unknown, who: string) {
  const rows = await readVoyageSummary(page);
  if (process.env.DEBUG_PORT === '1') {
    const relevant = rows.filter((r) => /uk|ets|zone/i.test(`${r.label} ${r.value}`));
    console.log(`${who} UK rows: ${relevant.map((r) => `${r.label}=${r.value}`).join(' | ') || '(none)'}`);
    const gross = rows.filter((r) => /gross/i.test(r.label));
    console.log(`${who} gross rows: ${gross.map((r) => `${r.label}=${r.value}`).join(' | ') || '(none)'}`);
  }
  const result = compareRows(rows, expected, SUMMARY_FIELDS, SUMMARY_TOLERANCES, who);
  if (result.empty) {
    mismatches.push(`${who}: Voyage Summary not found`);
    console.log(`MISMATCH ${who}: Voyage Summary not found`);
    return;
  }
  if (result.note) console.log(result.note);
  for (const m of result.bad) {
    mismatches.push(m);
    console.log(`MISMATCH ${m}`);
  }
  console.log(`${who}: Voyage Summary ${result.checked} checked, ${result.bad.length} mismatch(es)`);
}

test.describe(LIST?.name ?? 'oct21.json replay', () => {
  const shardTag = SHARD_COUNT > 1 ? ` (shard ${SHARD_INDEX + 1}/${SHARD_COUNT}: ${sheets.length} sheets)` : '';
  test(`replay ${sheets.length} sheets from ${SOURCE_LABEL}${shardTag}`, async ({ page }) => {
    test.setTimeout(3_600_000);
    const visible = await ensureDashboard(page);
    if (skipIfNoCalculator(visible)) test.skip(true);

    const appErrors: string[] = [];
    page.on('pageerror', (e) => appErrors.push(`pageerror: ${String(e).slice(0, 200)}`));

    const workbook = process.env.WORKBOOK_NAME ?? LIST?.name ?? `oct21 replay ${Date.now()}`;
    const WORKBOOK_CREATE = process.env.WORKBOOK_CREATE !== '0';
    console.log(`--- workbook: ${workbook}`);
    if (SHARD_COUNT > 1) console.log(`--- shard ${SHARD_INDEX + 1}/${SHARD_COUNT}: sheets ${SHEET_NO.join(', ')} of ${TOTAL_SHEETS}`);
    const overrides = Object.keys(SUMMARY_TOLERANCES.fields).length;
    const skipped = Object.keys(SUMMARY_TOLERANCES.skip);
    console.log(
      `--- tolerance: amounts ±${SUMMARY_TOLERANCES.amount}, rates/quantities ±${SUMMARY_TOLERANCES.rate}` +
        (overrides ? `, ${overrides} field override(s)` : '') +
        (skipped.length ? `, ${skipped.length} field(s) not checked: ${skipped.join(', ')}` : ''),
    );
    // A shared sharded run: shard 1 creates the workbook, the others wait for it to appear and open
    // it, so every shard's sheets end up in the one workbook the test is named after.
    const row = page.locator('tr', { hasText: workbook }).first();
    if (WORKBOOK_CREATE) {
      await page.getByRole('button', { name: /new workbook/i }).first().click();
      await page.getByPlaceholder('Workbook name').fill(workbook);
      await page.getByRole('button', { name: /^create$/i }).click();
      await expect(row).toBeVisible({ timeout: 30_000 });
      // The dashboard waits for this line before launching the other shards' browsers: they read the
      // workbook list only when their page loads, so they must open after the workbook exists.
      console.log(`--- workbook created: ${workbook}`);
    } else {
      console.log(`--- waiting for shard 1 to create the workbook "${workbook}"`);
      let found = false;
      let attempt = 0;
      for (; attempt < 15 && !found; attempt++) {
        found = await row.first().isVisible().catch(() => false);
        if (found) break;
        await page.waitForTimeout(3000);
        // The list is only refetched on a reload; logging in again is not needed (session is stored).
        await ensureDashboard(page);
      }
      if (!found) throw new Error(`workbook "${workbook}" was never created: shard 1 failed before making it`);
      console.log(`--- joined the workbook "${workbook}" after ${attempt} attempt(s)`);
    }
    await row.getByRole('button', { name: /^open$/i }).click();
    await expect(page.getByPlaceholder('Search vessel...').first()).toBeVisible({ timeout: 60_000 });

    for (let i = 0; i < sheets.length; i++) {
      const s = sheets[i];
      // `g` is the sheet's 1-based number in the whole workbook, so shard logs line up as one run.
      const g = SHEET_NO[i];
      console.log(`--- sheet ${g}/${TOTAL_SHEETS}: ${s.vessel.name}`);
      // The app opens a workbook on its last sheet, and in a sharded run that sheet belongs to another
      // shard. Start a new sheet whenever the open one already has ports picked; filling over it would
      // break the leg count (and overwrite work another shard just saved).
      const blank = await sheetIsBlank(page);
      if (!blank && i === 0) {
        console.log('--- open sheet already has ports: starting a new sheet instead of filling a saved one');
      }
      if (!blank) {
        await page.getByRole('button', { name: /^new sheet$/i }).first().click();
        await page.waitForTimeout(1500);
      }

      // 1. Vessel + speeds.
      const vesselSearch = page.getByPlaceholder('Search vessel...').first();
      await searchAndPick(page, vesselSearch, s.vessel.name, '/vessels');
      await page.waitForTimeout(1500);
      // Scrubbers must be Y before the HSFO and AE+Scr matrix rows exist.
      const scrubbers = page.locator('text=Scrubbers').locator('..').locator('select').first();
      if ((await scrubbers.count()) > 0) {
        await scrubbers.selectOption(s.vessel.hasScrubber ? 'Y' : 'N');
        await page.waitForTimeout(300);
      }
      await fillMatrixSettled(page, s, `sheet ${g} ${s.vessel.name} (after vessel)`);

      // 2a. Cargo cards: add one per JSON cargo (card 1 exists) and expand each, since cards start collapsed.
      for (let k = 2; k <= s.cargos.length; k++) {
        await page.getByRole('button', { name: /add cargo/i }).first().click();
        await page.waitForTimeout(500);
      }
      for (let k = 1; k <= s.cargos.length; k++) {
        if ((await page.locator(`#v-cargo-rate-${k}`).count()) === 0) {
          await page.getByRole('button', { name: /\$ ?\/ ?ton/ }).nth(k - 1).click();
          await page.waitForTimeout(300);
        }
      }

      // 2. Ports. The table starts with Open, Load, Disch and a permanent Repos row; a JSON whose
      // last leg is a repos leg uses that row, every other leg needs a row of its own.
      const wantsRepos = s.sequence[s.sequence.length - 1]?.type === 'repos';
      const legCount = wantsRepos ? s.sequence.length - 1 : s.sequence.length;
      let table = await readSequenceRows(page);
      while (table.legs.length < legCount) {
        const before = table.legs.length;
        await page.getByRole('button', { name: /^add$/i }).first().click();
        await expect
          .poll(async () => (await readSequenceRows(page)).legs.length, { timeout: 20_000 })
          .toBe(before + 1);
        table = await readSequenceRows(page);
      }
      if (table.legs.length > legCount) {
        console.log(
          `--- sheet ${g}: ${table.legs.length - legCount} extra row(s) in the app are left blank (JSON has ${s.sequence.length} legs)`,
        );
      }
      if (wantsRepos && table.repos.length === 0) {
        throw new Error(`sheet ${g}: the JSON ends with a repos leg but the app has no Repos row`);
      }
      // Leg order -> physical row id. The repos leg (always last in the export) lives in the
      // permanent Repos row, which cannot be created or retyped from the UI.
      const ordered = (wantsRepos ? [...table.legs.slice(0, legCount), table.repos[table.repos.length - 1]] : table.legs.slice(0, legCount));
      const rowFor = (p: number) => ordered[p].id;

      for (let p = 0; p < s.sequence.length; p++) {
        const leg = s.sequence[p];
        const id = rowFor(p);
        const input = page.locator(`#v-sequence-port-${id}`).locator('input').first();
        await expect(input, `sheet ${g}: leg ${p + 1} port field`).toBeVisible({ timeout: 20_000 });
        // An exported sheet can have no opening port (`"type": "open", "port": ""`). A new sheet
        // starts that way too, so leave it blank instead of searching for "" — the backend has no
        // row for it and the whole run would abort here.
        if (!leg.port.trim()) {
          console.log(`--- sheet ${g}: leg ${p + 1} (${leg.type}) has no port in the JSON, leaving it blank`);
          continue;
        }
        await searchAndPick(page, input, PORT_SEARCH[leg.port] ?? leg.port, '/ports/search');
      }

      // Set each leg's Type from the JSON operation after all ports are picked. A Repos row has no
      // Type menu (and is already what the export says), so those legs are skipped; rows that are
      // already the wanted type are left alone rather than re-clicked.
      for (let p = 1; p < s.sequence.length; p++) {
        const leg = s.sequence[p];
        if (leg.type === 'repos') continue;
        const label = leg.operation ? OPERATION_LABEL[leg.operation] : undefined;
        if (!label) continue;
        const id = rowFor(p);
        const row = page.locator(`#v-sequence-port-${id}`).locator('xpath=ancestor::tr[1]');
        const typeBtn = row.locator('button[title="Type / reorder"]');
        if ((await typeBtn.count()) === 0) {
          console.log(`--- sheet ${g}: leg ${p + 1} (${leg.type}) has no Type menu, leaving it as it is`);
          continue;
        }
        const current = (await typeBtn.textContent().catch(() => ''))?.trim() ?? '';
        if (current.toLowerCase() === label.toLowerCase()) continue;
        await typeBtn.click();
        await page.getByRole('menuitem', { name: label, exact: true }).click();
        await page.waitForTimeout(300);
        const after = (await typeBtn.textContent().catch(() => ''))?.trim() ?? '';
        if (after.toLowerCase() !== label.toLowerCase()) {
          console.log(`--- sheet ${g}: leg ${p + 1} type says "${after}", wanted "${label}"`);
        }
      }

      // Cargo assignment: each load/discharge leg lists the cargo ids it lifts or delivers.
      for (let p = 0; p < s.sequence.length; p++) {
        const ids = s.sequence[p].assignedCargoIds ?? [];
        if (ids.length === 0) continue;
        // Find the select in this port's own row; the Open row has none, so index-based lookup misaligns.
        const select = page
          .locator(`#v-sequence-port-${rowFor(p)}`)
          .locator('xpath=ancestor::tr[1]')
          .locator('select[title="Assign one cargo to this port"]');
        if ((await select.count()) === 0) continue;
        await select.selectOption(String(ids[0]));
        await page.waitForTimeout(300);
      }

      // Guard against blank legs: every leg the JSON gives a port to must show one. A leg that is
      // blank in the JSON stays blank on purpose.
      const portValues: string[] = [];
      for (let p = 0; p < s.sequence.length; p++) {
        const input = page.locator(`#v-sequence-port-${rowFor(p)}`).locator('input').first();
        portValues.push(await input.inputValue());
      }
      const lost = portValues.filter((v, p) => !v.trim() && (s.sequence[p]?.port ?? '').trim());
      expect(lost, 'port fields blank although the JSON has a port').toEqual([]);

      // 3. Per-leg quantities and times (leg ids are 1-based, leg 1 is the opening leg).
      for (let p = 1; p < s.sequence.length; p++) {
        const leg = s.sequence[p];
        // Field suffixes are row ids, not positions: added legs sit before the trailing Repos row.
        const n = rowFor(p);
        // Pssg and bunkering legs have no cargo quantity, mt/d, coefficient or draft inputs in the app.
        const hasCargoInputs = leg.operation !== 'pssg' && leg.operation !== 'bunkering' && leg.type !== 'repos';
        if (hasCargoInputs) {
          await setField(page, `#v-sequence-quantity-${n}`, leg.quantity);
          await setField(page, `#v-sequence-productivity-${n}`, leg.productivity);
          await setField(page, `#v-sequence-coefficientFactor-${n}`, leg.coefficientFactor);
          await setField(page, `#v-sequence-draft-${n}`, leg.draft);
        }
        // Repos rows have no turn time or extra time inputs in the app.
        if (leg.type !== 'repos') {
          await setField(page, `#v-sequence-turnTime-${n}`, leg.turnTime);
          await setField(page, `#v-sequence-extraTime-${n}`, leg.extraTime);
        }
        await setField(page, `#v-sequence-expDa-${n}`, leg.expDa);
        await setField(page, `#v-sequence-distance-${n}`, leg.distance);
        await setField(page, `#v-sequence-ecaDistance-${n}`, leg.ecaDistance);
        await setField(page, `#v-sequence-seaMargin-${n}`, leg.seaMargin);
      }

      // The app recalculates AE when the sequence changes, so fill the matrix again now that the legs exist.
      await fillMatrixSettled(page, s, `sheet ${g} ${s.vessel.name} (after sequence)`);

      // 4. Cargo.
      for (let k = 1; k <= s.cargos.length; k++) {
        const c = s.cargos[k - 1];
        await setField(page, `#v-cargo-rate-${k}`, c.rate);
        await setField(page, `#v-cargo-voyageCommission-${k}`, c.voyageCommission);
        await setField(page, `#v-cargo-demurrageRate-${k}`, c.demurrageRate);
        await setField(page, `#v-cargo-despatchRate-${k}`, c.despatchRate);
      }
      const c = s.cargos[0];
      // TC commission goes in first, then GTC and gross BB. The app derives NTC and net BB from them.
      // Top-level gtc/tcCommission/grossBB (new.json format) take precedence over the cargo entry.
      const tcComm = s.tcCommission ?? c.tcCommission;
      const gtc = s.gtc ?? c.gtcTarget;
      await setField(page, '#v-cargo-tcCommission-1', tcComm);
      await setField(page, '#v-cargo-gtc-_header', gtc);
      if (s.grossBB !== undefined) await setField(page, '#v-cargo-grossBB-_header', s.grossBB);
      // Check the derived values against the JSON totals, when given.
      const who = `sheet ${g} ${s.vessel.name}`;
      if (s.ntc !== undefined) await expectDerived(page, '#v-cargo-ntc-_', s.ntc, `${who} NTC`);
      if (s.netBB !== undefined) await expectDerived(page, '#v-cargo-netBB-_header', s.netBB, `${who} Net BB`);

      // 4b. Bunker prices and ROB.
      const b = s.bunker;
      await setField(page, '#v-bunker-euEtsPrice-_', b.euEtsPrice);
      await setField(page, '#v-bunker-ukEtsPrice-_', b.ukEtsPrice);
      await setField(page, '#v-bunker-hsfoPrice-bob', b.hsfo.price);
      await setField(page, '#v-bunker-bobQuantity-hsfo', b.hsfo.robStart);
      await setField(page, '#v-bunker-vlsfoPrice-bob', b.vlsfo.price);
      await setField(page, '#v-bunker-bobQuantity-vlsfo', b.vlsfo.robStart);
      await setField(page, '#v-bunker-lsmgoPrice-bob', b.lsmgo.price);
      await setField(page, '#v-bunker-bobQuantity-lsmgo', b.lsmgo.robStart);
      // Fuel mode and Ignore BOB come last: FIFO and Ignore BOB disable the BOB price and ROB fields.
      // The app only shows fuel mode and Ignore BOB when the sequence has a bunkering leg, so skip them otherwise.
      if (s.sequence.some((leg) => leg.operation === 'bunkering')) {
        await page.locator(`label[for="${b.fuelMode === 'fifo' ? 'fifo' : 'average'}"]`).first().click();
        const ignore = page.locator('#ignoreBOB').first();
        if ((await ignore.getAttribute('aria-checked')) !== String(b.ignoreBOB)) await ignore.click();
      }
      // Port bunkering: the app fills a backend price, so overwrite it with the JSON price and quantity.
      for (const pb of b.portBunkering) {
        await setField(page, `#v-bunker-hsfoQuantity-${pb.id}`, pb.hsfo.quantity);
        await setField(page, `#v-bunker-hsfoPrice-${pb.id}`, pb.hsfo.price);
        await setField(page, `#v-bunker-vlsfoQuantity-${pb.id}`, pb.vlsfo.quantity);
        await setField(page, `#v-bunker-vlsfoPrice-${pb.id}`, pb.vlsfo.price);
        await setField(page, `#v-bunker-lsmgoQuantity-${pb.id}`, pb.lsmgo.quantity);
        await setField(page, `#v-bunker-lsmgoPrice-${pb.id}`, pb.lsmgo.price);
      }

      // 5. Misc costs.
      await setField(page, '#v-misc-miscCost-_', s.misc.miscCost);
      await setField(page, '#v-misc-extraFees-_', s.misc.extraFees);
      await setField(page, '#v-misc-extraInsurance-_', s.misc.extraInsurance);
      // Canal time: the value goes in the input and the unit (days/hours) is picked from the select beside it.
      const canal = s.misc.extraTime.canal1;
      await setField(page, '#v-misc-canalTime-_', canal.value);
      await page.locator('#v-misc-canalTime-_').locator('xpath=following-sibling::select[1]').selectOption(canal.unit);
      await page.waitForTimeout(800);
      // Canal cost last: picking a canal time re-derives the cost from the app's transit table, so the
      // exported figure has to be written after it or it is silently replaced.
      await setField(page, '#v-misc-canalCost1-_', s.misc.canalCost1);
      await page.waitForTimeout(1200);
      const canalShown = await page.locator('#v-misc-canalCost1-_').first().inputValue().catch(() => '');
      if (Number(canalShown.replace(/,/g, '')) !== Number(s.misc.canalCost1)) {
        console.log(`--- sheet ${g}: canal cost shows "${canalShown}", wanted ${s.misc.canalCost1}`);
      }

      // Last word on the matrix: rewrite it once more, then report whatever still differs.
      await settleMatrix(page, s, `sheet ${g} ${s.vessel.name} (before save)`);
      for (const m of await matrixMismatches(page, s)) mismatches.push(`sheet ${g} ${s.vessel.name} ${m}`);

      // The UK ETS price is the last word on the bunker card: re-assert it after every other
      // field has settled, then read the summary.
      await settleUkEts(page, s.bunker.ukEtsPrice, `sheet ${g} ${s.vessel.name}`);

      // 5. Voyage Summary: compare with the expected output file when the sheet has one.
      const outFile = expectedFor(ENTRIES[i]);
      const outText = existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : '';
      if (outText) {
        await page.waitForLoadState('networkidle').catch(() => {});
        try {
          await compareSummary(page, JSON.parse(outText), who);
        } catch (e) {
          // One malformed expected file must not stop the rest of the workbook.
          mismatches.push(`${who}: expected summary could not be read (${(e as Error).message})`);
          console.log(`MISMATCH ${who}: expected summary could not be read (${(e as Error).message})`);
        }
      } else {
        // REQUIRE_EXPECTED: a sheet must have something to compare against, otherwise it is a failure.
        const why = `${outFile} is ${existsSync(outFile) ? 'empty' : 'missing'}`;
        // Prefixed like the other mismatches so the dashboard lists the reason on the sheet card.
        console.log(`MISMATCH ${who}: no expected summary (${why})`);
        if (process.env.REQUIRE_EXPECTED === '1') mismatches.push(`${who}: no expected summary (${why})`);
      }

      // 6. Save the sheet, naming it after its place in the test. Left unnamed, every sheet in a
      // sharded workbook is "New Sheet 1" (the app appends " 1", " 2" …), so a tab cannot be traced
      // back to the JSON entry it came from. Save opens a name field next to OK/Cancel, and the sheet
      // is written when OK is pressed.
      await page.locator('#lovable-badge').evaluateAll((els) => els.forEach((el) => el.remove())).catch(() => {});
      const sheetName = `${g} ${s.vessel.name}`.replace(/\s+/g, ' ').trim().slice(0, 40);
      // A toast left over from the previous sheet would fake a confirmation for this one.
      await page.getByText('Sheet saved').first().waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {});
      // The sheet toolbar's Save (title "Save Sheet") opens the name field; the role-based locator can
      // resolve to a different save control that writes the sheet without offering a name.
      const titled = page.locator('button[title="Save Sheet"]');
      const saveBtn = (await titled.count()) > 0 ? titled.last() : page.getByRole('button', { name: /^save sheet$/i }).last();
      // The save toast is occasionally missed, so click again when it does not appear.
      for (let attempt = 1; attempt <= 3; attempt++) {
        await saveBtn.click().catch(() => {});
        const nameField = page.locator('input.w-32').last();
        const okBtn = page.getByRole('button', { name: /^OK$/ }).last();
        // The field is rendered a beat after the click, so wait for it rather than probing once.
        const named = await nameField
          .waitFor({ state: 'visible', timeout: 6000 })
          .then(() => true)
          .catch(() => false);
        if (named) {
          await nameField.fill(sheetName).catch(() => {});
          await okBtn.click().catch(() => {});
        }
        const shown = await page
          .getByText('Sheet saved')
          .first()
          .waitFor({ state: 'visible', timeout: 12_000 })
          .then(() => true)
          .catch(() => false);
        if (shown) {
          console.log(`--- named sheet ${g} "${sheetName}"${named ? '' : ' (app offered no name field)'}`);
          break;
        }
        console.log(`sheet ${g}: no save confirmation on attempt ${attempt}`);
        await page.waitForLoadState('networkidle').catch(() => {});
      }
      await expect(page.getByText('Sheet saved').first()).toBeVisible({ timeout: 20_000 });
      console.log(`saved sheet ${g}/${TOTAL_SHEETS}`);
    }

    expect(missingFields.size, `missing fields: ${[...missingFields].join(', ')}`).toBe(0);
    expect(mismatches, `fields that did not keep the JSON value:\n${mismatches.join('\n')}`).toEqual([]);
    expect(appErrors, `app errors:\n${appErrors.join('\n')}`).toEqual([]);
  });
});
