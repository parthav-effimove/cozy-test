import { test, expect, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { ensureCalculator, ensureDashboard, skipIfNoCalculator } from './helpers';

/**
 * STRUCTURED SUITE — Unit (field-level) + E2E (real user workflow).
 *
 * Run: npx playwright test tests/suite.spec.ts --project=chromium-headless --workers=1 --reporter=list
 *   GOLDEN_LIMIT=2 caps E2E golden sheets (default 2 for speed; raise for full 19).  *   SUITE_GOLDEN=oct20|19oct|15oct|all selects which golden file(s) to replay (default oct20).
 *
 * Key rule (locked in): an APP rejection of invalid input is a test PASS.
 * A test FAILs only when the app behaves differently from the stated expectation
 * (wrong acceptance, crash, NaN leak, missing validation flag).
 */

type Outcome = 'PASS' | 'FAIL' | 'SKIP';

class SuiteReport {
  total = 0;
  passed = 0;
  failed = 0;
  skipped = 0;
  failures: string[] = [];

  header() {
    console.log('============================================================');
    console.log('             APPLICATION TEST SUITE');
    console.log('============================================================\n');
    console.log('[UNIT TESTS - FIELD VALIDATION]\n');
  }

  e2eHeader() {
    console.log('\n------------------------------------------------------------');
    console.log('[END-TO-END TESTS - USER WORKFLOW]\n');
  }

  // Prints one case in the exact requested shape and tallies it.
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

const report = new SuiteReport();

// Representative numeric fields, one per app area (full 68-field sweep is UT-011).
const SAMPLE_NUMERIC = [
  '#v-vessel-dwt-_',
  '#v-sequence-quantity-2',
  '#v-sequence-distance-2',
  '#v-cargo-rate-1',
  '#v-misc-miscCost-_',
  '#v-bunker-vlsfoPrice-bob',
];

async function noCrash(page: Page, errors: string[]): Promise<{ ok: boolean; detail: string }> {
  const nan = await page.getByText('NaN').count().catch(() => 0);
  if (nan > 0) return { ok: false, detail: `${nan} NaN node(s) rendered` };
  if (errors.length > 0) return { ok: false, detail: errors[errors.length - 1].slice(0, 160) };
  return { ok: true, detail: 'no pageerror, no NaN' };
}

async function fillAndRead(page: Page, selector: string, value: string): Promise<string> {
  const el = page.locator(selector).first();
  await el.fill(value).catch(async () => {
    // input[type=number] throws on letters via fill — emulate a paste instead.
    await el.evaluate((n, v) => {
      const e = n as HTMLInputElement;
      e.focus();
      e.value = v;
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    }, value).catch(() => {});
  });
  await el.evaluate((n) => (n as HTMLElement).blur()).catch(() => {});
  await page.waitForTimeout(250);
  return el.inputValue().catch(() => '');
}

test.describe('Structured suite — unit + E2E with terminal report', () => {
  test('run all cases with detailed report', async ({ page }) => {
    test.setTimeout(1_800_000);
    report.header();
    // Setup that never throws: login-gated → structured SKIP; missing
    // "testing -a" workbook → create a throwaway workbook and open it.
    // (The old code let ensureCalculator's expect() throw, which killed the
    // run before a single case printed.)
    let ready = false;
    let setupNote = '';
    try {
      const visible = await ensureCalculator(page);
      if (!skipIfNoCalculator(visible)) ready = true;
      else setupNote = 'login required, no credentials';
    } catch (e) {
      setupNote = `testing -a not found (${String(e).slice(0, 100)}), creating suite workbook instead`;
      try {
        if (await ensureDashboard(page)) {
          const name = `suite-work-${Date.now() % 100000}`;
          await page.getByRole('button', { name: /new workbook/i }).first().click();
          await expect(page.getByPlaceholder('Workbook name')).toBeVisible({ timeout: 20_000 });
          await page.getByPlaceholder('Workbook name').fill(name);
          await page.getByRole('button', { name: /^create$/i }).click();
          const row = page.locator('tr', { hasText: name }).first();
          await expect(row).toBeVisible({ timeout: 30_000 });
          await row.getByRole('button', { name: /^open$/i }).click();
          await expect(page.getByPlaceholder('Search vessel...').first()).toBeVisible({ timeout: 60_000 });
          ready = true;
          setupNote += ` → opened ${name}`;
        }
      } catch (e2) {
        setupNote += `; fallback failed: ${String(e2).slice(0, 120)}`;
      }
    }
    console.log(`Setup: ${setupNote || 'calculator ready via testing -a'}`);
    if (!ready) {
      report.kase('UT-000', 'Suite setup — calculator reachable', 'open calculator', 'calculator visible', setupNote || 'calculator not reachable', 'SKIP');
      report.e2eHeader();
      report.kase('E2E-000', 'Suite setup — E2E runnable', 'open calculator', 'calculator visible', setupNote || 'calculator not reachable', 'SKIP');
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

    // Fresh sheet so unit probes never touch saved workbooks.
    await page.getByRole('button', { name: /^new sheet$/i }).first().click().catch(() => {});
    await page.waitForTimeout(1500);

    // ---------- UNIT ----------
    // UT-001 valid integers accepted (one field per area).
    {
      const kept: string[] = [];
      for (const sel of SAMPLE_NUMERIC) {
        if ((await page.locator(sel).count()) === 0) continue;
        kept.push(`${sel}=${await fillAndRead(page, sel, '100')}`);
      }
      const ok = kept.length > 0 && kept.every((k) => /100/.test(k));
      const health = await noCrash(page, errors);
      const pass = ok && health.ok;
      report.kase('UT-001', 'Numeric Field - Valid Integer', '100 into vessel/sequence/cargo/misc/bunker fields',
        'Value accepted', `${kept.slice(0, 3).join(', ')}${kept.length > 3 ? ` (+${kept.length - 3} more)` : ''}; ${health.detail}`,
        pass ? 'PASS' : 'FAIL', pass ? '' : 'valid integer was not kept or app errored');
    }

    // UT-002 decimal values accepted.
    {
      const sel = '#v-cargo-rate-1';
      const after = await fillAndRead(page, sel, '28.5');
      const health = await noCrash(page, errors);
      const pass = after.includes('28.5') && health.ok;
      report.kase('UT-002', 'Numeric Field - Decimal Value', '28.5 into cargo rate',
        'Value accepted', `stored=${JSON.stringify(after)}; ${health.detail}`, pass ? 'PASS' : 'FAIL',
        pass ? '' : 'decimal was not stored cleanly');
    }

    // UT-003 alphabetic into numeric — rejection IS a pass.
    {
      const sel = '#v-vessel-dwt-_';
      const before = errors.length;
      const after = await fillAndRead(page, sel, 'abc');
      const invalid = await page.locator(sel).getAttribute('aria-invalid').catch(() => null);
      const health = await noCrash(page, errors.slice(before));
      const rejected = after !== 'abc'; // empty, sanitized, or reverted all count as rejection
      const pass = rejected && health.ok;
      report.kase('UT-003', 'Numeric Field - Alphabetic Input', '"abc" into DWT',
        'Input rejected', `stored=${JSON.stringify(after)} invalid=${invalid}; ${health.detail}`,
        pass ? 'PASS' : 'FAIL', pass ? '' : 'junk kept verbatim or app errored (rejection expected)');
    }

    // UT-004 symbols / grouping handled without crash.
    {
      const results: string[] = [];
      for (const [sel, payload] of [['#v-misc-miscCost-_', '100$'], ['#v-sequence-quantity-2', '1,000']] as const) {
        if ((await page.locator(sel).count()) === 0) continue;
        results.push(`${sel}<=${payload}→${JSON.stringify(await fillAndRead(page, sel, payload))}`);
      }
      const health = await noCrash(page, errors);
      report.kase('UT-004', 'Numeric Field - Symbols / Grouping', '"100$", "1,000"',
        'Sanitized or rejected, no crash', `${results.join('; ')}; ${health.detail}`,
        health.ok ? 'PASS' : 'FAIL', health.ok ? '' : 'app errored on symbol input');
    }

    // UT-005 empty clears the field (app coerces empty numerics to "0" —
    // verified live: clearing cargo rate stores "0". Both '' and '0' are
    // correct handling; anything else, a crash, or NaN is a FAIL).
    {
      const sel = '#v-cargo-rate-1';
      await fillAndRead(page, sel, '45.5');
      const after = await fillAndRead(page, sel, '');
      const health = await noCrash(page, errors);
      const cleared = after === '' || after === '0';
      report.kase('UT-005', 'Numeric Field - Empty Value', 'clear cargo rate',
        'Value cleared (empty or coerced to 0)', `stored=${JSON.stringify(after)}; ${health.detail}`,
        cleared && health.ok ? 'PASS' : 'FAIL', cleared ? '' : `field kept unexpected value ${JSON.stringify(after)}`);
    }

    // UT-006 negative numbers: no crash; acceptance varies by field so either is fine.
    {
      const after = await fillAndRead(page, '#v-misc-miscCost-_', '-100');
      const health = await noCrash(page, errors);
      report.kase('UT-006', 'Numeric Field - Negative Value', '-100 into misc cost',
        "Follow the field's defined validation rules", `stored=${JSON.stringify(after)}; ${health.detail}`,
        health.ok ? 'PASS' : 'FAIL', health.ok ? '' : 'app errored on negative input');
    }

    // UT-007 zero boundary.
    {
      const after = await fillAndRead(page, '#v-sequence-quantity-2', '0');
      const health = await noCrash(page, errors);
      report.kase('UT-007', 'Numeric Field - Zero Boundary', '0 into sequence quantity',
        'Handled without crash', `stored=${JSON.stringify(after)}; ${health.detail}`,
        health.ok ? 'PASS' : 'FAIL', health.ok ? '' : 'app errored on zero');
    }

    // UT-008 huge value boundary.
    {
      const after = await fillAndRead(page, '#v-vessel-dwt-_', '999999999');
      const health = await noCrash(page, errors);
      report.kase('UT-008', 'Numeric Field - Large Boundary', '999999999 into DWT',
        'Handled without crash', `stored=${JSON.stringify(after).slice(0, 30)}; ${health.detail}`,
        health.ok ? 'PASS' : 'FAIL', health.ok ? '' : 'app errored on huge value');
    }

    // UT-009 required field: empty vessel speed flags aria-invalid after save.
    {
      const ballast = page.locator('#v-vessel-matrix_speed_ballast-_');
      const laden = page.locator('#v-vessel-matrix_speed_laden-_');
      let actual = 'selectors missing';
      let pass = false;
      if ((await ballast.count()) > 0 && (await laden.count()) > 0) {
        await ballast.fill('');
        await laden.fill('');
        await page.keyboard.press('Tab').catch(() => {});
        await page.locator('#lovable-badge').evaluateAll((els) => els.forEach((el) => el.remove())).catch(() => {});
        const quick = page.locator('button[class*="bg-white/15"]', { hasText: 'Save Sheet' }).first();
        const saver = (await quick.count()) > 0 ? quick : page.getByRole('button', { name: /^save sheet$/i }).last();
        await saver.click().catch(() => {});
        await page.getByText('Sheet saved').first().waitFor({ timeout: 20_000 }).catch(() => {});
        const flag = await ballast.getAttribute('aria-invalid').catch(() => null);
        actual = `aria-invalid=${flag} after save with empty speeds`;
        pass = flag === 'true';
        await ballast.fill('12').catch(() => {});
        await laden.fill('12.5').catch(() => {});
      }
      report.kase('UT-009', 'Required Field - Vessel Speed', 'clear Eco Ballast/Laden speeds + save',
        'Validation flags speed (aria-invalid=true)', actual, pass ? 'PASS' : 'FAIL',
        pass ? '' : 'required-speed error did not appear');
    }

    // UT-010 selects + checkbox behave.
    {
      const parts: string[] = [];
      let ok = true;
      const scrub = page.locator('text=Scrubbers').locator('..').locator('select').first();
      if ((await scrub.count()) > 0) {
        await scrub.selectOption('Y').catch(() => { ok = false; });
        parts.push(`scrub=Y:${await scrub.inputValue().catch(() => '?')}`);
        await scrub.selectOption('N').catch(() => {});
      }
      const ldi = page.locator('#loadDischIdle').first();
      if ((await ldi.count()) > 0) {
        await ldi.click().catch(() => { ok = false; });
        parts.push(`idle aria-checked=${await ldi.getAttribute('aria-checked').catch(() => '?')}`);
        await ldi.click().catch(() => {});
      } else parts.push('idle toggle absent');
      const health = await noCrash(page, errors);
      report.kase('UT-010', 'Selects + Checkbox', 'cycle scrubber select, toggle idle',
        'Controls accept changes', `${parts.join('; ')}; ${health.detail}`,
        ok && health.ok ? 'PASS' : 'FAIL', ok ? '' : 'select/toggle failed');
    }

    // UT-011 comprehensive sweep: EVERY editable numeric field gets junk; any
    // pageerror / NaN / verbatim junk-keep is a FAIL (rejection is PASS).
    {
      const fields = page.locator('input[id^="v-"]');
      const n = await fields.count();
      let probed = 0;
      const bad: string[] = [];
      const errMark = errors.length;
      for (let i = 0; i < n; i++) {
        const f = fields.nth(i);
        if (!(await f.isVisible().catch(() => false))) continue;
        if (!(await f.isEnabled().catch(() => false))) continue;
        if ((await f.getAttribute('readonly').catch(() => null)) !== null) continue;
        const id = (await f.getAttribute('id').catch(() => '')) || `#${i}`;
        if (/ntc|netBB|grossBB|quantityBalance/i.test(id)) continue; // derived outputs, covered by E2E
        let orig = '';
        try { orig = await f.inputValue({ timeout: 2000 }); } catch { continue; }
        probed++;
        const after = await fillAndRead(page, `#${id}`, 'abc');
        if (after === 'abc') bad.push(`${id} kept junk verbatim`);
        await fillAndRead(page, `#${id}`, orig);
        if (await page.getByText('NaN').count().catch(() => 0)) { bad.push(`${id} rendered NaN`); break; }
      }
      const newErrs = errors.slice(errMark);
      if (newErrs.length) bad.push(newErrs[0]);
      report.kase('UT-011', 'All-Field Hostile Sweep', `"abc" into every editable v-* field (${probed} probed)`,
        'All rejected/sanitized, no crash', probed ? `${probed} fields probed; ${bad.length ? bad.slice(0, 3).join('; ') : 'all rejected cleanly'}` : 'no fields found',
        bad.length === 0 && probed > 0 ? 'PASS' : 'FAIL', bad.length ? bad.slice(0, 3).join('; ') : 'no editable fields probed');
    }

    // UT-012 decimal torture on calc-critical fields.
    {
      const ids = ['#v-cargo-rate-1', '#v-sequence-quantity-2', '#v-sequence-distance-2', '#v-vessel-matrix_speed_laden-_'];
      const payloads = ['2.675', '0.30000000000000004', '12.345678901234567890123456789', '1,000.5'];
      let worst = '';
      let ok = true;
      for (const sel of ids) {
        if ((await page.locator(sel).count()) === 0) continue;
        const orig = await page.locator(sel).inputValue().catch(() => '');
        for (const p of payloads) {
          const after = await fillAndRead(page, sel, p);
          if (await page.getByText('NaN').count().catch(() => 0)) { ok = false; worst = `${sel}<=${p} rendered NaN`; break; }
          if (/nan|infinity/i.test(after)) { ok = false; worst = `${sel}<=${p} stored ${after}`; break; }
        }
        await fillAndRead(page, sel, orig);
        if (!ok) break;
      }
      const health = await noCrash(page, errors);
      report.kase('UT-012', 'Decimal Torture - Calc-Critical Fields', '2.675, 0.1+0.2 artifact, 27dp, grouping+decimal',
        'No NaN/Infinity, values contained', ok && health.ok ? `clean; ${health.detail}` : (worst || health.detail),
        ok && health.ok ? 'PASS' : 'FAIL', ok ? '' : worst);
    }

    // ---------- E2E ----------
    report.e2eHeader();
    const which = process.env.SUITE_GOLDEN ?? 'oct20';
    const files = which === 'all' ? ['golden-oct20.json', 'golden-19oct.json', 'golden-15oct.json'] : which === '19oct' ? ['golden-19oct.json'] : which === '15oct' ? ['golden-15oct.json'] : ['golden-oct20.json'];
    const limit = Number(process.env.GOLDEN_LIMIT ?? 2);
    let e2eIdx = 0;

    for (const file of files) {
      let golden: { workbook: string; sheets: Record<string, any>[] };
      try {
        golden = JSON.parse(await readFile(`goldens/${file}`, 'utf8'));
      } catch {
        report.kase(`E2E-${String(++e2eIdx).padStart(3, '0')}`, `Replay ${file} - golden present`, `read goldens/${file}`,
          'Golden file exists', 'missing — run snapshot first', 'SKIP');
        continue;
      }
      for (const g of golden.sheets.slice(0, limit)) {
        e2eIdx++;
        const id = `E2E-${String(e2eIdx).padStart(3, '0')}`;
        // Minimal but real workflow: fresh sheet, vessel pick, key quantities,
        // cargo rate, then compare the sheet's own computed outputs.
        await page.getByRole('button', { name: /^new sheet$/i }).first().click().catch(() => {});
        await page.waitForTimeout(1200);
        const search = page.getByPlaceholder('Search vessel...').first();
        await expect(search).toBeVisible({ timeout: 30_000 });
        let actual = '';
        let pass = false;
        let why = '';
        try {
          // Real user workflow: vessel pick + port picks + selects + inputs.
          // (First version skipped ports, so port-driven attention items could
          // never match — the 17-vs-15 diff was a replay fidelity bug, not an
          // app miscalculation.)
          const pickFromSearch = async (input: ReturnType<Page['getByPlaceholder']>, name: string, api: string) => {
            const q = name.split(/[\s/,]+/).filter(Boolean)[0] || name;
            for (const query of [q, name]) {
              await page.keyboard.press('Escape').catch(() => {});
              await input.scrollIntoViewIfNeeded().catch(() => {});
              await input.click();
              await input.fill('');
              await input.pressSequentially(query.slice(0, 14), { delay: 150 });
              await page.waitForResponse((r) => r.url().includes(api), { timeout: 20_000 }).catch(() => {});
              await page.waitForTimeout(1300);
              const btn = page.locator('div.absolute.z-50 button, div[class*="z-50"] button, div[class*="bg-popover"] button')
                .filter({ hasText: new RegExp(query.slice(0, 4).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
              if ((await btn.count()) > 0) {
                await btn.click().catch(() => {});
                await page.waitForTimeout(800);
                return;
              }
            }
            // Backend missing the port (stale index) — type the golden name
            // directly so distances/quantities still replay; any ECA-driven
            // output diff surfaces in the assertions below.
            await input.click().catch(() => {});
            await input.fill(name).catch(() => {});
            await input.evaluate((n) => (n as HTMLElement).blur()).catch(() => {});
            await page.waitForTimeout(600);
          };
          if (g.vessel) {
            await pickFromSearch(search, String(g.vessel), '/vessels');
            await page.waitForTimeout(800);
          }
          // Grow legs if the golden sheet has more ports than a fresh sheet.
          const ports: string[] = Array.isArray(g.ports) ? g.ports : [];
          for (let guard = 0; guard < 6 && (await page.getByPlaceholder('Select port...').count()) < ports.length; guard++) {
            await page.getByRole('button', { name: /^add$/i }).first().click().catch(() => {});
            await page.waitForTimeout(1000);
          }
          for (let p = 0; p < ports.length; p++) {
            const input = page.getByPlaceholder('Select port...').nth(p);
            if ((await input.count()) === 0) break;
            await pickFromSearch(input, String(ports[p]), '/ports/search');
          }
          for (const [fid, val] of Object.entries<string>((g.inputs ?? {}) as Record<string, string>)) {
            if (fid === 'v-vessel-dwt-_') continue; // hydrated by vessel pick
            if (/ntc|netBB|grossBB|quantityBalance/i.test(fid)) continue; // outputs, not inputs
            const el = page.locator(`#${fid}`).first();
            if ((await el.count()) === 0) continue;
            if (!(await el.isEnabled().catch(() => false))) continue;
            if ((await el.getAttribute('readonly').catch(() => null)) !== null) continue;
            await el.fill(String(val)).catch(() => {});
          }
          for (const [sid, sval] of Object.entries<string>((g.selects ?? {}) as Record<string, string>)) {
            const el = sid.startsWith('select-') ? page.locator('select').nth(Number(sid.slice(7))) : page.locator(`#${sid}`).first();
            if ((await el.count()) === 0) continue;
            await el.selectOption({ value: String(sval) }).catch(async () => {
              await el.selectOption({ label: String(sval) }).catch(() => {});
            });
            await page.waitForTimeout(250);
          }
          await page.waitForTimeout(2500);
          await page.keyboard.press('Escape').catch(() => {});
          const seqBtn = ((await page.locator('button[title="Sequence summary"]').first().textContent().catch(() => '')) ?? '').trim().replace(/\s+/g, ' ');
          const want = String(g.seqBtn ?? '').trim().replace(/\s+/g, ' ');
          const att = (await page.locator('li').evaluateAll((els) => els.map((li) => (li.textContent ?? '').trim().replace(/\s+/g, ' ')).filter((s) => /required|must equal|cannot exceed|attention/i.test(s))).catch(() => [] as string[])).sort();
          const wantAtt = [...((g.attention ?? []) as string[])].sort();
          const missing = wantAtt.filter((a) => !att.includes(a)).slice(0, 3);
          const extra = att.filter((a) => !wantAtt.includes(a)).slice(0, 3);
          actual = `summary match=${seqBtn === want} attention=${att.length} (golden ${wantAtt.length})`;
          pass = seqBtn === want && JSON.stringify(att) === JSON.stringify(wantAtt);
          if (!pass) why = `replay=[${seqBtn.slice(0, 90)}] golden=[${want.slice(0, 90)}]` + (missing.length ? ` missing=${missing.join(' | ').slice(0, 160)}` : '') + (extra.length ? ` extra=${extra.join(' | ').slice(0, 160)}` : '');
        } catch (e) {
          actual = `error: ${String(e).slice(0, 160)}`;
          why = actual;
        }
        report.kase(id, `Complete Calculation - ${g.tab ?? file}`, `replay ${file} sheet "${g.tab}"`,
          'Output matches the workbook', actual, pass ? 'PASS' : 'FAIL', why);
      }
    }

    // E2E error-scenario: empty form must raise validation (rejection = PASS).
    {
      await page.getByRole('button', { name: /^new sheet$/i }).first().click().catch(() => {});
      await page.waitForTimeout(1200);
      await page.locator('#lovable-badge').evaluateAll((els) => els.forEach((el) => el.remove())).catch(() => {});
      const quick = page.locator('button[class*="bg-white/15"]', { hasText: 'Save Sheet' }).first();
      const saver = (await quick.count()) > 0 ? quick : page.getByRole('button', { name: /^save sheet$/i }).last();
      await saver.click().catch(() => {});
      await page.getByText('Sheet saved').first().waitFor({ timeout: 20_000 }).catch(() => {});
      const flagged = await page.locator('[aria-invalid="true"]').count().catch(() => 0);
      report.kase(`E2E-${String(e2eIdx + 1).padStart(3, '0')}`, 'Error Scenario - Empty Sheet Validation',
        'save an empty sheet', 'App rejects with validation flags', `${flagged} field(s) flagged aria-invalid`,
        flagged > 0 ? 'PASS' : 'FAIL', flagged > 0 ? '' : 'empty sheet saved with no validation flags');
    }

    report.summary();
    expect(report.failed, `suite failures:\n${report.failures.join('\n')}`).toBe(0);
  });
});
