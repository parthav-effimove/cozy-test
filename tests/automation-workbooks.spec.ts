import { test, expect, Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { ensureDashboard, skipIfNoCalculator } from './helpers';

/**
 * Voyage Calculator — Automated Workbook Filler.
 *
 * Creates SHARDS workbooks (default 4, override with SHARDS env) with SHEETS
 * sheets in total (default 32, override with SHEETS env) and fills every sheet
 * with randomized but VALID voyage data:
 *
 *   1. Vessel      — backend pick (10k+ DWT bulker) + speeds + full
 *                     consumption matrix (VLSFO / LSMGO / AE).
 *   2. Sequence    — load + discharge ports from the backend, optional extra
 *                     legs (Add / Repos), load capped under DWT with discharge
 *                     legs balanced to equal the load.
 *   3. Cargo       — rate, commissions, demurrage / despatch, GTC.
 *   4. Intake      — intake calculator filled + applied.
 *   5. Misc/Bunker — canal + misc costs, bunker ROB quantities / prices, ETS.
 *   6. Validate    — zero "needs attention" items, no NaN, then Save Sheet.
 *
 * Outputs per shard: test-results/automation-workbooks-<A|B|C|…>.json
 * with the workbook name, seed and the recorded inputs of every saved sheet
 * (seeded RNG — re-run with the same SEED for identical sheets).
 *
 * Run:  PW_WORKERS=4 npx playwright test tests/automation-workbooks.spec.ts
 * Env:  SHEETS=32 SHARDS=4 SEED=12345 WORKBOOK_NAME="my run"
 * Needs: VOYAGE_EMAIL / VOYAGE_PASSWORD in .env when the app gates login.
 */

// --- Config ----------------------------------------------------------------

const VESSEL_QUERIES = ['FUGA', 'OCEAN', 'NORDIC', 'ATLANTIC', 'BALTIC', 'CORAL'];
const PORT_QUERIES = [
  'Singapore', 'Tubarao', 'Qingdao', 'Santos', 'Durban', 'Riau',
  'Paradip', 'Colombo', 'Rotterdam', 'Fujairah', 'Mumbai', 'Tokyo',
];
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const SAVED_SCREENSHOT_EVERY = 8;

const TOTAL = Number(process.env.SHEETS ?? 32);
const SHARDS = Math.max(1, Number(process.env.SHARDS ?? 4));
// Full epoch ms, not % 100000: that stamp repeats every 100 seconds, so a
// re-run could land on an existing workbook name.
const STAMP = process.env.WORKBOOK_NAME ?? `automation test ${Date.now()}`;
const BASE_SEED = Number(process.env.SEED ?? Date.now() % 100000);
const PER_SHARD = Math.ceil(TOTAL / SHARDS);

/** Seeded RNG (mulberry32) so runs are reproducible via SEED. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Small helpers -----------------------------------------------------------

/**
 * Pick a backend suggestion for each query until one sticks.
 * The suggestion dropdown (e.g. "Antwerpen (belgium) / BEANR") sometimes
 * renders late or not at all, so each query is retried up to 3 times and
 * the option is matched by query text when several rows are showing.
 */
async function searchAndPickFirst(
  page: Page,
  input: ReturnType<Page['getByPlaceholder']>,
  queries: string[],
  api: string,
  label: string,
): Promise<string> {
  const overlay = page.locator(
    'div.absolute.z-50:has(button), div[style*="z-index: 2147483647"], div[class*="bg-popover"]',
  );
  // Suggestion rows are plain <button> in some cards but
  // <button role="option"> in the port listbox. An explicit role="option"
  // replaces the implicit button role, so getByRole('button') finds ZERO
  // rows there — match the raw selector instead.
  const options = overlay.locator('button, [role="option"]');
  for (const q of queries) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await input.click();
      await input.fill('');
      await input.pressSequentially(q, { delay: 150 });
      await page
        .waitForResponse((r) => r.url().includes(api) && r.url().includes(`q=${q}`), { timeout: 20_000 })
        .catch(() => {});
      await page.waitForTimeout(1200);
      if ((await page.getByText(/no (vessels|ports) found/i).count()) > 0) break;
      if ((await overlay.first().count()) === 0) continue;
      // Prefer the row matching this query; fall back to the first row.
      const named = options
        .filter({ hasText: new RegExp(q.slice(0, 4).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })
        .first();
      const btn = (await named.count()) > 0 ? named : options.first();
      if ((await btn.count()) === 0) continue;
      await btn.click();
      await expect(input).not.toHaveValue('', { timeout: 20_000 }).catch(() => {});
      const val = await input.inputValue().catch(() => '');
      if (val) return val;
    }
  }
  throw new Error(`${label}: no backend suggestion`);
}

/** Fill a field by id when it exists and is editable (no-op otherwise). */
async function setFirst(page: Page, id: string, v: string): Promise<void> {
  const el = page.locator(id).first();
  if ((await el.count()) > 0 && (await el.isEnabled().catch(() => false))) {
    await el.fill(v).catch(() => {});
  }
}

// --- Suite -------------------------------------------------------------------

test.describe('Automation workbooks — sharded valid random sheets', () => {
  for (let shard = 0; shard < SHARDS; shard++) {
    const shardName = `${STAMP}-${LETTERS[shard] ?? shard}`;
    const firstSheet = shard * PER_SHARD;
    const lastSheet = Math.min(firstSheet + PER_SHARD, TOTAL);
    if (firstSheet >= TOTAL) break;
    const sheetCount = lastSheet - firstSheet;

    test(`shard ${LETTERS[shard] ?? shard}: workbook + ${sheetCount} valid sheets`, async ({ page }) => {
      test.setTimeout(3_600_000);
      const visible = await ensureDashboard(page);
      if (skipIfNoCalculator(visible)) test.skip(true);

      const seed = BASE_SEED + shard * 100003;
      const rnd = mulberry32(seed);
      const num = (min: number, max: number, dec = 0) =>
        Number((min + rnd() * (max - min)).toFixed(dec));
      const shuffled = <T,>(arr: T[]): T[] => [...arr].sort(() => rnd() - 0.5);
      console.log(`WORKBOOK=${shardName} sheets=${sheetCount} seed=${seed}`);

      const saved: Record<string, unknown>[] = [];
      const appErrors: string[] = [];
      page.on('pageerror', (e) => appErrors.push(`pageerror: ${String(e).slice(0, 200)}`));
      page.on('console', (m) => {
        if (m.type() === 'error') {
          const t = m.text().slice(0, 200);
          if (!/favicon|net::/i.test(t)) appErrors.push(`console: ${t}`);
        }
      });

      // 0. Create + open this shard's workbook.
      // The name must be unused: if a workbook with this name already exists,
      // the created row is ambiguous and "Open" lands in the OLD workbook,
      // which may already be at the backend's 50-sheet limit — every save then
      // fails with "409 Conflict — Workbook cannot contain more than 50
      // sheets" while the UI still reports the sheet as saved.
      let workbookName = shardName;
      const row = await test.step('create workbook', async () => {
        for (let n = 2; n < 6; n++) {
          if ((await page.locator('tr', { hasText: workbookName }).count()) === 0) break;
          workbookName = `${shardName} r${n}`;
        }
        await page.getByRole('button', { name: /new workbook/i }).first().click();
        const nameInput = page.getByPlaceholder('Workbook name');
        await expect(nameInput).toBeVisible({ timeout: 20_000 });
        await nameInput.fill(workbookName);
        await page.getByRole('button', { name: /^create$/i }).click();
        const r = page.locator('tr', { hasText: workbookName }).first();
        await expect(r).toBeVisible({ timeout: 30_000 });
        await r.getByRole('button', { name: /^open$/i }).click();
        await expect(page.getByPlaceholder('Search vessel...').first()).toBeVisible({ timeout: 60_000 });
        return r;
      });
      void row;

      for (let i = 0; i < sheetCount; i++) {
        const record: Record<string, unknown> = { sheet: firstSheet + i + 1 };
        console.log(`--- [${shardName}] sheet ${i + 1}/${sheetCount}`);

        // 1. Vessel — retry until a 10k+ DWT bulker hydrates, then speeds + matrix.
        await test.step(`sheet ${i + 1}: new + vessel`, async () => {
          if (i > 0) {
            await page.getByRole('button', { name: /^new sheet$/i }).first().click();
            await page.waitForTimeout(1500);
          }
          const search = page.getByPlaceholder('Search vessel...').first();
          await expect(search).toBeVisible({ timeout: 30_000 });
          let dwtNum = 0;
          let vesselName = '';
          for (let attempt = 0; attempt < 4 && dwtNum < 10000; attempt++) {
            const pool = attempt === 0 ? shuffled(VESSEL_QUERIES) : ['FUGA', ...shuffled(VESSEL_QUERIES)];
            vesselName = await searchAndPickFirst(page, search, pool, '/vessels', `vessel(try${attempt})`);
            const dwt = page.locator('#v-vessel-dwt-_').first();
            await expect.poll(async () => dwt.inputValue(), { timeout: 30_000 }).not.toBe('');
            dwtNum = Number((await dwt.inputValue()).replace(/[^0-9.]/g, '')) || 0;
          }
          if (!dwtNum) dwtNum = 38036;
          record.vessel = vesselName;
          record.dwt = dwtNum;
          record.safeQty = String(Math.max(1000, Math.min(31400, Math.floor(dwtNum - 2000))));
          await setFirst(page, '#v-vessel-matrix_speed_ballast-_', String(num(10, 13, 1)));
          await setFirst(page, '#v-vessel-matrix_speed_laden-_', String(num(10, 13, 1)));
          for (const f of ['vlsfo', 'lsmgo', 'ae']) {
            for (const m of ['ballast', 'laden', 'load', 'discharge', 'idle']) {
              await setFirst(page, `#v-vessel-matrix_${f}_${m}-_`, String(num(1, 28, 2)));
            }
          }
        });

        // 2. Sequence — ports, extra Add / Repos legs, balanced quantities.
        await test.step(`sheet ${i + 1}: sequence`, async () => {
          const queries = shuffled(PORT_QUERIES);
          let qi = 0;
          const nextPort = async (idx: number) => {
            const input = page.getByPlaceholder('Select port...').nth(idx);
            const val = await searchAndPickFirst(
              page, input, queries.slice(qi).concat(queries.slice(0, qi)), '/ports/search', `port[${idx}]`,
            );
            qi = (qi + 1) % queries.length;
            return val;
          };
          record.ports = [await nextPort(0), await nextPort(1), await nextPort(2)];
          const extraDisch = Math.floor(rnd() * 3);
          for (let k = 0; k < extraDisch; k++) {
            const n = await page.getByPlaceholder('Select port...').count();
            await page.getByRole('button', { name: /^add$/i }).first().click();
            await expect(page.getByPlaceholder('Select port...')).toHaveCount(n + 1, { timeout: 20_000 });
            (record.ports as string[]).push(await nextPort(n));
          }
          if (rnd() < 0.5) {
            const n = await page.getByPlaceholder('Select port...').count();
            await page.getByRole('button', { name: /^repos$/i }).first().click();
            await expect(page.getByPlaceholder('Select port...')).toHaveCount(n + 1, { timeout: 20_000 });
            (record.ports as string[]).push(await nextPort(n));
            record.repos = true;
          }
          const loadQty = record.safeQty as string;
          await setFirst(page, '#v-sequence-quantity-2', loadQty);
          await setFirst(page, '#v-sequence-productivity-2', String(num(8000, 20000, 0)));
          await setFirst(page, '#v-sequence-turnTime-2', String(num(6, 24, 0)));
          await setFirst(page, '#v-sequence-expDa-2', String(num(20000, 80000, 0)));
          // Split the load evenly across discharge legs so quantity balances.
          const total = Number(loadQty);
          const legs: number[] = [];
          for (const leg of [3, 4, 5, 6, 7, 8]) {
            if ((await page.locator(`#v-sequence-quantity-${leg}`).count()) > 0) legs.push(leg);
          }
          let assigned = 0;
          for (let d = 0; d < legs.length; d++) {
            const share = d === legs.length - 1 ? total - assigned : Math.floor(total / legs.length);
            assigned += share;
            await setFirst(page, `#v-sequence-quantity-${legs[d]}`, String(share));
            await setFirst(page, `#v-sequence-productivity-${legs[d]}`, String(num(8000, 15000, 0)));
            await setFirst(page, `#v-sequence-turnTime-${legs[d]}`, String(num(6, 24, 0)));
            await setFirst(page, `#v-sequence-expDa-${legs[d]}`, String(num(20000, 80000, 0)));
          }
          await setFirst(page, '#v-sequence-voyageCommission-2', String(num(1, 3.75, 2)));
          const fetch = page.locator('#auto-dist');
          if ((await fetch.count()) > 0 && !(await fetch.isChecked().catch(() => true))) {
            await fetch.click().catch(() => {});
          }
          await page.waitForTimeout(3000);
          for (const leg of [2, 3, 4]) {
            const d = page.locator(`#v-sequence-distance-${leg}`);
            if ((await d.count()) > 0 && (await d.inputValue()) === '') {
              await d.fill(String(num(1000, 11000, 0))).catch(() => {});
            }
          }
          record.quantity = loadQty;
        });

        // 3. Cargo + intake + misc/bunker.
        await test.step(`sheet ${i + 1}: cargo + intake + misc/bunker`, async () => {
          if (rnd() < 0.5) {
            await page.getByRole('button', { name: /add cargo/i }).click();
            await page.waitForTimeout(1200);
          }
          await setFirst(page, '#v-cargo-rate-1', String(num(15, 60, 1)));
          await setFirst(page, '#v-cargo-voyageCommission-1', String(num(1, 3.75, 2)));
          await setFirst(page, '#v-cargo-demurrageRate-1', String(num(12000, 25000, 0)));
          await setFirst(page, '#v-cargo-despatchRate-1', String(num(6000, 12500, 0)));
          await setFirst(page, '#v-cargo-gtc-_header', String(num(12000, 22000, 0)));
          for (const crow of [2, 3]) {
            if ((await page.locator(`#v-cargo-rate-${crow}`).count()) > 0) {
              await setFirst(page, `#v-cargo-rate-${crow}`, String(num(15, 60, 1)));
              await setFirst(page, `#v-cargo-voyageCommission-${crow}`, String(num(1, 3.75, 2)));
              await setFirst(page, `#v-cargo-demurrageRate-${crow}`, String(num(12000, 25000, 0)));
              await setFirst(page, `#v-cargo-despatchRate-${crow}`, String(num(6000, 12500, 0)));
            }
          }
          await page.getByRole('button', { name: /intake calculator/i }).first().click();
          const idwt = page.locator('#v-intake-dwt-_');
          await expect(idwt).toBeVisible({ timeout: 20_000 }).catch(() => {});
          if ((await idwt.count()) > 0) {
            if ((await idwt.inputValue()) === '') await idwt.fill(String(record.dwt)).catch(() => {});
            await setFirst(page, '#v-intake-constants-_', String(num(200, 600, 0)));
            await setFirst(page, '#v-intake-bunkers-_', String(num(500, 1500, 0)));
            await setFirst(page, '#v-intake-freshWater-_', String(num(80, 250, 0)));
            const sf = page.locator('#v-intake-sf-_');
            if ((await sf.count()) > 0 && (await sf.inputValue()) === '') await sf.fill('49').catch(() => {});
            const upd = page.getByRole('button', { name: /update intake/i });
            if ((await upd.count()) > 0) await upd.first().click();
            await page.waitForTimeout(1200);
            await page.keyboard.press('Escape');
            await page.waitForTimeout(800);
          }
          await setFirst(page, '#v-misc-miscCost-_', String(num(1000, 15000, 0)));
          await setFirst(page, '#v-misc-extraFees-_', String(num(500, 5000, 0)));
          await setFirst(page, '#v-misc-extraInsurance-_', String(num(500, 3000, 0)));
          await setFirst(page, '#v-misc-canalCost1-_', String(num(100000, 400000, 0)));
          await setFirst(page, '#v-misc-canalTime-_', String(num(1, 3, 1)));
          await setFirst(page, '#v-bunker-bobQuantity-hsfo', String(num(50, 200, 0)));
          await setFirst(page, '#v-bunker-bobQuantity-vlsfo', String(num(100, 400, 0)));
          await setFirst(page, '#v-bunker-vlsfoPrice-bob', String(num(500, 700, 0)));
          await setFirst(page, '#v-bunker-bobQuantity-lsmgo', String(num(30, 150, 0)));
          await setFirst(page, '#v-bunker-lsmgoPrice-bob', String(num(650, 900, 0)));
          await setFirst(page, '#v-bunker-euEtsPrice-_', String(num(70, 120, 0)));
          await setFirst(page, '#v-bunker-ukEtsPrice-_', String(num(50, 90, 0)));
        });

        // 4. Validate (no attention items, no NaN) + save.
        await test.step(`sheet ${i + 1}: validate + save`, async () => {
          const expand = page.getByRole('button', { name: /expand summary/i });
          if ((await expand.count()) > 0) await expand.first().click();
          await page.waitForTimeout(1500);
          if ((await page.getByText(/needs attention/i).count()) > 0) {
            const items = await page
              .locator('li:has-text("must equal"), li:has-text("required"), li:has-text("cannot exceed")')
              .allTextContents()
              .catch(() => []);
            console.log(`sheet ${i + 1} attention: ${items.join(' || ').slice(0, 500)}`);
          }
          await expect(page.getByText(/needs attention/i).first()).toHaveCount(0, { timeout: 20_000 });
          expect(await page.getByText('NaN').count(), 'NaN on page').toBe(0);
          if ((i + 1) % SAVED_SCREENSHOT_EVERY === 0 || i === 0) {
            await page.screenshot({ path: `screenshots/auto-${LETTERS[shard] ?? shard}-${i + 1}.png`, fullPage: false });
          }
          await page.locator('#lovable-badge').evaluateAll((els) => els.forEach((el) => el.remove())).catch(() => {});
          const quick = page.locator('button[class*="bg-white/15"]', { hasText: 'Save Sheet' }).first();
          const saver = (await quick.count()) > 0 ? quick : page.getByRole('button', { name: /^save sheet$/i }).last();
          await saver.click();
          await expect(page.getByText('Sheet saved').first()).toBeVisible({ timeout: 25_000 });
          record.cleanSummary = true;
          saved.push(record);
          console.log(`[${shardName}] saved sheet ${i + 1}/${sheetCount}`);
        });
      }

      await writeFile(
        `test-results/automation-workbooks-${LETTERS[shard] ?? shard}.json`,
        JSON.stringify({ workbook: workbookName, seed, count: sheetCount, saved }, null, 1),
      );
      expect(appErrors, `app errors:\n${appErrors.join('\n')}`).toEqual([]);
    });
  }
});
