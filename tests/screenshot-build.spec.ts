import { test, expect, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { ensureDashboard } from './helpers';

/**
 * Screenshot rebuild — creates FRESH workbooks and builds every sheet from
 * scratch by re-entering the verified inputs, then saves each sheet.
 *
 * Source of inputs: goldens/golden-15oct.json + goldens/golden-19oct.json
 * (machine-exact snapshots of the verified workbooks).
 * Source of expected outputs: the verified screenshots in
 * ~/Downloads/oct 15 and ~/Downloads/oct 19 (vessel, Sea/Port/Total,
 * economics per sheet — see tests/screenshot-cases.spec.ts).
 *
 * Two commands:
 *   Build only (recreate + save, no assertions):
 *     npx playwright test tests/screenshot-build.spec.ts --project=chromium-headless -g "19 Oct"
 *   Build + assert (recreate, save, then verify outputs match screenshots):
 *     BUILD_ASSERT=1 npx playwright test tests/screenshot-build.spec.ts --project=chromium-headless -g "19 Oct"
 *
 * Envs: WORKBOOK_NAME overrides the created workbook name base,
 *       BUILD_LIMIT caps sheets per workbook (quick check, e.g. BUILD_LIMIT=1),
 *       BUILD_ASSERT=1 turns on output assertions after each save.
 */

interface BuildCase {
  id: string;
  shot: string;       // verified screenshot(s) this sheet reproduces
  srcTab: string;     // golden sheet tab supplying the inputs
  vessel: string;
  seq: string;        // expected Sequence summary (assert mode)
  econ: string[];     // expected economics strings (assert mode)
}

interface BuildGroup {
  label: string;      // -g filter
  file: string;       // golden JSON with inputs
  wbBase: string;     // new workbook name base
  cases: BuildCase[];
}

const GROUPS: BuildGroup[] = [
  {
    label: 'Oct 15 Build',
    file: 'golden-15oct.json',
    wbBase: 'rebuild-15oct',
    cases: [
      { id: 'Oct15-B01', shot: '12.48.34', srcTab: '12', vessel: 'STAR LEO', seq: 'Sea: 36.73dPort: 20.75dTotal: 57.48d', econ: ['NTCE $ 148,944.37', 'Gross Rate $ 4.44 /mt'] },
      { id: 'Oct15-B02', shot: '12.48.45 + 12.49.33', srcTab: '11', vessel: 'STAR LEO', seq: 'Sea: 57.56dPort: 12.50dTotal: 70.06d', econ: ['Incl Hire $ 801,709.66', 'NTCE $ 38,897.97', 'Gross Rate $ 18.22 /mt'] },
      { id: 'Oct15-B03', shot: '12.50.23', srcTab: '8', vessel: 'HABCO ANKAA', seq: 'Sea: 97.74dPort: 22.50dTotal: 120.24d', econ: ['Incl Hire $ 48,435,430.52', 'NTCE $ -300,560.19', 'Gross Rate (50,000 mt) $ 863.06 /mt'] },
      { id: 'Oct15-B04', shot: '12.50.30', srcTab: 'New Sheet 7 1', vessel: 'FUGA', seq: 'Sea: 16.86dPort: 60.00dTotal: 86.86d', econ: ['Incl Hire $ 762,448.66', 'NTCE $ 22,403.81', 'Gross Rate $ 25.41 /mt'] },
      { id: 'Oct15-B05', shot: '12.50.48', srcTab: 'New Sheet 5 2', vessel: 'SHAGANG FAITH', seq: 'Sea: 62.61dPort: 507.50dTotal: 570.11d', econ: ['Incl Hire $ 8,686,394.90', 'NTCE $ 71,569.17'] },
      { id: 'Oct15-B06', shot: '12.51.01', srcTab: '5', vessel: 'FUGA', seq: 'Sea: 32.79dPort: 118.77dTotal: 156.57d', econ: ['Incl Hire $ 1,398,767.83'] },
      { id: 'Oct15-B07', shot: '12.51.11', srcTab: '3', vessel: 'FUGA', seq: 'Sea: 32.79dPort: 118.77dTotal: 151.57d', econ: ['Incl Hire $ 1,375,286.58'] },
      { id: 'Oct15-B08', shot: '12.51.17 + 12.51.24', srcTab: '2', vessel: 'FUGA', seq: 'Sea: 28.35dPort: 76.00dTotal: 104.35d', econ: ['Incl Hire $ 1,132,506.26', 'NTCE $ 32,774.10'] },
    ],
  },
  {
    label: '19 Oct Build',
    file: 'golden-19oct.json',
    wbBase: 'rebuild-19oct',
    cases: [
      { id: 'Oct19-B01', shot: '12.52.42', srcTab: '6 1', vessel: 'STAR LEO', seq: 'Sea: 74.81dPort: 23.75dTotal: 102.56d', econ: ['Incl Hire $ 1,473,895.91', 'NTCE $ 55,049.01', 'Gross Rate $ 18.66 /mt'] },
      { id: 'Oct19-B02', shot: '12.52.48', srcTab: 'sheet 7 (Copy)', vessel: 'FUGA', seq: 'Sea: 8.11dPort: 9.00dTotal: 21.11d', econ: ['Incl Hire $ 152,749.65', 'NTCE $ 133,303.00', 'Gross Rate $ 5.16 /mt'] },
      { id: 'Oct19-B03', shot: '12.52.55 + 12.53.03', srcTab: 'sheet 5', vessel: 'STAR LEO', seq: 'Sea: 74.81dPort: 23.75dTotal: 98.56d', econ: ['Incl Hire $ 1,463,030.91', 'NTCE $ 57,389.41'] },
      { id: 'Oct19-B04', shot: '12.53.09', srcTab: 'sheet 4', vessel: 'STAR LEO', seq: 'Sea: 48.11dPort: 42.08dTotal: 93.19d', econ: ['Incl Hire $ 6,548,415.46'] },
      { id: 'Oct19-B05', shot: '12.53.13', srcTab: 'sheet 3', vessel: 'STAR LEO', seq: 'Sea: 48.11dPort: 42.08dTotal: 93.19d', econ: ['Incl Hire $ 13,045,938.09', 'Gross Rate $ 188.73 /mt'] },
      { id: 'Oct19-B06', shot: '12.53.19', srcTab: 'sheet 2', vessel: 'SEA ARROW', seq: 'Sea: 36.77dPort: 31.11dTotal: 70.88d', econ: ['Incl Hire $ 7,045,005.55'] },
      { id: 'Oct19-B07', shot: '12.53.25', srcTab: 'sheet 1', vessel: 'SEA ARROW', seq: 'Sea: 36.77dPort: 20.00dTotal: 56.77d', econ: ['NTCE $ -40,879.34', 'Gross Rate $ 137.11 /mt'] },
    ],
  },
];

/** Pick a backend suggestion; retries each query (dropdown renders late). */
async function searchAndPick(
  page: Page,
  input: ReturnType<Page['getByPlaceholder']>,
  queries: string[],
  api: string,
  expectHydrate?: string,
): Promise<void> {
  for (const q of queries) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
      await input.scrollIntoViewIfNeeded().catch(() => {});
      await input.click();
      await input.fill('');
      await input.pressSequentially(q, { delay: 200 });
      await page
        .waitForResponse((r) => r.url().includes(api) && r.url().includes(`q=${encodeURIComponent(q)}`), { timeout: 20_000 })
        .catch(() => {});
      await page.waitForTimeout(1500);
      const overlay = page.locator(
        'div.absolute.z-50:has(button), div[style*="z-index: 2147483647"], div[class*="bg-popover"]',
      );
      if ((await overlay.first().count()) === 0) continue;
      let btn = overlay.getByRole('button').first();
      if (expectHydrate) {
        const named = overlay.getByRole('button').filter({ hasText: new RegExp(expectHydrate.split(/\s+/)[0], 'i') }).first();
        if ((await named.count()) > 0) btn = named;
      }
      if ((await btn.count()) === 0) continue;
      await btn.click();
      await page.waitForTimeout(800);
      if (await input.inputValue().catch(() => '')) return;
    }
  }
  throw new Error(`no backend suggestion for ${queries.join('/')}`);
}

/** Set per-leg load/disch/bkrg/pssg triggers in order (portal menu). */
async function setLegTypes(page: Page, want: string[]): Promise<string> {
  const notes: string[] = [];
  for (let i = 0; i < want.length; i++) {
    const triggers = page.locator('button.form-select-sm').filter({ hasText: /^(load|disch|bkrg|pssg)$/i });
    if ((await triggers.count()) <= i) {
      notes.push(`only ${await triggers.count()} triggers for ${want.length} golden types`);
      break;
    }
    const cur = ((await triggers.nth(i).textContent()) ?? '').trim().toLowerCase();
    if (cur === want[i]) continue;
    await triggers.nth(i).click().catch(() => {});
    await page.waitForTimeout(600);
    const clicked: string = await page.evaluate((label) => {
      const inFixed = (e: HTMLElement): boolean => {
        let n: HTMLElement | null = e;
        while (n) {
          if (window.getComputedStyle(n).position === 'fixed') return true;
          n = n.parentElement;
        }
        return false;
      };
      const all = Array.from(document.querySelectorAll('*')).filter((e) => {
        if (!(e instanceof HTMLElement)) return false;
        if (e.classList.contains('form-select-sm')) return false;
        if (e.children.length > 0) return false;
        return (e.textContent ?? '').trim().toLowerCase() === label;
      }) as HTMLElement[];
      const menu = all.filter((e) => e.getClientRects().length > 0).find((e) => inFixed(e));
      if (menu) {
        ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((t) =>
          menu.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })),
        );
        return 'ok';
      }
      return 'none';
    }, want[i]).catch(() => 'error');
    await page.waitForTimeout(800);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
    const now = ((await triggers.nth(i).textContent()) ?? '').trim().toLowerCase();
    notes.push(`leg${i + 2}: ${cur}→${now} (want ${want[i]}, menu=${clicked})`);
  }
  return notes.join('; ');
}

/**
 * Build one sheet from golden inputs `g` on the current (fresh) sheet.
 * Proven order: vessel pick → ports → neutralize legs → cargo rows →
 * selects → quantities/rates/rest → leg types → refills → settle.
 */
async function buildSheet(page: Page, g: Record<string, any>, skips: string[]): Promise<void> {
  const inputs = (g.inputs ?? {}) as Record<string, string>;

  const fillConverge = async (pairs: [string, string][], rounds = 3): Promise<string[]> => {
    console.log(`  fill start: ${pairs.length} fields`);
    let bad: string[] = [];
    for (let r = 0; r < rounds; r++) {
      bad = [];
      for (const [fid, val] of pairs) {
        const el = page.locator(`#${fid}`).first();
        if ((await el.count()) === 0) { bad.push(`${fid}(missing)`); continue; }
        if (!(await el.isEnabled().catch(() => false))) { bad.push(`${fid}(disabled)`); continue; }
        if ((await el.getAttribute('readonly').catch(() => null)) !== null) { bad.push(`${fid}(readonly)`); continue; }
        const want = String(val ?? '');
        if ((await el.inputValue().catch(() => null)) === want) continue;
        await el.fill(want).catch(() => {});
        const back = await el.inputValue().catch(() => null);
        if (back !== want) bad.push(`${fid}(want=${want} got=${back})`);
      }
      const hard = bad.filter((s) => !/\((missing|readonly|disabled)\)$/.test(s));
      if (!hard.length) break;
      await page.keyboard.press('Tab').catch(() => {});
    }
    for (const s of bad) if (!skips.includes(s)) skips.push(s);
    console.log(`  fill done: ${pairs.length - bad.length}/${pairs.length} ok`);
    return bad;
  };

  console.log('  [build] step 1 vessel...');
  // 1. Vessel: direct fill, backend pick if DWT empty, then re-fill customs.
  if (g.vessel) {
    await page.getByPlaceholder('Search vessel...').first().fill(String(g.vessel)).catch(() => {});
  }
  await fillConverge(Object.entries(inputs).filter(([f]) => f.startsWith('v-vessel-')) as [string, string][]);
  if (g.vessel) {
    const dwtNow = await page.locator('#v-vessel-dwt-_').first().inputValue().catch(() => '');
    if (!dwtNow) {
      const search = page.getByPlaceholder('Search vessel...').first();
      const tokens = String(g.vessel).split(/\s+/).filter(Boolean);
      await searchAndPick(page, search, [String(g.vessel), ...tokens], '/vessels', String(g.vessel));
    }
    await page.waitForTimeout(1500);
    await fillConverge(Object.entries(inputs).filter(([f]) => f.startsWith('v-vessel-')) as [string, string][]);
  }

  console.log('  [build] step 2 ports...');
  // 2. Ports to match golden count.
  const ports: string[] = Array.isArray(g.ports) ? g.ports : [];
  for (let guard = 0; guard < 12 && (await page.getByPlaceholder('Select port...').count()) < ports.length; guard++) {
    await page.getByRole('button', { name: /^add$/i }).first().click().catch(() => {});
    await page.waitForTimeout(800);
  }
  for (let p = 0; p < ports.length; p++) {
    const input = page.getByPlaceholder('Select port...').nth(p);
    if ((await input.count()) === 0) break;
    if (!ports[p]) { await input.fill('').catch(() => {}); continue; }
    const first = String(ports[p]).split(/[\s/,]+/).filter(Boolean)[0];
    let picked = false;
    for (let attempt = 0; attempt < 3 && !picked; attempt++) {
      try {
        await searchAndPick(page, input, [first, String(ports[p])], '/ports/search');
        picked = true;
      } catch {
        if (attempt < 2) await page.waitForTimeout(2000);
      }
    }
    if (!picked) {
      await input.click().catch(() => {});
      await input.fill(String(ports[p])).catch(() => {});
      await input.evaluate((n) => (n as HTMLElement).blur()).catch(() => {});
      await page.waitForTimeout(800);
    }
  }

  console.log('  [build] step 3 neutralize legs...');
  // 3. Neutralize triggers to load (blocks quantity auto-alloc side effects).
  {
    const nTrig: number = await page.locator('button.form-select-sm').filter({ hasText: /^(load|disch|bkrg|pssg)$/i }).count();
    if (nTrig) await setLegTypes(page, Array(nTrig).fill('load'));
  }

  // 4. Cargo rows for multi-cargo sheets.
  {
    const cargoIdx = new Set<number>();
    for (const fid of Object.keys(inputs)) {
      const m = fid.match(/^v-cargo-[a-zA-Z]+-(\d+)$/);
      if (m) cargoIdx.add(Number(m[1]));
    }
    for (let guard = 0; guard < 4; guard++) {
      let need = false;
      for (const n of cargoIdx) {
        if (n <= 1) continue;
        if ((await page.locator(`#v-cargo-rate-${n}`).count()) === 0) { need = true; break; }
      }
      if (!need) break;
      await page.getByRole('button', { name: /add cargo/i }).first().click().catch(() => {});
      await page.waitForTimeout(1000);
    }
  }

  console.log('  [build] step 5 selects...');
  // 5. Selects before inputs (scrubber/speed switches the visible field set).
  for (const [sid, sval] of Object.entries<string>((g.selects ?? {}) as Record<string, string>)) {
    const el = sid.startsWith('select-') ? page.locator('select').nth(Number(sid.slice(7))) : page.locator(`#${sid}`).first();
    if ((await el.count()) === 0) continue;
    await el.selectOption({ value: String(sval) }).catch(async () => {
      await el.selectOption({ label: String(sval) }).catch(() => {});
    });
    await page.waitForTimeout(250);
  }

  console.log('  [build] step 6 quantities/rates/rest...');
  // 6. Inputs: quantities (ascending leg) → rates → everything else.
  const entries = Object.entries<string>(inputs);
  const legNo = (fid: string): number => Number(fid.split(/[-_]/).pop() ?? 0) || 0;
  const isQty = (fid: string): boolean =>
    /^v-sequence-quantity-\d+$/.test(fid) || /^v-cargo-op_quantity-\d+_\d+$/.test(fid);
  const isRate = (fid: string): boolean =>
    /^v-cargo-(rate|voyageCommission|tcCommission)-\d+$/.test(fid);
  await fillConverge(entries.filter(([f]) => isQty(f)).sort((a, b) => legNo(a[0]) - legNo(b[0])) as [string, string][]);
  await fillConverge(entries.filter(([f]) => isRate(f)) as [string, string][]);
  await fillConverge(entries.filter(([f]) => !isQty(f) && !isRate(f)) as [string, string][]);

  console.log('  [build] step 7 leg types...');
  // 7. Leg types last; extra triggers default to discharge.
  {
    const goldenTypes: string[] = Array.isArray(g.legTypes) ? g.legTypes : [];
    const nTrig: number = await page.locator('button.form-select-sm').filter({ hasText: /^(load|disch|bkrg|pssg)$/i }).count();
    const want: string[] = [];
    for (let i = 0; i < nTrig; i++) want.push(i < goldenTypes.length ? goldenTypes[i] : 'disch');
    if (want.length) await setLegTypes(page, want);
  }
  // 7b. Restore vessel customs wiped by leg-switch re-renders.
  await fillConverge(entries.filter(([f]) => f.startsWith('v-vessel-')) as [string, string][]);
  // 7c. Poll for async bunker -N rows (spawned by bkrg legs).
  {
    const bkeys = Object.keys(inputs).filter((f) => /^v-bunker-.+-\d+$/.test(f));
    for (let w = 0; w < 12; w++) {
      let found = 0;
      for (const k of bkeys) found += await page.locator(`#${k}`).count();
      if (found > 0 || w === 11) break;
      await page.waitForTimeout(1000);
    }
  }
  // 7d. Re-converge quantities + op fields after switch redistribution.
  {
    const qp = entries.filter(([f]) => isQty(f)).sort((a, b) => legNo(a[0]) - legNo(b[0])) as [string, string][];
    await fillConverge(qp, 3);
    await fillConverge(entries.filter(([f]) => f.startsWith('v-cargo-op_')) as [string, string][], 2);
  }
  // 7e. Clear transient leftovers absent from golden; bunker -N LAST.
  {
    const goldenKeys = new Set(entries.map(([f]) => f));
    const cands: string[] = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll('input[id^="v-sequence-quantity-"], input[id^="v-cargo-op_quantity-"]').forEach((n) => {
        const e = n as HTMLInputElement;
        if (e.value) out.push(`${e.id}=${e.value}`);
      });
      return out;
    });
    for (const c of cands) {
      const fid = c.split('=')[0];
      if (goldenKeys.has(fid)) continue;
      const el = page.locator(`#${fid}`).first();
      if (!(await el.isEnabled().catch(() => false))) continue;
      await el.fill('').catch(() => {});
    }
    const bpairs = Object.keys(inputs)
      .filter((f) => /^v-bunker-.+-\d+$/.test(f))
      .map((k): [string, string] => [k, String(inputs[k] ?? '')]);
    await fillConverge(bpairs, 2);
  }
  console.log('  [build] step 7f settle...');
  // 7f. Settle until attention + summary stop changing.
  {
    let prev = '';
    for (let s = 0; s < 8; s++) {
      await page.waitForTimeout(1500);
      const cur: string = await page.evaluate(() =>
        Array.from(document.querySelectorAll('li'))
          .map((li) => (li.textContent ?? '').trim().replace(/\s+/g, ' '))
          .filter((t) => /required|must equal|cannot exceed|attention/i.test(t)).join('||') +
        '##' + ((document.querySelector('button[title="Sequence summary"]')?.textContent ?? '').trim().replace(/\s+/g, ' ')));
      if (cur === prev && s >= 1) break;
      prev = cur;
    }
  }
  await page.keyboard.press('Escape').catch(() => {});
}

async function saveSheet(page: Page): Promise<boolean> {
  // The footer save button occasionally absorbs a click (overlay/badge
  // animation), so retry up to 3 times instead of firing once.
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.locator('#lovable-badge').evaluateAll((els) => els.forEach((el) => el.remove())).catch(() => {});
    const quick = page.locator('button[class*="bg-white/15"]', { hasText: 'Save Sheet' }).first();
    const saver = (await quick.count()) > 0 ? quick : page.getByRole('button', { name: /^save sheet$/i }).last();
    await saver.scrollIntoViewIfNeeded().catch(() => {});
    await saver.click().catch(() => {});
    await expect(page.getByText('Sheet saved').first()).toBeVisible({ timeout: 25_000 }).catch(() => {});
    if ((await page.getByText('Sheet saved').count()) > 0) {
      if (attempt > 1) console.log(`  save ok on attempt ${attempt}`);
      return true;
    }
    console.log(`  save attempt ${attempt}: no toast, retrying...`);
    await page.waitForTimeout(2000);
  }
  return false;
}

async function readOutputs(page: Page): Promise<{ seq: string; body: string; attention: string[]; nan: number }> {
  const seq = ((await page.locator('button[title="Sequence summary"]').first().textContent().catch(() => '')) ?? '').trim().replace(/\s+/g, ' ');
  const body: string = await page.evaluate(() => (document.body.innerText ?? '').replace(/\s+/g, ' ')).catch(() => '');
  const attention: string[] = (await page.locator('li').evaluateAll((els) =>
    els.map((li) => (li.textContent ?? '').trim().replace(/\s+/g, ' ')).filter((s) => /required|must equal|cannot exceed|attention/i.test(s)),
  ).catch(() => [] as string[])).sort();
  const nan = await page.getByText('NaN').count().catch(() => 0);
  return { seq, body, attention, nan };
}

for (const grp of GROUPS) {
  test.describe(grp.label, () => {
    test(`build ${grp.file} sheets in a fresh workbook`, async ({ page }) => {
      test.setTimeout(3_600_000);
      const ASSERT = process.env.BUILD_ASSERT === '1';
      const golden = JSON.parse(await readFile(`goldens/${grp.file}`, 'utf8')) as {
        workbook: string; capturedAt: string; sheets: Record<string, any>[];
      };
      const byTab = new Map(golden.sheets.map((s) => [s.tab, s]));
      const limit = Number(process.env.BUILD_LIMIT ?? grp.cases.length);
      const only = (process.env.BUILD_CASE ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const cases = (only.length ? grp.cases.filter((c) => only.includes(c.id)) : grp.cases).slice(0, limit);
      console.log(`BUILD ${grp.label}: ${cases.length}/${grp.cases.length} sheets, assert=${ASSERT ? 'ON' : 'OFF'}`);

      await ensureDashboard(page);
      const stamp = process.env.WORKBOOK_NAME ?? `${grp.wbBase}-${Date.now() % 100000}`;
      await page.getByRole('button', { name: /new workbook/i }).first().click();
      await expect(page.getByPlaceholder('Workbook name')).toBeVisible({ timeout: 20_000 });
      await page.getByPlaceholder('Workbook name').fill(stamp);
      await page.getByRole('button', { name: /^create$/i }).click();
      const row = page.locator('tr', { hasText: stamp }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.getByRole('button', { name: /^open$/i }).click();
      await expect(page.getByPlaceholder('Search vessel...').first()).toBeVisible({ timeout: 60_000 });
      console.log(`workbook created + opened: ${stamp}`);

      const appErrors: string[] = [];
      page.on('pageerror', (e) => appErrors.push(`pageerror: ${String(e).slice(0, 200)}`));

      let passed = 0;
      const failures: string[] = [];
      let idx = 0;
      for (const c of cases) {
        idx++;
        const g = byTab.get(c.srcTab);
        if (!g) {
          failures.push(`${c.id}: source tab "${c.srcTab}" missing in ${grp.file}`);
          continue;
        }
        if (idx > 1) {
          await page.getByRole('button', { name: /^new sheet$/i }).first().click();
          await page.waitForTimeout(1500);
        }
        const skips: string[] = [];
        try {
          await buildSheet(page, g, skips);
          const saved = await saveSheet(page);
          const gi = (g.inputs ?? {}) as Record<string, string>;
          const inputDesc = `vessel=${g.vessel} ports=[${(g.ports ?? []).filter(Boolean).join('|')}] qty2=${gi['v-sequence-quantity-2'] ?? '-'} rate=${gi['v-cargo-rate-1'] ?? '-'}`;
          if (!ASSERT) {
            const ok = saved;
            if (ok) passed++;
            else failures.push(`${c.id}: save toast missing`);
            console.log(`${ok ? 'BUILT' : 'SAVE-FAIL'} ${c.id} shot=${c.shot} ${inputDesc} saved=${saved}`);
            continue;
          }
          const out = await readOutputs(page);
          const seqOk = out.seq === c.seq;
          const econMissing = c.econ.filter((e) => !out.body.includes(e));
          const attOk = out.attention.length === 0;
          const ok = saved && seqOk && econMissing.length === 0 && attOk && out.nan === 0;
          if (ok) passed++;
          else {
            failures.push([
              `${c.id}:`,
              !saved ? 'save toast missing;' : '',
              !seqOk ? `seq=[${out.seq.slice(0, 80)}] want=[${c.seq}];` : '',
              econMissing.length ? `econ missing=[${econMissing.join(' | ').slice(0, 160)}];` : '',
              !attOk ? `attention=${out.attention.slice(0, 2).join(' | ').slice(0, 160)};` : '',
              out.nan ? 'NaN rendered;' : '',
            ].join(' '));
          }
          console.log(`${ok ? 'PASS' : 'FAIL'} ${c.id} shot=${c.shot} ${inputDesc} seq=[${out.seq.slice(0, 70)}]`);
        } catch (e) {
          failures.push(`${c.id}: error ${String(e).slice(0, 160)}`);
          console.log(`ERROR ${c.id}: ${String(e).slice(0, 200)}`);
        }
      }
      console.log(`--- ${grp.label}: ${passed} passed, ${failures.length} failed (assert=${ASSERT ? 'ON' : 'OFF'}) ---`);
      expect(failures, `${grp.label} failures:\n${failures.join('\n')}`).toEqual([]);
      expect(appErrors, `pageerrors:\n${appErrors.join('\n')}`).toEqual([]);
    });
  });
}
