import { Page, Locator, expect } from '@playwright/test';

/** Payloads for numeric-ish inputs: letters, symbols, grouping, spaces, empty. */
export const NUMERIC_PAYLOADS = [
  'abc',
  '100$',
  '1,000',
  '   ',
  '',
  '-12',
  '12.5.3',
  '1e5',
];

/** Payloads for free-text search inputs. */
export const TEXT_PAYLOADS = ['zzz###', '   ', ''];

/** Decimal torture payloads: infinite/over-precision decimals, float traps,
 *  locale commas, dot variants, extremes of double precision. */
export const DECIMAL_PAYLOADS = [
  '12.345678901234567890123456789', // 27dp — over-precision
  '3.141592653589793238462643383279', // pi, 30dp
  '2.675', // classic binary-float rounding trap (toFixed(2) → 2.67)
  '0.30000000000000004', // 0.1+0.2 artifact
  '0.1',
  '0.000000001', // tiny
  '1.0000000000000001', // 1 + 1ulp
  '.5', // leading-dot
  '5.', // trailing-dot
  '00.50', // leading zeros
  '12,5', // comma decimal (locale)
  '1,000.5', // grouping + decimal
  '1 000.5', // space grouping
  '-0.001', // negative decimal
  '1e-7', // exponent tiny
  '999999999999.99', // huge with decimals
  '9007199254740993', // 2^53+1 — beyond safe integer
  '1.7976931348623157e308', // near max double
  '5e-324', // min subnormal
  '123.', // trailing dot integer
  '   12.5   ', // padded decimal
  '', // empty (clear + recalc)
];

export type FuzzRecord = {
  field: string;
  payload: string;
  valueAfter: string;
  invalid: string | null;
  note: string;
};

export type FuzzResult = {
  area: string;
  fields: number;
  records: FuzzRecord[];
  criticals: string[];
  warnings: string[];
};

const isBadValue = (v: string) =>
  /nan/i.test(v) ||
  /infinity/i.test(v) ||
  v === 'null' ||
  v === 'undefined';

/** Collect page errors + console errors, tagged with the field under test. */
export function attachErrorCollectors(page: Page) {
  const errors: string[] = [];
  let current = '(setup)';
  page.on('pageerror', (e) => errors.push(`[${current}] pageerror: ${String(e).slice(0, 200)}`));
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const t = m.text().slice(0, 200);
      if (!/favicon|net::|404/i.test(t)) errors.push(`[${current}] console: ${t}`);
    }
  });
  return {
    errors,
    setCurrent: (c: string) => {
      current = c;
    },
  };
}

async function describeField(field: Locator): Promise<{ id: string; kind: string; type: string }> {
  const [id, type, inputmode, placeholder] = await Promise.all([
    field.getAttribute('id'),
    field.getAttribute('type'),
    field.getAttribute('inputmode'),
    field.getAttribute('placeholder'),
  ]);
  const label = id || `[${type ?? 'text'} placeholder="${placeholder ?? ''}"]`;
  const isSearch = /search|select port/i.test(placeholder ?? '');
  const kind = isSearch ? 'search' : type === 'number' ? 'number' : 'text';
  void inputmode;
  return { id: label, kind, type: type ?? '' };
}

export async function applyPayload(field: Locator, payload: string, kind: string): Promise<string> {
  try {
    await field.fill(payload, { timeout: 5000 });
  } catch {
    // input[type=number] rejects letters via fill — set + dispatch like a
    // paste, then let the app's own handlers run.
    await field.evaluate((node, v) => {
      const el = node as HTMLInputElement;
      el.focus();
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, payload);
  }
  await field.evaluate((node) => (node as HTMLElement).blur()).catch(() => {});
  await field.page().keyboard.press('Tab').catch(() => {});
  await field.page().waitForTimeout(250);
  return field.inputValue().catch(() => '');
}

/**
 * Sweep every visible, enabled input in `scope` with hostile payloads,
 * restoring the original value after each one. Returns anomaly records.
 * `sampleSetup` runs first so fields are fuzzed on a populated sheet.
 */
export async function sweepInputs(
  page: Page,
  area: string,
  scope: Locator,
  setCurrent: (c: string) => void,
  errors: string[],
  opts: { skip?: RegExp[] } = {},
): Promise<FuzzResult> {
  const records: FuzzRecord[] = [];
  const criticals: string[] = [];
  const warnings: string[] = [];
  const fields = scope.locator('input, textarea');
  const count = await fields.count();
  let tested = 0;

  for (let i = 0; i < count; i++) {
    const field = fields.nth(i);
    if (!(await field.isVisible().catch(() => false))) continue;
    if (!(await field.isEnabled().catch(() => false))) continue;
    if ((await field.getAttribute('readonly').catch(() => null)) !== null) continue;
    const { id, kind, type } = await describeField(field);
    if (type === 'checkbox' || type === 'radio' || type === 'submit') continue;
    if ((opts.skip ?? []).some((re) => re.test(id))) continue;
    const payloads = kind === 'search' ? TEXT_PAYLOADS : NUMERIC_PAYLOADS;
    let original = '';
    try {
      original = await field.inputValue({ timeout: 3000 });
    } catch {
      continue;
    }
    tested++;

    for (const payload of payloads) {
      setCurrent(`${id} <= ${JSON.stringify(payload)}`);
      const errBefore = errors.length;
      const valueAfter = await applyPayload(field, payload, kind);
      const invalid = await field.getAttribute('aria-invalid').catch(() => null);
      const summaryNaN =
        (await page.getByText(/NaN/).count().catch(() => 0)) > 0;
      const newErrors = errors.slice(errBefore);
      const note =
        newErrors.length > 0
          ? `ERROR: ${newErrors[0]}`
          : summaryNaN
            ? 'NaN rendered on page'
            : isBadValue(valueAfter)
              ? `bad stored value ${JSON.stringify(valueAfter)}`
              : kind === 'number' && payload !== '' && valueAfter === payload && /[a-z$]/.test(payload)
                ? 'junk kept verbatim'
                : 'ok';
      records.push({ field: id, payload, valueAfter, invalid, note });
      if (note.startsWith('ERROR') || summaryNaN || isBadValue(valueAfter)) {
        criticals.push(`${id} <= ${JSON.stringify(payload)} → ${note} (value=${JSON.stringify(valueAfter)})`);
      } else if (note === 'junk kept verbatim') {
        warnings.push(`${id} kept ${JSON.stringify(payload)} verbatim (invalid=${invalid})`);
      }
      // Restore original so payloads don't contaminate each other.
      await applyPayload(field, original, kind);
    }
    // Leave the field tabbed-out on its original value (checks tab-out default).
    const finalValue = await field.inputValue().catch(() => '');
    if (finalValue !== original) {
      warnings.push(`${id}: restore drift ${JSON.stringify(original)} → ${JSON.stringify(finalValue)}`);
    }
  }
  return { area, fields: tested, records, criticals, warnings };
}

/** Cycle every option of each visible select in scope; report crashes. */
export async function sweepSelects(
  page: Page,
  area: string,
  scope: Locator,
  setCurrent: (c: string) => void,
  errors: string[],
): Promise<string[]> {
  const criticals: string[] = [];
  const selects = scope.locator('select');
  const count = await selects.count();
  for (let i = 0; i < count; i++) {
    const sel = selects.nth(i);
    if (!(await sel.isVisible().catch(() => false))) continue;
    if (!(await sel.isEnabled().catch(() => false))) continue;
    const options = await sel.locator('option:not([disabled])').allTextContents().catch(() => []);
    for (const opt of options.slice(0, 6)) {
      const label = opt.trim() || '(empty)';
      setCurrent(`select#${i} <= ${label}`);
      const errBefore = errors.length;
      try {
        await sel.selectOption({ label: opt.trim() || undefined }).catch(() => {});
      } catch (e) {
        criticals.push(`select#${i} <= ${label} threw ${String(e).slice(0, 120)}`);
      }
      await page.waitForTimeout(200);
      if (errors.length > errBefore) {
        criticals.push(`select#${i} <= ${label} → ${errors[errors.length - 1]}`);
      }
    }
  }
  void area;
  return criticals;
}

/**
 * Decimal sweep: feeds DECIMAL_PAYLOADS into every numeric input and, after
 * each one, inspects computed outputs (sequence summary, voyage summary
 * panel, whole page) for NaN/Infinity leaks and unrounded long decimals.
 * Restores the original value after each payload.
 */
export async function sweepDecimals(
  page: Page,
  area: string,
  scope: Locator,
  setCurrent: (c: string) => void,
  errors: string[],
  opts: { include?: RegExp[]; exclude?: RegExp[]; payloads?: string[] } = {},
): Promise<FuzzResult> {
  const records: FuzzRecord[] = [];
  const criticals: string[] = [];
  const warnings: string[] = [];
  const fields = scope.locator('input');
  const count = await fields.count();
  let tested = 0;

  const computedText = async (): Promise<string> => {
    const parts: string[] = [];
    const seq = page.locator('button[title="Sequence summary"]');
    if ((await seq.count()) > 0) {
      parts.push((await seq.first().textContent().catch(() => '')) ?? '');
    }
    parts.push((await page.locator('body').textContent().catch(() => '')) ?? '');
    return parts.join(' | ');
  };

  for (let i = 0; i < count; i++) {
    const field = fields.nth(i);
    if (!(await field.isVisible().catch(() => false))) continue;
    if (!(await field.isEnabled().catch(() => false))) continue;
    if ((await field.getAttribute('readonly').catch(() => null)) !== null) continue;
    const { id, kind } = await describeField(field);
    if (kind === 'search') continue;
    if (opts.include && !opts.include.some((re) => re.test(id))) continue;
    if (opts.exclude && opts.exclude.some((re) => re.test(id))) continue;
    const payloads = opts.payloads ?? DECIMAL_PAYLOADS;
    let original = '';
    try {
      original = await field.inputValue({ timeout: 3000 });
    } catch {
      continue;
    }
    tested++;

    for (const payload of payloads) {
      setCurrent(`${id} <= ${JSON.stringify(payload)}`);
      const errBefore = errors.length;
      const valueAfter = await applyPayload(field, payload, kind);
      const invalid = await field.getAttribute('aria-invalid').catch(() => null);
      const out = await computedText();
      const newErrors = errors.slice(errBefore);
      const storedDp = (valueAfter.split('.')[1] ?? '').length;
      const longOut = out.match(/\d+\.\d{7,}/);
      const note =
        newErrors.length > 0
          ? `ERROR: ${newErrors[0]}`
          : /nan/i.test(out)
            ? 'NaN rendered in outputs'
            : /infinity/i.test(out)
              ? 'Infinity rendered in outputs'
              : longOut
                ? `unrounded output ${longOut[0].slice(0, 30)}`
                : storedDp > 10
                  ? `stored ${storedDp}dp unrounded`
                  : 'ok';
      records.push({ field: id, payload, valueAfter, invalid, note });
      if (note.startsWith('ERROR') || /NaN|Infinity/.test(note)) {
        criticals.push(`${id} <= ${JSON.stringify(payload)} → ${note} (stored=${JSON.stringify(valueAfter)})`);
      } else if (note !== 'ok') {
        warnings.push(`${id} <= ${JSON.stringify(payload)} → ${note} (stored=${JSON.stringify(valueAfter.slice(0, 40))})`);
      }
      await applyPayload(field, original, kind);
    }
  }
  return { area, fields: tested, records, criticals, warnings };
}

/**
 * Fast decimal sweep over an explicit selector list. Minimal waits, checks
 * NaN/Infinity via cheap locator counts + sequence-summary text only
 * (no full-body textContent per payload, which is what made the generic
 * sweep time out). Restores original once per field at the end.
 */
export async function sweepDecimalsIds(
  page: Page,
  area: string,
  ids: string[],
  setCurrent: (c: string) => void,
  errors: string[],
  payloads: string[] = DECIMAL_PAYLOADS,
): Promise<FuzzResult> {
  const records: FuzzRecord[] = [];
  const criticals: string[] = [];
  const warnings: string[] = [];
  let tested = 0;
  const seqSummary = page.locator('button[title="Sequence summary"]');

  for (const sel of ids) {
    const field = page.locator(sel);
    if ((await field.count()) === 0) continue;
    if (!(await field.first().isVisible().catch(() => false))) continue;
    if (!(await field.first().isEnabled().catch(() => false))) continue;
    const target = field.first();
    let original = '';
    try {
      original = await target.inputValue({ timeout: 3000 });
    } catch {
      continue;
    }
    const id = sel;
    tested++;
    for (const payload of payloads) {
      setCurrent(`${id} <= ${JSON.stringify(payload)}`);
      const errBefore = errors.length;
      try {
        await target.fill(payload, { timeout: 4000 });
      } catch {
        await target.evaluate((node, v) => {
          const el = node as HTMLInputElement;
          el.focus();
          el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, payload).catch(() => {});
      }
      await target.evaluate((n) => (n as HTMLElement).blur()).catch(() => {});
      await page.waitForTimeout(90);
      const valueAfter = await target.inputValue().catch(() => '');
      const invalid = await target.getAttribute('aria-invalid').catch(() => null);
      const newErrors = errors.slice(errBefore);
      // Cheap computed-output check: NaN text anywhere + summary button.
      const nanCount = await page.getByText(/NaN/).count().catch(() => 0);
      let sumText = '';
      if ((await seqSummary.count()) > 0) {
        sumText = (await seqSummary.first().textContent().catch(() => '')) ?? '';
      }
      const storedDp = (valueAfter.split('.')[1] ?? '').replace(/[^0-9]/g, '').length;
      const longOut = sumText.match(/\d\.\d{7,}/);
      const note =
        newErrors.length > 0
          ? `ERROR: ${newErrors[0]}`
          : nanCount > 0
            ? 'NaN rendered on page'
            : /infinity/i.test(sumText)
              ? 'Infinity in sequence summary'
              : longOut
                ? `unrounded summary ${longOut[0].slice(0, 30)}`
                : storedDp > 10
                  ? `stored ${storedDp}dp unrounded`
                  : 'ok';
      records.push({ field: id, payload, valueAfter, invalid, note });
      if (note.startsWith('ERROR') || /NaN|Infinity/.test(note)) {
        criticals.push(`${id} <= ${JSON.stringify(payload)} → ${note} (stored=${JSON.stringify(valueAfter.slice(0, 40))})`);
      } else if (note !== 'ok') {
        warnings.push(`${id} <= ${JSON.stringify(payload)} → ${note} (stored=${JSON.stringify(valueAfter.slice(0, 40))})`);
      }
    }
    // Restore once per field (not per payload) — big time saver.
    try {
      await target.fill(original, { timeout: 4000 });
    } catch {
      await target.evaluate((node, v) => {
        const el = node as HTMLInputElement;
        el.focus();
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, original).catch(() => {});
    }
    await target.evaluate((n) => (n as HTMLElement).blur()).catch(() => {});
    await page.waitForTimeout(90);
  }
  return { area, fields: tested, records, criticals, warnings };
}

export function printReport(result: FuzzResult, extraCriticals: string[] = []) {
  const all = [...result.criticals, ...extraCriticals];
  console.log(
    `FUZZ ${result.area}: ${result.fields} fields, ${result.records.length} cases, ` +
      `${all.length} critical, ${result.warnings.length} warnings`,
  );
  for (const c of all) console.log(`  CRITICAL ${c}`);
  for (const w of result.warnings.slice(0, 20)) console.log(`  warn ${w}`);
  if (result.warnings.length > 20) {
    console.log(`  ... +${result.warnings.length - 20} more warnings`);
  }
  expect(all, `fuzz criticals in ${result.area}:\n${all.join('\n')}`).toEqual([]);
}
