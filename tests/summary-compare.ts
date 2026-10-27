/**
 * Pure Voyage Summary comparison: which summary row an expected field lives on, and how far the
 * on-screen number may sit from the expected one. Kept free of Playwright so the tolerance rules
 * can be unit-tested (tests/summary-compare.spec.ts) without launching a browser.
 */

export type SummaryRow = { label: string; value: string };

/**
 * kind drives the default slack:
 * - `money`    currency totals, summed from rounded figures, so they may drift a little
 * - `quantity` tonnes and days, printed to two decimals
 * - `rate`     per-mt rates, ratios and factors, where a small error is a real error
 * - `text`     compared exactly (e.g. the CII rating)
 */
export type SummaryField = {
  label: string;
  path: string;
  kind: 'money' | 'quantity' | 'rate' | 'text';
  /** Label matcher for rows whose label changes with the sheet (e.g. "Cargo #1 Gross Rate(30,000 mt)"). */
  pattern?: string;
};

export type Tolerances = {
  amount: number;
  rate: number;
  /** Per-field overrides keyed by the expected-output path; they win over both groups. */
  fields: Record<string, number>;
  /**
   * Fields switched off in the dashboard, keyed by the expected-output path. They are left out of the
   * comparison entirely: no check, no mismatch line. For values that legitimately move (bunker prices,
   * FuelEU penalties, FX rates) so a real regression is not buried under expected drift.
   */
  skip: Record<string, boolean>;
};

export const DEFAULT_TOLERANCES: Tolerances = { amount: 0.5, rate: 0.01, fields: {}, skip: {} };

/** Labels use a subscript ₂ in the app, so normalise it before comparing. */
export const normLabel = (s: string) => s.replace(/₂/g, '2').replace(/\s+/g, ' ').trim().toLowerCase();

export function readPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

const asTolerance = (value: unknown, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Builds the tolerance config from the dashboard's saved settings.
 * `raw` is the parsed SUMMARY_TOLERANCES file; `legacy` is the older single SUMMARY_TOLERANCE
 * value, which applied to every number and is only used when no file was given.
 */
export function resolveTolerances(raw: unknown, legacy?: unknown): Tolerances {
  const isObject = raw !== null && typeof raw === 'object';
  if (!isObject) {
    if (legacy !== undefined && legacy !== null && legacy !== '') {
      const value = asTolerance(legacy, DEFAULT_TOLERANCES.amount);
      return { amount: value, rate: value, fields: {}, skip: {} };
    }
    return { ...DEFAULT_TOLERANCES, fields: {}, skip: {} };
  }
  const src = raw as Record<string, unknown>;
  const fields: Record<string, number> = {};
  const rawFields = src.fields !== null && typeof src.fields === 'object' ? (src.fields as Record<string, unknown>) : {};
  for (const [path, value] of Object.entries(rawFields)) {
    const n = Number(value);
    if (path && Number.isFinite(n) && n >= 0) fields[path] = n;
  }
  // Only fields explicitly switched off are stored, so a new field is checked by default.
  const skip: Record<string, boolean> = {};
  const rawSkip = src.skip !== null && typeof src.skip === 'object' ? (src.skip as Record<string, unknown>) : {};
  for (const [path, value] of Object.entries(rawSkip)) if (path && value) skip[path] = true;
  return {
    amount: asTolerance(src.amount, DEFAULT_TOLERANCES.amount),
    rate: asTolerance(src.rate, DEFAULT_TOLERANCES.rate),
    fields,
    skip,
  };
}

/** The slack for one field: its own override, else the amount or rate/quantity group default. */
export function toleranceFor(field: SummaryField, tolerances: Tolerances): number {
  const override = tolerances.fields[field.path];
  if (typeof override === 'number' && Number.isFinite(override)) return override;
  return field.kind === 'money' ? tolerances.amount : tolerances.rate;
}

export type ComparisonResult = {
  checked: number;
  /** `${who} <label>: wanted X, got Y` — one line per failure, log-ready. */
  bad: string[];
  /** True when the Voyage Summary card was not found at all. */
  empty: boolean;
  /** Debug line listing every row the app did render, set when the first failure is a missing row. */
  note?: string;
};

/**
 * Compares the rows rendered in the Voyage Summary with the expected output file.
 * `fields` is in rendering order and repeated labels are matched to the next occurrence, so the
 * EU ETS and UK ETS "CO2 Cost per tonne" rows each pick up their own value.
 */
export function compareRows(
  rows: SummaryRow[],
  expected: unknown,
  fields: SummaryField[],
  tolerances: Tolerances,
  who: string,
): ComparisonResult {
  if (rows.length === 0) return { checked: 0, bad: [], empty: true };
  const bad: string[] = [];
  let cursor = 0;
  let checked = 0;
  for (const field of fields) {
    // Switched off in the dashboard: not looked up, not counted, never reported as a mismatch.
    if (tolerances.skip[field.path]) continue;
    const want = readPath(expected, field.path);
    if (want === undefined || want === null) continue;
    const pattern = field.pattern ? new RegExp(field.pattern) : undefined;
    const wanted = normLabel(field.label);
    const matches = (label: string) => (pattern ? pattern.test(normLabel(label)) : normLabel(label) === wanted);
    const at = rows.findIndex((row, index) => index >= cursor && matches(row.label));
    if (at < 0) {
      bad.push(`${who} ${field.label}: row not found in Voyage Summary`);
      continue;
    }
    cursor = at + 1;
    checked++;
    const raw = rows[at].value;
    if (field.kind === 'text') {
      if (String(want).trim().toUpperCase() !== raw.trim().toUpperCase()) {
        bad.push(`${who} ${field.label}: wanted ${want}, got ${raw}`);
      }
      continue;
    }
    // Strip currency symbols, thousands separators and units; keep the sign and decimal point.
    const got = Number(raw.replace(/[^0-9.-]/g, ''));
    if (!Number.isFinite(got) || Math.abs(got - Number(want)) > toleranceFor(field, tolerances)) {
      bad.push(`${who} ${field.label}: wanted ${want}, got ${raw}`);
    }
  }
  const note =
    bad.length > 0 && bad[0].includes('row not found')
      ? `${who}: summary rows: ${rows.map((row) => row.label).join(' | ')}`
      : undefined;
  return { checked, bad, empty: false, note };
}
