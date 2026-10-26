import { test, expect, Page } from '@playwright/test';
import { ensureCalculator, skipIfNoCalculator, SEEDS } from './helpers';

/**
 * FUNCTIONAL SUITE — FT-001..FT-013, mapped 1:1 to
 * "Nearterm Plan_Functional Test Cases.csv" (Time & Routing, Port ops,
 * Fuel & bunkers, Costs & finance, Emissions & regulatory).
 *
 * Run: npx playwright test tests/functional.spec.ts --project=chromium-headless --workers=1 --reporter=list
 *
 * Method: build ONE complete 4-port voyage, then mutate one factor per case
 * and assert the formula relationship on observable UI outputs (sequence
 * summary Sea/Port/Total, expanded voyage summary panel, money fields).
 * A case reports SKIP (not FAIL) when the value it needs is not exposed in
 * the UI — the report names the missing value so it can be instrumented.
 * App rejections of invalid setups are PASS, per the suite contract.
 */

type Outcome = 'PASS' | 'FAIL' | 'SKIP';

class FTReport {
  total = 0;
  passed = 0;
  failed = 0;
  skipped = 0;
  failures: string[] = [];

  header() {
    console.log('============================================================');
    console.log('             FUNCTIONAL TEST SUITE');
    console.log('============================================================\n');
    console.log('[FUNCTIONAL TESTS - FORMULA VERIFICATION]\n');
  }

  kase(id: string, title: string, input: string, expected: string, actual: string, result: Outcome, why = '') {
    this.total++;
    if (result === 'PASS') this.passed++;
    else if (result === 'FAIL') {
      this.failed++;
      this.failures.push(`${id} ${title}: ${why || actual}`);
    } else this.skipped++;
    console.log(`[${id}] ${title}`);
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
    console.log('                    TEST SUMMARY');
    console.log('============================================================');
    console.log(`Total Tests : ${this.total}`);
    console.log(`Passed      : ${this.passed}`);
    console.log(`Failed      : ${this.failed}`);
    console.log(`Skipped     : ${this.skipped}`);
    console.log(`Success Rate: ${rate}%`);
    console.log('============================================================');
    if (this.failures.length) {
      console.log('Failures:');
      for (const f of this.failures) console.log(`  - ${f}`);
    }
  }
}

const report = new FTReport();
const close = (a: number, b: number, tol = 0.02) => Math.abs(a - b) <= tol;

/** Parse "Sea: 46.29dPort: 0.00dTotal: 46.29d" into numbers. */
async function seqDays(page: Page): Promise<{ sea: number; port: number; total: number; raw: string }> {
  const raw = ((await page.locator('button[title="Sequence summary"]').first().textContent().catch(() => '')) ?? '').trim().replace(/\s+/g, '');
  const m = raw.match(/Sea:([\d.]+)dPort:([\d.]+)dTotal:([\d.]+)d/);
  return { sea: Number(m?.[1] ?? NaN), port: Number(m?.[2] ?? NaN), total: Number(m?.[3] ?? NaN), raw };
}

let lastPanel = '';
/** Expand the voyage summary panel (when present) and return body text. */
async function panelText(page: Page): Promise<string> {
  const expand = page.getByRole('button', { name: /expand summary/i }).first();
  if ((await expand.count()) > 0) {
    await expand.click().catch(() => {});
    await page.waitForTimeout(1500);
  }
  lastPanel = (((await page.locator('body').textContent().catch(() => '')) ?? '').replace(/\s+/g, ' '));
  return lastPanel;
}
/** First 800 chars from the voyage-summary region — printed on SKIP so label patterns can be tightened. */
function panelExcerpt(): string {
  const m = lastPanel.search(/voyage summary/i);
  const at = m >= 0 ? m : Math.max(0, lastPanel.search(/summary/i));
  return lastPanel.slice(at, at + 800);
}

/** First number after any of the given labels, e.g. findNum(t, ['TCE', 'tce\\/day']). */
function numAfter(text: string, re: RegExp): number | null {
  const m = text.match(re);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}
function findNum(text: string, labels: string[]): number | null {
  for (const l of labels) {
    const m = text.match(new RegExp(`${l}[^0-9\\-]{0,20}(-?[\\d,]+\\.\\d+|-?[\\d,]+)`, 'i'));
    if (m) return Number(m[1].replace(/,/g, ''));
  }
  return null;
}

async function pickFromSearch(page: Page, index: number, name: string): Promise<void> {
  const input = page.getByPlaceholder('Select port...').nth(index);
  if ((await input.count()) === 0) return;
  const q = name.split(/[\s/,]+/).filter(Boolean)[0] || name;
  await page.keyboard.press('Escape').catch(() => {});
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click();
  await input.fill('');
  await input.pressSequentially(q.slice(0, 14), { delay: 150 });
  await page.waitForResponse((r) => r.url().includes('/ports/search'), { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1300);
  const btn = page.locator('div.absolute.z-50 button, div[class*="z-50"] button, div[class*="bg-popover"] button')
    .filter({ hasText: new RegExp(q.slice(0, 4).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
  if ((await btn.count()) > 0) {
    await btn.click().catch(() => {});
  } else {
    await input.fill(name).catch(() => {});
    await input.evaluate((n) => (n as HTMLElement).blur()).catch(() => {});
  }
  await page.waitForTimeout(700);
}

async function set(page: Page, id: string, value: string): Promise<void> {
  const el = page.locator(`#${id}`).first();
  if ((await el.count()) === 0) return;
  if (!(await el.isEnabled().catch(() => false))) return;
  if ((await el.getAttribute('readonly').catch(() => null)) !== null) return;
  await el.fill(value).catch(() => {});
}

test.describe('Functional — formula verification FT-001..FT-013', () => {
  test('run all functional cases with detailed report', async ({ page }) => {
    test.setTimeout(1_800_000);
    report.header();
    let visible = false;
    try {
      visible = await ensureCalculator(page);
    } catch {
      visible = false;
    }
    if (skipIfNoCalculator(visible)) {
      report.kase('FT-000', 'Setup — calculator reachable', 'open calculator', 'calculator visible', 'not reachable', 'SKIP');
      report.summary();
      test.skip(true);
    }

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 160)}`));
    page.on('console', (m) => {
      if (m.type() === 'error') {
        const t = m.text().slice(0, 160);
        if (!/favicon|net::|404/i.test(t)) errors.push(`console: ${t}`);
      }
    });
    const noCrash = async () => {
      const nan = await page.getByText('NaN').count().catch(() => 0);
      return nan === 0 && errors.length === 0;
    };

    // ---- One complete 4-port voyage for all cases ----
    await page.getByRole('button', { name: /^new sheet$/i }).first().click().catch(() => {});
    await page.waitForTimeout(1500);
    const search = page.getByPlaceholder('Search vessel...').first();
    await expect(search).toBeVisible({ timeout: 30_000 });
    await search.click();
    await search.fill('');
    await search.pressSequentially(SEEDS.vessel, { delay: 200 });
    await page.waitForResponse((r) => r.url().includes('/vessels'), { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await page.locator('div.absolute.z-50 button, div[class*="z-50"] button').filter({ hasText: new RegExp(SEEDS.vessel, 'i') }).first().click().catch(() => {});
    await page.waitForTimeout(1500);
    for (let g = 0; g < 3 && (await page.getByPlaceholder('Select port...').count()) < 4; g++) {
      await page.getByRole('button', { name: /^add$/i }).first().click().catch(() => {});
      await page.waitForTimeout(1000);
    }
    const portNames = ['Singapore', 'Tubarao', 'Qingdao', 'Santos'];
    for (let p = 0; p < 4; p++) await pickFromSearch(page, p, portNames[p]);
    // Speeds + FULL consumption matrix (vlsfo/lsmgo/ae × all aspects).
    await set(page, 'v-vessel-matrix_speed_ballast-_', '12');
    await set(page, 'v-vessel-matrix_speed_laden-_', '12.5');
    for (const f of ['vlsfo', 'lsmgo', 'ae']) {
      for (const m of ['ballast', 'laden', 'load', 'discharge', 'idle']) {
        await set(page, `v-vessel-matrix_${f}_${m}-_`, f === 'vlsfo' ? '24' : f === 'lsmgo' ? '2' : '3');
      }
    }
    // Leg types: added legs default to LOAD, so set explicitly —
    // leg2=load, legs 3,4=discharge. Triggers are custom dropdowns
    // (button.form-select-sm showing load/disch) in leg order. Keyboard
    // fallback (Enter/Down/Enter) covers menus without option roles.
    // Escape afterwards: an open menu otherwise swallows later fills.
    {
      const want = ['load', 'disch', 'disch'];
      for (let i = 0; i < want.length; i++) {
        const triggers = page.locator('button.form-select-sm').filter({ hasText: /^(load|disch)$/i });
        if ((await triggers.count()) <= i) break;
        const cur = ((await triggers.nth(i).textContent()) ?? '').trim().toLowerCase();
        if (cur === want[i]) continue;
        await triggers.nth(i).click().catch(() => {});
        await page.waitForTimeout(600);
        // Menu options are abbreviated (Load/Disch/Bkrg/Pssg) in a fixed
        // portal — the trigger itself carries .form-select-sm, the menu
        // option does not. DOM click bypasses hit-target flakiness.
        const found: string = await page.evaluate((label) => {
          const inFixed = (e: HTMLElement): boolean => {
            let n: HTMLElement | null = e;
            while (n) {
              const s = window.getComputedStyle(n);
              if (s.position === 'fixed') return true;
              n = n.parentElement;
            }
            return false;
          };
          const ctx = (e: HTMLElement): string =>
            (e.parentElement?.parentElement?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
          const matches = Array.from(document.querySelectorAll('*')).filter((e) => {
            if (!(e instanceof HTMLElement)) return false;
            if (e.classList.contains('form-select-sm')) return false;
            if (e.children.length > 0) return false;
            return (e.textContent ?? '').trim().toLowerCase() === label;
          }) as HTMLElement[];
          const vis = matches.filter((e) => e.getClientRects().length > 0);
          const menu = vis.find((e) => inFixed(e)) ?? vis[0];
          if (menu) {
            ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((t) =>
              menu.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })),
            );
            return `total=${matches.length} vis=${vis.length} ctx=${ctx(menu)}`;
          }
          return `none (saw: ${vis.map((e) => ctx(e)).join(' | ').slice(0, 120)})`;
        }, want[i]).catch(() => 'error');
        console.log(`leg${i + 2} menu option '${want[i]}' found=${found}`);
        await page.waitForTimeout(800);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
        const now = ((await triggers.nth(i).textContent()) ?? '').trim().toLowerCase();
        console.log(`leg${i + 2} type: ${cur} → ${now} (want ${want[i]})`);
      }
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
      const now: string[] = await page.locator('button.form-select-sm').filter({ hasText: /^(load|disch)$/i })
        .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim().toLowerCase())).catch(() => []);
      console.log(`leg types now: ${now.join(',')}`);
    }
    // Load 30k, discharge 15k + 15k (reconciled), distances + rates/costs.
    await set(page, 'v-sequence-quantity-2', '30000');
    await set(page, 'v-sequence-productivity-2', '15000');
    await set(page, 'v-sequence-turnTime-2', '12');
    await set(page, 'v-sequence-quantity-3', '15000');
    await set(page, 'v-sequence-productivity-3', '12000');
    await set(page, 'v-sequence-quantity-4', '15000');
    await set(page, 'v-sequence-productivity-4', '10000');
    await set(page, 'v-sequence-distance-2', '5000');
    await set(page, 'v-sequence-distance-3', '6000');
    await set(page, 'v-sequence-distance-4', '7000');
    await set(page, 'v-cargo-rate-1', '28.5');
    await set(page, 'v-bunker-vlsfoPrice-bob', '600');
    await set(page, 'v-bunker-lsmgoPrice-bob', '780');
    await set(page, 'v-bunker-bobQuantity-vlsfo', '200');
    await set(page, 'v-bunker-bobQuantity-lsmgo', '50');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(3000);
    // Verify fills stuck — a silent miss here makes every FT vacuous.
    {
      const expect: Record<string, string> = {
        'v-sequence-quantity-2': '30000', 'v-sequence-productivity-2': '15000',
        'v-sequence-quantity-3': '15000', 'v-sequence-productivity-3': '12000',
        'v-sequence-quantity-4': '15000', 'v-sequence-productivity-4': '10000',
        'v-sequence-distance-2': '5000', 'v-sequence-distance-3': '6000', 'v-sequence-distance-4': '7000',
      };
      for (const [id, want] of Object.entries(expect)) {
        const got = await page.locator(`#${id}`).first().inputValue().catch(() => '(absent)');
        if (got !== want) console.log(`FILL MISS ${id}: want=${want} got=${JSON.stringify(got)}`);
      }
    }
    {
      const base = await page.locator('li').evaluateAll((els) => els.map((li) => (li.textContent ?? '').trim().replace(/\s+/g, ' '))).catch(() => []);
      console.log(`setup baseline: ${base.length} attention items`);
      for (const a of base.slice(0, 8)) console.log(` base-att: ${a.slice(0, 120)}`);
    }

    // ================= TIME & ROUTING =================
    // FT-001 single-leg identity.
    {
      const d = await seqDays(page);
      const pass = !Number.isNaN(d.total) && close(d.total, d.sea + d.port);
      report.kase('FT-001', 'Time & Routing - Single-Leg Total', 'read Sea/Port/Total from sequence summary',
        'Total = Sea + Port', `${d.raw} → ${d.sea}+${d.port}=${(d.sea + d.port).toFixed(2)} vs Total ${d.total}`,
        pass && (await noCrash()) ? 'PASS' : 'FAIL', pass ? '' : 'identity Total=Sea+Port does not hold');
    }

    // FT-002 multi-leg alternating load/discharge.
    {
      await set(page, 'v-sequence-quantity-4', '10000');
      await set(page, 'v-sequence-quantity-3', '20000'); // still reconciles: 20k+10k=30k
      await page.waitForTimeout(2000);
      const bal = await page.locator('#v-cargo-quantityBalance-1').first().inputValue().catch(() => '(absent)');
      const att = await page.locator('li').evaluateAll((els) => els.map((li) => (li.textContent ?? '').trim()).filter((s) => /must equal|cannot exceed|quantity/i.test(s)).length).catch(() => -1);
      const d = await seqDays(page);
      const pass = att === 0 && !Number.isNaN(d.total) && d.total > 0;
      report.kase('FT-002', 'Time & Routing - Multi-Leg Sequence', '4-port alternating load/discharge, reconciled quantities',
        'cargo reconciles, laden/ballast legs produce Total>0', `balance=${JSON.stringify(bal).slice(0, 60)} qty-attention=${att} ${d.raw}`,
        pass && (await noCrash()) ? 'PASS' : 'FAIL', pass ? '' : 'multi-leg quantities do not reconcile');
      await set(page, 'v-sequence-quantity-3', '15000'); // restore 15k/15k
      await set(page, 'v-sequence-quantity-4', '15000');
      await page.waitForTimeout(1500);
    }

    // FT-003 extra time (hours) + sea margin add to voyage days.
    // Turn/extra times are hours (default turnTime 18 = 18h), so 24h → +1d.
    {
      const before = await seqDays(page);
      await set(page, 'v-sequence-extraTime-2', '24');
      await page.waitForTimeout(2000);
      const afterExtra = await seqDays(page);
      const dExtra = afterExtra.total - before.total;
      await set(page, 'v-sequence-extraTime-2', '0');
      await set(page, 'v-sequence-seaMargin-2', '10');
      await page.waitForTimeout(2000);
      const afterMargin = await seqDays(page);
      const dMargin = afterMargin.total - before.total;
      await set(page, 'v-sequence-seaMargin-2', '0');
      await page.waitForTimeout(1500);
      // Sea margin is a PERCENT of the leg's sea time (observed 10 → +1.74d
      // on a 17.36d leg). Read leg2's sailing days from the timeline.
      const tl = await panelText(page);
      const leg2sea = Number((tl.match(/(\d+\.\d+)d sailing/) ?? [])[1] ?? NaN);
      const passExtra = !Number.isNaN(dExtra) && close(dExtra, 1, 0.15);
      const passMargin = !Number.isNaN(dMargin) && !Number.isNaN(leg2sea) && close(dMargin, 0.1 * leg2sea, 0.12);
      report.kase('FT-003', 'Time & Routing - Sea Margin & Extra Time', 'extraTime 24h then seaMargin 10 on leg 2',
        'Total +~1d for 24h; margin increases total', `extra delta=${dExtra.toFixed(2)}d margin delta=${dMargin.toFixed(2)}d`,
        passExtra && passMargin && (await noCrash()) ? 'PASS' : 'FAIL',
        !passExtra ? 'extra 24h did not add ~1d' : !passMargin ? 'sea margin had no positive effect' : '');
    }

    // ================= PORT OPS & LOAD LOGIC =================
    // FT-004 quantities reconcile to zero.
    {
      await set(page, 'v-sequence-quantity-3', '14000'); // break: 14k+15k=29k vs 30k load
      await page.waitForTimeout(2000);
      const attBroken = await page.locator('li').evaluateAll((els) => els.map((li) => (li.textContent ?? '').trim()).filter((s) => /must equal|cannot exceed|quantity/i.test(s)).length).catch(() => -1);
      await set(page, 'v-sequence-quantity-3', '15000'); // restore
      await page.waitForTimeout(2000);
      const attFixed = await page.locator('li').evaluateAll((els) => els.map((li) => (li.textContent ?? '').trim()).filter((s) => /must equal|cannot exceed|quantity/i.test(s)).length).catch(() => -1);
      const pass = attBroken > 0 && attFixed === 0;
      report.kase('FT-004', 'Port Ops - Loading/Discharging Quantities', 'break reconciliation (29k vs 30k) then restore',
        'app flags mismatch, clears when reconciled', `broken-attention=${attBroken} fixed-attention=${attFixed}`,
        pass && (await noCrash()) ? 'PASS' : 'FAIL', pass ? '' : 'reconciliation flag did not follow quantities');
    }

    // FT-005 slow vs fast load rate changes port days.
    {
      await set(page, 'v-sequence-productivity-2', '5000'); // slow
      await page.waitForTimeout(2000);
      const slow = await seqDays(page);
      await set(page, 'v-sequence-productivity-2', '30000'); // fast
      await page.waitForTimeout(2000);
      const fast = await seqDays(page);
      const pass = !Number.isNaN(slow.port) && !Number.isNaN(fast.port) && fast.port < slow.port;
      report.kase('FT-005', 'Port Ops - Load Rate Variation', 'same ports, productivity 5k vs 30k MT/day',
        'faster rate → fewer Port days', `slow Port=${slow.port}d fast Port=${fast.port}d`,
        pass && (await noCrash()) ? 'PASS' : 'FAIL', pass ? '' : 'port days did not respond to load rate');
      await set(page, 'v-sequence-productivity-2', '15000');
      await page.waitForTimeout(1500);
    }

    // ================= FUEL & BUNKERS =================
    // FT-006 scrubber vs no-scrubber fuel rule.
    {
      const scrub = page.locator('text=Scrubbers').locator('..').locator('select').first();
      if ((await scrub.count()) === 0) {
        report.kase('FT-006', 'Fuel - Scrubber vs No-Scrubber', 'toggle scrubber select', 'fuel rule observable', 'no scrubber control in UI', 'SKIP');
      } else {
        const before = (await panelText(page)).slice(0, 2000);
        await scrub.selectOption('Y').catch(() => {});
        await page.waitForTimeout(2000);
        const afterY = await panelText(page);
        await scrub.selectOption('N').catch(() => {});
        await page.waitForTimeout(2000);
        const changed = afterY !== before;
        const hsfoMention = /hsfo/i.test(afterY);
        report.kase('FT-006', 'Fuel - Scrubber vs No-Scrubber', 'scrubber N → Y → N',
          'Non-ECA sea fuel HSFO with scrubber, VLSFO otherwise', `panel changed=${changed} HSFO mentioned when Y=${hsfoMention}`,
          changed && (await noCrash()) ? 'PASS' : 'FAIL', changed ? '' : 'scrubber toggle had no observable effect');
      }
    }

    // FT-007 AE + LSMGO aggregation over ECA/non-ECA.
    {
      await set(page, 'v-sequence-ecaDistance-2', '500');
      await page.waitForTimeout(2000);
      const t = await panelText(page);
      const eca = /eca/i.test(t);
      const d = await seqDays(page);
      await set(page, 'v-sequence-ecaDistance-2', '0');
      await page.waitForTimeout(1500);
      report.kase('FT-007', 'Fuel - AE & LSMGO Aggregation', 'set leg ECA distance=500nm',
        'ECA segmentation reflected in outputs', `ECA mentioned=${eca} ${d.raw}`,
        eca && (await noCrash()) ? 'PASS' : 'FAIL', eca ? '' : 'no ECA output observable in UI');
    }

    // ================= COSTS & FINANCE =================
    // FT-008 bunker cost = Σ(voyage consumption × price). BOB qty/price are
    // top-up inputs — the costed consumption is the panel's Total fuel tonnes.
    {
      await set(page, 'v-bunker-vlsfoPrice-bob', '600');
      await set(page, 'v-bunker-lsmgoPrice-bob', '780');
      await page.waitForTimeout(2000);
      const t = await panelText(page);
      const cost = numAfter(t, /Bunker Cost\$\s*(-?[\d,]+\.\d+)/);
      const vlsfo = numAfter(t, /Total VLSFO\s*([\d,]+\.\d+)\s*t/);
      const lsmgo = numAfter(t, /Total LSMGO\s*([\d,]+\.\d+)\s*t/);
      const pv = Number(await page.locator('#v-bunker-vlsfoPrice-bob').first().inputValue().catch(() => '0')) || 0;
      const pl = Number(await page.locator('#v-bunker-lsmgoPrice-bob').first().inputValue().catch(() => '0')) || 0;
      if (cost === null || vlsfo === null || lsmgo === null) {
        report.kase('FT-008', 'Costs - Bunker Cost Calc', 'consumption × price per fuel', 'panel fuel/cost present', `missing cost=${cost} vlsfo=${vlsfo} lsmgo=${lsmgo}`, 'SKIP');
      } else {
        const expected = vlsfo * pv + lsmgo * pl;
        const pass = close(cost, expected, Math.max(5, expected * 0.01));
        report.kase('FT-008', 'Costs - Bunker Cost Calc', `VLSFO ${vlsfo}t×${pv} + LSMGO ${lsmgo}t×${pl}`, `≈ ${expected.toFixed(2)}`, `Bunker Cost=${cost}`,
          pass && (await noCrash()) ? 'PASS' : 'FAIL', pass ? '' : `panel ${cost} ≠ Σ(cons×price) ${expected.toFixed(2)}`);
      }
    }

    // FT-009 commissions: Net Frt = Gross Frt × (1 − voyageCommission).
    // Hire panel consistency: Incl Hire ≥ Excl Hire ≥ 0.
    {
      const t = await panelText(page);
      const gross = numAfter(t, /Gross Frt\$\s*(-?[\d,]+\.\d+)/);
      const net = numAfter(t, /Net Frt\$\s*(-?[\d,]+\.\d+)/);
      const incl = numAfter(t, /Incl Hire\$\s*(-?[\d,]+\.\d+)/);
      const excl = numAfter(t, /Excl Hire\$\s*(-?[\d,]+\.\d+)/);
      const vc = Number(await page.locator('#v-cargo-voyageCommission-1').first().inputValue().catch(() => '')) || 0;
      if (gross === null || net === null) {
        report.kase('FT-009', 'Costs - Hire and Commissions', 'read Net/Gross Frt', 'freight values present', `gross=${gross} net=${net}`, 'SKIP');
      } else {
        const expNet = gross * (1 - vc / 100);
        const passF = close(net, expNet, Math.max(1, Math.abs(expNet) * 0.005));
        const passH = incl !== null && excl !== null && incl >= excl && excl >= 0;
        report.kase('FT-009', 'Costs - Hire and Commissions', `Gross ${gross} commission ${vc}%`, `Net ≈ ${expNet.toFixed(2)}, Incl ≥ Excl`, `Net=${net} Incl=${incl} Excl=${excl}`,
          passF && passH && (await noCrash()) ? 'PASS' : 'FAIL',
          !passF ? `Net ${net} ≠ Gross×(1−${vc}%) ${expNet.toFixed(2)}` : !passH ? 'hire Incl/Excl inconsistent' : '');
      }
    }

    // FT-010 profit & TCE: NTCE = P&L / Total Time, P&L/d = NTCE.
    {
      const t = await panelText(page);
      const ntce = numAfter(t, /NTCE\$\s*(-?[\d,]+\.\d+)/);
      const pnl = numAfter(t, /P&L\$\s*(-?[\d,]+\.\d+)/);
      const days = numAfter(t, /Total Time\s*(-?[\d,]+\.\d+)\s*d/);
      if (ntce === null || pnl === null || days === null) {
        report.kase('FT-010', 'Costs - Profit & TCE', 'freight 30,000MT × 28.5', 'NTCE/P&L/Time present', `ntce=${ntce} pnl=${pnl} days=${days}`, 'SKIP');
      } else {
        const pass = close(ntce, pnl / days, 0.5);
        report.kase('FT-010', 'Costs - Profit & TCE', `P&L ${pnl} / ${days}d`, `NTCE ≈ ${(pnl / days).toFixed(2)}`, `NTCE=${ntce}`,
          pass && (await noCrash()) ? 'PASS' : 'FAIL', pass ? '' : `NTCE ${ntce} ≠ P&L/Time ${(pnl / days).toFixed(2)}`);
      }
    }

    // ================= EMISSIONS & REGULATORY =================
    // FT-011 CO2 by fuel = consumption × factors (HFO 3.114, MGO 3.206).
    {
      const t = await panelText(page);
      const co2 = numAfter(t, /Total CO₂\s*([\d,]+\.\d+)\s*t/);
      const vlsfo = numAfter(t, /Total VLSFO\s*([\d,]+\.\d+)\s*t/);
      const lsmgo = numAfter(t, /Total LSMGO\s*([\d,]+\.\d+)\s*t/);
      const hsfo = numAfter(t, /Total HSFO\s*([\d,]+\.\d+)\s*t/) ?? 0;
      if (co2 === null || vlsfo === null || lsmgo === null) {
        report.kase('FT-011', 'Emissions - CO2 by Fuel', 'consumption × factors', 'CO2/fuel values present', `co2=${co2} vlsfo=${vlsfo} lsmgo=${lsmgo}`, 'SKIP');
      } else {
        const expected = (hsfo + vlsfo) * 3.114 + lsmgo * 3.206;
        const pass = close(co2, expected, expected * 0.05);
        report.kase('FT-011', 'Emissions - CO2 by Fuel', `(${(hsfo + vlsfo).toFixed(1)}×3.114 + ${lsmgo.toFixed(1)}×3.206)`, `≈ ${expected.toFixed(1)}t`, `Total CO₂=${co2}t`,
          pass && (await noCrash()) ? 'PASS' : 'FAIL', pass ? '' : `Total CO₂ ${co2} ≠ Σ(fuel×factor) ${expected.toFixed(1)}`);
      }
    }

    // FT-012 ECA vs non-ECA segmentation: ECA distance meters SEPARATE ECA
    // fuel (LSMGO rises with ECA miles, VLSFO untouched — observed 800nm →
    // +13.89t LSMGO, VLSFO flat). Dose-response (0/400/800nm) proves metering.
    {
      const readMix = async () => {
        const t = await panelText(page);
        return {
          v: numAfter(t, /Total VLSFO\s*([\d,]+\.\d+)\s*t/),
          l: numAfter(t, /Total LSMGO\s*([\d,]+\.\d+)\s*t/),
        };
      };
      const b = await readMix();
      await set(page, 'v-sequence-ecaDistance-2', '400');
      await page.waitForTimeout(2200);
      const m = await readMix();
      await set(page, 'v-sequence-ecaDistance-2', '800');
      await page.waitForTimeout(2200);
      const a = await readMix();
      await set(page, 'v-sequence-ecaDistance-2', '0');
      await page.waitForTimeout(1500);
      if (b.v === null || b.l === null || m.l === null || a.l === null || a.v === null) {
        report.kase('FT-012', 'Emissions - ECA vs Non-ECA Split', 'ECA 0/400/800nm', 'fuel mix readable', `V=${b.v}/${m.v}/${a.v} L=${b.l}/${m.l}/${a.l}`, 'SKIP');
      } else {
        const mono = a.l > m.l && m.l > b.l;
        const vFlat = close(a.v, b.v, 1) && close(m.v, b.v, 1);
        const lin = close(m.l - b.l, (a.l - b.l) / 2, Math.max(1, (a.l - b.l) * 0.4));
        report.kase('FT-012', 'Emissions - ECA vs Non-ECA Split', 'ECA 0/400/800nm on leg 2', 'LSMGO rises linearly, VLSFO flat',
          `LSMGO ${b.l}→${m.l}→${a.l}t VLSFO ${b.v}→${a.v}t`,
          mono && vFlat && lin && (await noCrash()) ? 'PASS' : 'FAIL',
          !mono ? 'LSMGO not monotonic in ECA distance' : !vFlat ? 'VLSFO moved with ECA distance' : 'ECA fuel not proportional to distance');
      }
    }

    // FT-013 ETS cost: Total CO₂ Cost = Total CO₂ × EU ETS price
    // (observed 5666.95 × 95 = 538,360.37).
    {
      await set(page, 'v-bunker-euEtsPrice-_', '95');
      await page.waitForTimeout(2000);
      const t = await panelText(page);
      const cost = numAfter(t, /Total CO₂ Cost\$\s*(-?[\d,]+\.\d+)/);
      const total = numAfter(t, /Total CO₂\s*([\d,]+\.\d+)\s*t/);
      const price = Number(await page.locator('#v-bunker-euEtsPrice-_').first().inputValue().catch(() => '0')) || 0;
      if (cost === null || total === null) {
        report.kase('FT-013', 'Emissions - ETS Chargeable CO2', 'EU ETS price=95', 'CO2 cost values present', `cost=${cost} total=${total}`, 'SKIP');
      } else {
        const pass = close(cost, total * price, Math.max(5, total * price * 0.01));
        report.kase('FT-013', 'Emissions - ETS Chargeable CO2', `Total ${total}t × $${price}`, `≈ ${(total * price).toFixed(2)}`, `Total CO₂ Cost=${cost}`,
          pass && (await noCrash()) ? 'PASS' : 'FAIL', pass ? '' : `cost ${cost} ≠ total×price ${(total * price).toFixed(2)}`);
      }
    }

    report.summary();
    expect(report.failed, `functional failures:\n${report.failures.join('\n')}`).toBe(0);
  });
});
