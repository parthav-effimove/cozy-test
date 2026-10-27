import { expect, test } from '@playwright/test';
import {
  DEFAULT_TOLERANCES,
  compareRows,
  resolveTolerances,
  toleranceFor,
  type SummaryField,
  type SummaryRow,
} from './summary-compare';

/**
 * The Voyage Summary comparison rules, without a browser.
 * Run: npx playwright test tests/summary-compare.spec.ts --project=chromium-headless
 */

const FIELDS: SummaryField[] = [
  { label: 'Incl Hire', path: 'hire.incl_hire', kind: 'money' },
  { label: 'Gross Rate', path: 'cargo_economics.cargo_1_gross_rate_per_mt', kind: 'rate', pattern: '^(gross rate|cargo #1 gross rate)' },
  { label: 'Wind Reward Factor', path: 'fuel_eu_maritime.wind_reward_factor', kind: 'rate' },
  { label: 'Estimated Voyage CII Rating', path: 'environmental.estimated_voyage_cii_rating', kind: 'text' },
  { label: 'CO2 Cost per tonne', path: 'eu_ets.co2_cost_per_t', kind: 'rate' },
  { label: 'CO2 Cost per tonne', path: 'uk_ets.co2_cost_per_t', kind: 'rate' },
];

const EXPECTED = {
  hire: { incl_hire: 559272.83 },
  cargo_economics: { cargo_1_gross_rate_per_mt: 9.43 },
  fuel_eu_maritime: { wind_reward_factor: 1.25 },
  environmental: { estimated_voyage_cii_rating: 'C' },
  eu_ets: { co2_cost_per_t: 90 },
  uk_ets: { co2_cost_per_t: 100 },
};

const ROWS: SummaryRow[] = [
  { label: 'Incl Hire', value: '$ 559,272.58' },
  { label: 'Cargo #1 Gross Rate(30,000 mt)', value: '$ 9.43 /mt' },
  { label: 'Wind Reward Factor', value: '1.00' },
  { label: 'Estimated Voyage CII Rating', value: 'C' },
  { label: 'CO2 Cost per tonne', value: '$ 90.00 /t' },
  { label: 'CO2 Cost per tonne', value: '$ 100.00 /t' },
];

const badFields = (result: { bad: string[] }) => result.bad.map((line) => line.replace(/^sheet 1 \w+ /, ''));

test('the same 0.25 error passes for an amount and fails for a rate', () => {
  const result = compareRows(ROWS, EXPECTED, FIELDS, DEFAULT_TOLERANCES, 'sheet 1 LEO');
  expect(result.empty).toBe(false);
  expect(result.checked).toBe(6);
  // Incl Hire is 0.25 off and passes on the 0.5 amount slack; the wind factor is 0.25 off and fails,
  // because rates get 0.01. Gross Rate matches exactly, so it passes under either rule.
  expect(badFields(result)).toEqual(['Wind Reward Factor: wanted 1.25, got 1.00']);
});

test('a per-field override wins over the group default in both directions', () => {
  const tolerances = resolveTolerances({
    amount: 0.5,
    rate: 0.01,
    fields: { 'hire.incl_hire': 0, 'fuel_eu_maritime.wind_reward_factor': 0.5 },
  });
  const result = compareRows(ROWS, EXPECTED, FIELDS, tolerances, 'sheet 1 LEO');
  // Incl Hire is now exact-only, so its 0.25 error fails; the wind factor now tolerates 0.5, so it passes.
  expect(badFields(result)).toEqual(['Incl Hire: wanted 559272.83, got $ 559,272.58']);
});

test('text fields are compared exactly', () => {
  const expected = { ...EXPECTED, environmental: { estimated_voyage_cii_rating: 'B' } };
  const result = compareRows(ROWS, expected, FIELDS, DEFAULT_TOLERANCES, 'sheet 1 LEO');
  expect(badFields(result)).toContain('Estimated Voyage CII Rating: wanted B, got C');
});

test('repeated labels are matched in order, so EU and UK rows keep their own value', () => {
  const expected = { ...EXPECTED, eu_ets: { co2_cost_per_t: 90 }, uk_ets: { co2_cost_per_t: 100 } };
  const ok = compareRows(ROWS, expected, FIELDS, DEFAULT_TOLERANCES, 'sheet 1 LEO');
  expect(ok.bad.filter((line) => line.includes('CO2 Cost per tonne'))).toEqual([]);

  const swapped = compareRows(ROWS, { ...EXPECTED, eu_ets: { co2_cost_per_t: 100 }, uk_ets: { co2_cost_per_t: 90 } }, FIELDS, DEFAULT_TOLERANCES, 'sheet 1 LEO');
  expect(badFields(swapped).filter((line) => line.includes('CO2 Cost per tonne'))).toHaveLength(2);
});

test('a missing row is reported and names the rows that did render', () => {
  const rows = ROWS.filter((row) => row.label !== 'Wind Reward Factor');
  const result = compareRows(rows, EXPECTED, FIELDS, DEFAULT_TOLERANCES, 'sheet 1 LEO');
  expect(badFields(result)[0]).toBe('Wind Reward Factor: row not found in Voyage Summary');
  expect(result.note).toContain('Incl Hire | Cargo #1 Gross Rate');
});

test('an empty Voyage Summary is its own outcome, not a silent pass', () => {
  expect(compareRows([], EXPECTED, FIELDS, DEFAULT_TOLERANCES, 'sheet 1 LEO')).toEqual({
    checked: 0,
    bad: [],
    empty: true,
    note: undefined,
  });
});

test('config: group defaults, legacy single value and bad input', () => {
  expect(resolveTolerances({ amount: 2, rate: 0.05 })).toEqual({ amount: 2, rate: 0.05, fields: {}, skip: {} });
  // Old dashboards saved one number that applied to everything.
  expect(resolveTolerances(undefined, '0.2')).toEqual({ amount: 0.2, rate: 0.2, fields: {}, skip: {} });
  expect(resolveTolerances(undefined, undefined)).toEqual({ amount: 0.5, rate: 0.01, fields: {}, skip: {} });
  // Negative, non-numeric and non-object values fall back instead of loosening the check.
  expect(resolveTolerances({ amount: -1, rate: 'x', fields: { 'hire.incl_hire': -5, 'eu_ets.total_co2_t': 0 } })).toEqual({
    amount: 0.5,
    rate: 0.01,
    fields: { 'eu_ets.total_co2_t': 0 },
    skip: {},
  });
});

test('a field switched off is not checked and never reported', () => {
  // The wind factor is 0.25 off, which fails as a rate; switched off, it must not be mentioned.
  const tolerances = resolveTolerances({ skip: { 'fuel_eu_maritime.wind_reward_factor': true } });
  const result = compareRows(ROWS, EXPECTED, FIELDS, tolerances, 'sheet 1 LEO');
  expect(result.checked).toBe(5);
  expect(badFields(result)).toEqual([]);
});

test('a field switched off is not reported even when its row is missing', () => {
  const rows = ROWS.filter((row) => row.label !== 'Wind Reward Factor');
  const tolerances = resolveTolerances({ skip: { 'fuel_eu_maritime.wind_reward_factor': 'true' } });
  const result = compareRows(rows, EXPECTED, FIELDS, tolerances, 'sheet 1 LEO');
  expect(result.checked).toBe(5);
  expect(badFields(result)).toEqual([]);
});

test('only fields explicitly switched off are skipped; everything else stays checked', () => {
  const tolerances = resolveTolerances({ skip: { 'hire.incl_hire': true, 'eu_ets.total_co2_t': false } });
  expect(tolerances.skip).toEqual({ 'hire.incl_hire': true });
  const result = compareRows(ROWS, EXPECTED, FIELDS, tolerances, 'sheet 1 LEO');
  // Incl Hire drops out, so only the wind factor still fails.
  expect(result.checked).toBe(5);
  expect(badFields(result)).toEqual(['Wind Reward Factor: wanted 1.25, got 1.00']);
});

test('toleranceFor: override, money group, rate group, quantity group', () => {
  const tolerances = resolveTolerances({ amount: 1, rate: 0.02, fields: { 'hire.excl_hire': 0 } });
  expect(toleranceFor({ label: 'Incl Hire', path: 'hire.incl_hire', kind: 'money' }, tolerances)).toBe(1);
  expect(toleranceFor({ label: 'Excl Hire', path: 'hire.excl_hire', kind: 'money' }, tolerances)).toBe(0);
  expect(toleranceFor({ label: 'EEOI', path: 'environmental.eeoi_gco2_per_tnm', kind: 'rate' }, tolerances)).toBe(0.02);
  expect(toleranceFor({ label: 'Total CO2', path: 'eu_ets.total_co2_t', kind: 'quantity' }, tolerances)).toBe(0.02);
  expect(toleranceFor({ label: 'CII', path: 'environmental.estimated_voyage_cii_rating', kind: 'text' }, tolerances)).toBe(0.02);
});
