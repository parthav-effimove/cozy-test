import { test, expect, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { ensureDashboard } from './helpers';

/**
 * WORKBOOK E2E — blackbox replay, organized by workbook.
 *
 * Each describe replays ONE verified workbook on fresh sheets in a NEW
 * `e2e-<workbook>-<stamp>` workbook (golden sheets are never touched) and
 * expects byte-identical outputs: sequence summary, needs-attention list,
 * and computed money fields (NTC/NetBB/GrossBB/quantity-balance).
 *
 * Run one workbook:   npx playwright test tests/golden-replay.spec.ts -g "Oct 20 Tests" --project=chromium-headless --workers=1 --reporter=list
 * Run one workbook:   npx playwright test tests/golden-replay.spec.ts -g "19 Oct Tests" --project=chromium-headless --workers=1 --reporter=list
 * Run one workbook:   npx playwright test tests/golden-replay.spec.ts -g "15 Oct Tests" --project=chromium-headless --workers=1 --reporter=list
 * Run all:             npx playwright test tests/golden-replay.spec.ts --project=chromium-headless --workers=1 --reporter=list
 *
 * Envs: GOLDEN_LIMIT caps sheets per workbook (quick check), WORKBOOK_NAME
 * overrides the replay workbook base name. Full workbooks: 10 + 9 + 20 sheets.
 */
const OUTPUT_IDS = [
  'v-cargo-ntc-_',
  'v-cargo-netBB-_header',
  'v-cargo-grossBB-_header',
  'v-cargo-quantityBalance-1',
];

const WORKBOOKS = [
  { label: 'Oct 20 Tests', file: 'golden-oct20.json', tag: 'Oct20' },
  { label: '19 Oct Tests', file: 'golden-19oct.json', tag: '19Oct' },
  { label: '15 Oct Tests', file: 'golden-15oct.json', tag: '15Oct' },
] as const;

type Outcome = 'PASS' | 'FAIL' | 'SKIP';

class WBReport {
  total = 0;
  passed = 0;
  failed = 0;
  skipped = 0;
  failures: string[] = [];

  constructor(private wb: string) {}

  header(n: number) {
    console.log('============================================================');
    console.log(`             ${this.wb.toUpperCase()} TESTS — ${n} SHEETS`);
    console.log('============================================================\n');
  }

  kase(id: string, sheet: string, input: string, expected: string, actual: string, result: Outcome, why = '') {
    this.total++;
    if (result === 'PASS') this.passed++;
    else if (result === 'FAIL') {
      this.failed++;
      this.failures.push(`${id} ${sheet}: ${why || actual}`);
    } else this.skipped++;
    console.log(`[${id}] ${this.wb} — ${sheet}`);
    console.log(`  Input:    ${input}`);
    console.log(`  Expected: ${expected}`);
    console.log(`  Actual:   ${actual}`);
    console.log(`  Result:   ${result}`);
    if (result === 'FAIL' && why) console.log(`  Why:      ${why}`);
    console.log('');
  }

  summary() {
    const rate = this.total ? ((this.passed / this.total) * 100).toFixed(1) : '0.0';
    console.log('============================================================');
    console.log(`             ${this.wb.toUpperCase()} SUMMARY`);
    console.log('============================================================');
    console.log(`Total Tests : ${this.total}`);
    console.log(`Passed      : ${this.passed}`);
    console.log(`Failed      : ${this.failed}`);
    console.log(`Skipped     : ${this.skipped}`);
    console.log(`Success Rate: ${rate}%`);
    console.log('============================================================');
  }
}

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

/** Set per-leg load/disch/bkrg/pssg triggers in order (portal menu, proven pattern). */
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

for (const wb of WORKBOOKS) {
  test.describe(wb.label, () => {
    test(`replay ${wb.file} sheet by sheet`, async ({ page }) => {
      test.setTimeout(3_600_000);
      const report = new WBReport(wb.tag);
      const golden = JSON.parse(await readFile(`goldens/${wb.file}`, 'utf8')) as {
        workbook: string;
        capturedAt: string;
        sheets: Record<string, any>[];
      };
      const limit = Number(process.env.GOLDEN_LIMIT ?? golden.sheets.length);
      const sheets = golden.sheets.slice(0, limit);
      report.header(sheets.length);
      console.log(`source workbook="${golden.workbook}" captured=${golden.capturedAt} replaying ${sheets.length}/${golden.sheets.length}`);

      await ensureDashboard(page);
      const stamp = process.env.WORKBOOK_NAME ?? `e2e-${wb.tag}-${Date.now() % 100000}`;
      await page.getByRole('button', { name: /new workbook/i }).first().click();
      await expect(page.getByPlaceholder('Workbook name')).toBeVisible({ timeout: 20_000 });
      await page.getByPlaceholder('Workbook name').fill(stamp);
      await page.getByRole('button', { name: /^create$/i }).click();
      const row = page.locator('tr', { hasText: stamp }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.getByRole('button', { name: /^open$/i }).click();
      await expect(page.getByPlaceholder('Search vessel...').first()).toBeVisible({ timeout: 60_000 });

      const appErrors: string[] = [];
      page.on('pageerror', (e) => appErrors.push(`pageerror: ${String(e).slice(0, 200)}`));

      let idx = 0;
      for (const g of sheets) {
        idx++;
        const id = `${wb.tag}-${String(idx).padStart(2, '0')}`;
        if (idx > 1) {
          await page.getByRole('button', { name: /^new sheet$/i }).first().click();
          await page.waitForTimeout(1500);
        }
        let actual = '';
        let why = '';
        let pass = false;
        try {
          // 1. Vessel data entered directly (exact recorded values).
          if (g.vessel) {
            const search = page.getByPlaceholder('Search vessel...').first();
            await search.fill(String(g.vessel)).catch(() => {});
          }
          for (const [fid, val] of Object.entries<string>((g.inputs ?? {}) as Record<string, string>)) {
            if (!fid.startsWith('v-vessel-')) continue;
            const el = page.locator(`#${fid}`).first();
            if ((await el.count()) === 0) continue;
            if (!(await el.isEnabled().catch(() => false))) continue;
            if ((await el.getAttribute('readonly').catch(() => null)) !== null) continue;
            await el.fill(String(val ?? '')).catch(() => {});
          }
          if (g.vessel) {
            const dwtNow = await page.locator('#v-vessel-dwt-_').first().inputValue().catch(() => '');
            if (!dwtNow) {
              const search = page.getByPlaceholder('Search vessel...').first();
              const tokens = String(g.vessel).split(/\s+/).filter(Boolean);
              await searchAndPick(page, search, [String(g.vessel), ...tokens], '/vessels', String(g.vessel));
            }
            // Picking the vessel repopulates the matrix with backend
            // defaults, wiping the pre-fill above (and golden sheets carry
            // user-customized matrix values like aeScrubber=0.2). Re-fill.
            await page.waitForTimeout(1500);
            for (const [fid, val] of Object.entries<string>((g.inputs ?? {}) as Record<string, string>)) {
              if (!fid.startsWith('v-vessel-')) continue;
              const el = page.locator(`#${fid}`).first();
              if ((await el.count()) === 0) continue;
              if (!(await el.isEnabled().catch(() => false))) continue;
              if ((await el.getAttribute('readonly').catch(() => null)) !== null) continue;
              await el.fill(String(val ?? '')).catch(() => {});
            }
          }

          // 2. Port rows to match golden count (empties kept as blanks).
          const ports: string[] = Array.isArray(g.ports) ? g.ports : [];
          for (let guard = 0; guard < 12 && (await page.getByPlaceholder('Select port...').count()) < ports.length; guard++) {
            await page.getByRole('button', { name: /^add$/i }).first().click().catch(() => {});
            await page.waitForTimeout(800);
          }
          for (let p = 0; p < ports.length; p++) {
            const input = page.getByPlaceholder('Select port...').nth(p);
            if ((await input.count()) === 0) break;
            if (!ports[p]) {
              await input.fill('').catch(() => {});
              continue;
            }
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
              console.log(`  direct port fill (backend missing): ${ports[p]}`);
              await input.click().catch(() => {});
              await input.fill(String(ports[p])).catch(() => {});
              await input.evaluate((n) => (n as HTMLElement).blur()).catch(() => {});
              await page.waitForTimeout(800);
            }
          }

          // 3. Leg types are set in step 7, AFTER quantities are filled.
          // Rationale (verified on oct20): bkrg/pssg legs only keep quantity
          // inputs created while load/disch-typed; setting bkrg first leaves
          // no input to fill (golden leg5 proves values persist under bkrg).
          // 3b. NEUTRALIZE all switchable triggers to load first (probe14:
          // entering a quantity on a load leg auto-copies it into EMPTY
          // disch legs; with no disch-typed legs the auto-alloc has no
          // target. The triggerless final leg stays disch; any transient
          // there is overwritten by its own golden fill in step 6A).
          {
            const nTrig: number = await page.locator('button.form-select-sm').filter({ hasText: /^(load|disch|bkrg|pssg)$/i }).count();
            const neutNote = nTrig ? await setLegTypes(page, Array(nTrig).fill('load')) : 'no triggers';
            if (neutNote) console.log(`  neutralize: ${neutNote}`);
          }

          // 4. Cargo rows for multi-cargo sheets.
          const cargoIdx = new Set<number>();
          for (const fid of Object.keys((g.inputs ?? {}) as Record<string, unknown>)) {
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

          // 5. Selects BEFORE inputs: scrubber/speed-profile switches the
          // visible field set (aeScrubber fields only exist with Scrubbers=Y).
          // Per-leg fuel selects need legs to exist → ports first (done).
          for (const [sid, sval] of Object.entries<string>((g.selects ?? {}) as Record<string, string>)) {
            const el = sid.startsWith('select-') ? page.locator('select').nth(Number(sid.slice(7))) : page.locator(`#${sid}`).first();
            if ((await el.count()) === 0) continue;
            await el.selectOption({ value: String(sval) }).catch(async () => {
              await el.selectOption({ label: String(sval) }).catch(() => {});
            });
            await page.waitForTimeout(250);
          }

          const dumpQtys = async (tag: string) => {
            if (process.env.REPLAY_DEBUG !== '1') return;
            const have: string[] = await page.evaluate(() => {
              const out: string[] = [];
              document.querySelectorAll('input[id^="v-sequence-quantity"], input[id^="v-cargo-op_quantity"], input[id^="v-bunker-"]').forEach((n) => {
                const e = n as HTMLInputElement;
                out.push(`${e.id}=${JSON.stringify(e.value)}`);
              });
              return out;
            });
            console.log(`  [${tag}] (${have.length}): ${have.join(' | ').slice(0, 900)}`);
          };
          await dumpQtys('pre-fill');
          const bunkBtns: string[] = await page.evaluate(() => {
            const bi = Array.from(document.querySelectorAll('input[id^="v-bunker-"]'));
            const card = bi[0]?.closest('div[class*="card"], section');
            const out: string[] = [];
            (card ?? document).querySelectorAll('button').forEach((b) =>
              out.push(JSON.stringify((b.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40))));
            return [...new Set(out)];
          }).catch(() => []);
          if (process.env.REPLAY_DEBUG === '1') console.log(`  bunker buttons: ${bunkBtns.join(' ')}`);

          // 6. Inputs in dependency-safe order. A: quantities ascending by
          // leg (auto-alloc only writes EMPTY disch legs, which sort later
          // and get overwritten by their own golden fills). B: cargo
          // rate/commissions (locks op-table participation to qty legs).
          // C: everything else, vessel included (matrix rows exist now).
          const skips: string[] = [];
          // fillConverge: set each field then read back; re-fill mismatches
          // (up to 3 rounds). The app recycles DOM nodes on re-render, so a
          // rapid fill can land on a stale node (prod/coef swaps, tpcTpi).
          const fillConverge = async (pairs: [string, string][], rounds = 3): Promise<string[]> => {
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
                else if (r > 0) console.log(`  converge r${r}: fixed ${fid}=${want}`);
              }
              const hard = bad.filter((s) => !/\((missing|readonly|disabled)\)$/.test(s));
              if (!hard.length) break;
              if (r === rounds - 1) console.log(`  converge still bad: ${hard.slice(0, 8).join(' ')}`);
              // Commit nudge: some cards commit on blur; fill() leaves focus
              // in the field. Tab out so the value registers in app state.
              await page.keyboard.press('Tab').catch(() => {});
            }
            for (const s of bad) if (!skips.includes(s)) skips.push(s);
            return bad;
          };
          const entries = Object.entries<string>((g.inputs ?? {}) as Record<string, string>);
          const goldenKeys = new Set(entries.map(([f]) => f));
          const legNo = (fid: string): number => Number(fid.split(/[-_]/).pop() ?? 0) || 0;
          const isQty = (fid: string): boolean =>
            /^v-sequence-quantity-\d+$/.test(fid) || /^v-cargo-op_quantity-\d+_\d+$/.test(fid);
          const isRate = (fid: string): boolean =>
            /^v-cargo-(rate|voyageCommission|tcCommission)-\d+$/.test(fid);
          await fillConverge(entries.filter(([f]) => isQty(f)).sort((a, b) => legNo(a[0]) - legNo(b[0])));
          await fillConverge(entries.filter(([f]) => isRate(f)));
          await fillConverge(entries.filter(([f]) => !isQty(f) && !isRate(f)));
          if (process.env.REPLAY_DEBUG === '1') {
            await dumpQtys('post-fill');
            console.log(`  skipped fills (${skips.length}): ${skips.slice(0, 25).join(' ')}`);
            const have: string[] = await page.evaluate(() => {
              const out: string[] = [];
              document.querySelectorAll('input[id^="v-sequence-quantity"], input[id^="v-sequence-productivity"], input[id^="v-cargo-op_quantity"], input[id^="v-bunker-"]').forEach((n) => {
                const e = n as HTMLInputElement;
                if (e.value) out.push(`${e.id}=${e.value}`);
              });
              return out;
            });
            console.log(`  replay non-empty (${have.length}): ${have.join(' | ').slice(0, 600)}`);
            const trigs: string = await page.evaluate(() =>
              Array.from(document.querySelectorAll('button.form-select-sm'))
                .map((b) => (b.textContent ?? '').trim())
                .filter((t) => /^(load|disch|bkrg|pssg)$/i.test(t)).join(','),
            );
            console.log(`  replay triggers: ${trigs}`);
          }
          // 7. Leg types LAST: values are in place, switches preserve them
          // (golden leg5). Extra triggers beyond golden types (newer app
          // renders a control per leg; golden sheets lack the final one)
          // default to discharge — the final leg unloads.
          {
            const goldenTypes: string[] = Array.isArray(g.legTypes) ? g.legTypes : [];
            const nTrig: number = await page.locator('button.form-select-sm').filter({ hasText: /^(load|disch|bkrg|pssg)$/i }).count();
            const want: string[] = [];
            for (let i = 0; i < nTrig; i++) want.push(i < goldenTypes.length ? goldenTypes[i] : 'disch');
            const legNote = want.length ? await setLegTypes(page, want) : 'no triggers';
            if (legNote) console.log(`  legs: ${legNote}`);
          }
          // 7b. Leg switches re-render cards from backend defaults, wiping
          // vessel customizations (hsfo/aeScrubber matrix). Restore them.
          {
            const vpairs = Object.entries<string>((g.inputs ?? {}) as Record<string, string>)
              .filter(([f]) => f.startsWith('v-vessel-'));
            const bad = await fillConverge(vpairs);
            console.log(`  vessel post-switch refill: ${vpairs.length - bad.length}/${vpairs.length}`);
          }
          // 7c. Bunker planning rows (-N numeric suffixes) are spawned by
          // bkrg legs, so they only exist AFTER leg types are set (40/40
          // sheets: -1 row present iff a bkrg leg exists). They spawn
          // asynchronously — poll here; the actual fill is LAST (7e2),
          // since any later recalc re-renders the card and wipes values.
          {
            const bkeys = Object.keys((g.inputs ?? {}) as Record<string, string>)
              .filter((f) => /^v-bunker-.+-\d+$/.test(f));
            for (let w = 0; w < 12; w++) {
              let found = 0;
              for (const k of bkeys) found += await page.locator(`#${k}`).count();
              if (found > 0 || w === 11) {
                if (w > 0) console.log(`  bunker -N row appeared after ${w + 1}s`);
                break;
              }
              await page.waitForTimeout(1000);
            }
            if (process.env.REPLAY_DEBUG === '1') {
            if (process.env.REPLAY_DEBUG === '1') {
              const all: string[] = await page.evaluate(() => {
                const out: string[] = [];
                document.querySelectorAll('input[id^="v-"]').forEach((n) => {
                  const e = n as HTMLInputElement;
                  if (e.value && (e.id.startsWith('v-vessel-') || e.id.startsWith('v-sequence-distance-') || e.id.startsWith('v-sequence-turnTime-') || e.id.startsWith('v-cargo-quantityBalance') || e.id.startsWith('v-sequence-quantity-') || e.id.startsWith('v-cargo-op_quantity-'))) out.push(`${e.id}=${e.value}`);
                });
                document.querySelectorAll('select').forEach((s, i) => {
                  out.push(`select#${i}[name=${s.name || '-'}]=${(s as HTMLSelectElement).value}`);
                });
                return out;
              });
              console.log(`  [post-leg] vessel/dist/turn/balance/selects: ${all.join(' | ').slice(0, 1500)}`);
              const prod: string[] = await page.evaluate(() => {
                const out: string[] = [];
                document.querySelectorAll('input[id^="v-sequence-productivity"], input[id^="v-sequence-coefficientFactor"], input[id^="v-cargo-op_productivity"], input[id^="v-cargo-op_coefficientFactor"], input[id^="v-sequence-quantity"], input[id^="v-cargo-op_quantity"], input[id^="v-vessel-tpcTpi"], input[id^="v-vessel-matrix_aeScrubber_laden"]'.replace(/"\], input\["/g, '"],input["')).forEach((n) => {
                  const e = n as HTMLInputElement;
                  out.push(`${e.id}=${JSON.stringify(e.value)}`);
                });
                out.push(`qtyInputs=${document.querySelectorAll('input[id^="v-sequence-quantity-"]').length}`);
                return out;
              });
              console.log(`  [post-leg prod/coef] ${prod.join(' | ').slice(0, 900)}`);
            }
          }
          // 7d. Switches redistribute quantities (r20-3: q5/q7 cleared,
          // q3=200000) and destroy/recreate op rows (op-1_5 row deleted by
          // the bkrg switch; phantom rows born with defaults). Re-converge
          // golden quantities AND all golden op_* fields after switches.
          {
            const qp = entries.filter(([f]) => isQty(f)).sort((a, b) => legNo(a[0]) - legNo(b[0]));
            const bad = await fillConverge(qp as [string, string][], 3);
            const hard = bad.filter((s) => !/\((missing|readonly|disabled)\)$/.test(s));
            if (hard.length) console.log(`  post-switch qty still bad: ${hard.slice(0, 8).join(' ')}`);
            else console.log(`  post-switch qty converged (${qp.length} keys)`);
            const opp = entries.filter(([f]) => f.startsWith('v-cargo-op_'));
            const obad = await fillConverge(opp as [string, string][], 2);
            const ohard = obad.filter((s) => !/\((missing|readonly|disabled)\)$/.test(s));
            console.log(`  post-switch op fields: ${opp.length - obad.length}/${opp.length} ok` +
              (ohard.length ? ` bad=[${ohard.slice(0, 8).join(' ')}]` : ''));
          }
          // 7e. Clear transients: non-empty qty/op inputs absent from golden
          // (auto-alloc leftovers like q3=200000). Then settle + verify.
          {
            const cleared: string[] = [];
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
              cleared.push(fid);
            }
            if (cleared.length) console.log(`  cleared transients: ${cleared.slice(0, 10).join(' ')}`);
          }
          // 7e2. Bunker -N fill LAST: anything that recalculates after
          // this point re-renders the bunker card from state and wipes
          // DOM-only values (r20-5: 6/6 filled in 7c, all empty at final).
          {
            const bpairs = Object.keys((g.inputs ?? {}) as Record<string, string>)
              .filter((f) => /^v-bunker-.+-\d+$/.test(f))
              .map((k): [string, string] =>
                [k, String(((g.inputs ?? {}) as Record<string, string>)[k] ?? '')]);
            const bad = await fillConverge(bpairs, 2);
            console.log(`  bunker -N (last): filled=${bpairs.length - bad.length}/${bpairs.length} bad=[${bad.join(' ')}]`);
          }
          // 7f. Settle-until-stable: attention/balance derive async and
          // read stale after the 7d/7e cascade (r20-4 balance stuck at
          // pre-clear value). Poll until two consecutive identical reads.
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
              if (s === 7) console.log('  attention still settling after 12s');
            }
          }
          if (process.env.REPLAY_DEBUG === '1') {
            const fin: string[] = await page.evaluate(() => {
              const out: string[] = [];
              document.querySelectorAll('input[id^="v-"]').forEach((n) => {
                const e = n as HTMLInputElement;
                if (e.value && (/quantity-|productivity|oefficient|turnTime|extraTime|expDa|emurrage|espatch|Balance|bunker-|tpcTpi|dwt|hsfo|lsmgo|aeScrubber|euEts|ukEts/.test(e.id))) out.push(`${e.id}=${e.value}`);
              });
              return out;
            });
            console.log(`  [final] ${fin.join(' | ').slice(0, 1600)}`);
          }
          await page.keyboard.press('Escape').catch(() => {});
          const nan = await page.getByText('NaN').count().catch(() => 0);

          // 8. Blackbox assertions.
          const seqBtn = ((await page.locator('button[title="Sequence summary"]').first().textContent().catch(() => '')) ?? '').trim().replace(/\s+/g, ' ');
          const want = String(g.seqBtn ?? '').trim().replace(/\s+/g, ' ');
          const att = (await page.locator('li').evaluateAll((els) =>
            els.map((li) => (li.textContent ?? '').trim().replace(/\s+/g, ' ')).filter((s) => /required|must equal|cannot exceed|attention/i.test(s)),
          ).catch(() => [] as string[])).sort();
          const wantAtt = [...((g.attention ?? []) as string[])].sort();
          const missing = wantAtt.filter((a) => !att.includes(a)).slice(0, 2);
          const extra = att.filter((a) => !wantAtt.includes(a)).slice(0, 2);
          let moneyOk = true;
          let moneyNote = '';
          if ((g.attention ?? []).length === 0) {
            for (const oid of OUTPUT_IDS) {
              const cur = await page.locator(`#${oid}`).first().inputValue().catch(() => '');
              const exp = String((g.inputs as Record<string, string>)?.[oid] ?? '');
              if (cur !== exp) {
                moneyOk = false;
                moneyNote += `${oid}: replay=${cur} golden=${exp}; `;
              }
            }
          }
          const sumOk = seqBtn === want;
          const attOk = JSON.stringify(att) === JSON.stringify(wantAtt);
          pass = sumOk && attOk && moneyOk && nan === 0;
          const gi = (g.inputs ?? {}) as Record<string, string>;
          const inputDesc = `vessel=${g.vessel || '(none)'} ports=[${ports.filter(Boolean).join('|')}] qty2=${gi['v-sequence-quantity-2'] ?? '-'} rate=${gi['v-cargo-rate-1'] ?? '-'}`;
          actual = `summary match=${sumOk} attention=${att.length} (golden ${wantAtt.length})${moneyNote ? ' ' + moneyNote : ''}${nan ? ` NaN=${nan}` : ''}`;
          if (!pass) {
            why = [
              !sumOk ? `summary replay=[${seqBtn.slice(0, 100)}] golden=[${want.slice(0, 100)}]` : '',
              !attOk ? `missing=[${missing.join(' | ').slice(0, 160)}] extra=[${extra.join(' | ').slice(0, 160)}]` : '',
              moneyNote,
              nan ? 'NaN rendered' : '',
            ].filter(Boolean).join('; ');
          }
          report.kase(id, `"${g.tab}"`, inputDesc,
            `summary=[${want.slice(0, 90)}] attention=${wantAtt.length}`, actual, pass ? 'PASS' : 'FAIL', why);
        } catch (e) {
          actual = `error: ${String(e).slice(0, 160)}`;
          why = actual;
          report.kase(id, `"${g.tab}"`, 'replay inputs', 'outputs match workbook', actual, 'FAIL', why);
        }
      }
      report.summary();
      expect(report.failed, `${wb.label} failures:\n${report.failures.join('\n')}`).toBe(0);
      expect(appErrors, `pageerrors:\n${appErrors.join('\n')}`).toEqual([]);
    });
  });
}
