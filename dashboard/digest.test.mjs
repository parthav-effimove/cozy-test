import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest, SUMMARY_SYSTEM_PROMPT } from './digest.mjs';

/**
 * The digest is what leaves the machine, so these tests are mostly about what it must NOT contain.
 * Run: node --test dashboard/digest.test.mjs
 */

const RUN = {
  id: 'abc12345-0000-0000-0000-000000000000',
  name: 'oct sheets',
  target: 'workbook',
  status: 'failed',
  headed: true,
  speed: 'fast',
  shards: 2,
  total: 3,
  startedAt: 1_000_000,
  finishedAt: 1_000_000 + 24 * 60_000,
  sheets: [
    { index: 1, vessel: 'STAR LEO', status: 'saved', checked: 40, mismatches: [] },
    {
      index: 2,
      vessel: 'FUGA',
      status: 'failed',
      checked: 40,
      mismatches: [
        { field: 'Incl Hire', expected: '735140.17', actual: '$ 656,028.15' },
        { field: 'Gross Rate', expected: '25.51', actual: '$ 22.77 /mt' },
      ],
    },
    {
      index: 3,
      vessel: 'JIN AN',
      status: 'failed',
      checked: 40,
      mismatches: [
        { field: 'Gross Rate', expected: '23.37', actual: '$ 0.00 /mt' },
        { field: 'Incl Hire', expected: '1098022.6', actual: '$ 1,088,551.92' },
      ],
    },
  ],
  log: [
    '--- sheet 1/3: STAR LEO',
    'MISMATCH sheet 2 FUGA Incl Hire: wanted 735140.17, got $ 656,028.15',
    'TimeoutError: locator.click: Timeout 15000ms exceeded.',
    '    at /Users/me/tests/oct21-json-replay.spec.ts:581:73',
    'TimeoutError: locator.click: Timeout 15000ms exceeded.',
    '   583 | await page.waitForTimeout(300);',
    'test-results/oct21-json-replay-x-chrome/test-failed-1.png',
    'Error Context: test-results/oct21-json-replay-x-chrome/error-context.md',
    'sheet 3 JIN AN: Voyage Summary not found',
  ].join('\n'),
};

test('the digest names fields and sheets but carries no values', () => {
  const digest = buildDigest(RUN);
  assert.match(digest, /#2 FUGA: failed/);
  assert.match(digest, /Incl Hire/);
  assert.match(digest, /Gross Rate/);
  // None of the figures from the run may reach the model.
  for (const value of ['735140', '656,028', '25.51', '22.77', '1098022', '1,088,551', '23.37', '0.00']) {
    assert.equal(digest.includes(value), false, `digest leaked ${value}`);
  }
});

test('a saved sheet is not listed as failing, and the tally is right', () => {
  const digest = buildDigest(RUN);
  assert.match(digest, /2 failed/);
  assert.match(digest, /1 saved/);
  assert.equal(digest.includes('#1 STAR LEO: failed'), false);
  assert.equal(digest.includes('#1 STAR LEO'), false);
});

test('fields shared by several sheets are called out with those sheets', () => {
  const digest = buildDigest(RUN);
  assert.match(digest, /Incl Hire: 2 sheet\(s\) \(#2, #3\)/);
  assert.match(digest, /Gross Rate: 2 sheet\(s\) \(#2, #3\)/);
});

test('error lines are deduplicated and stack frames dropped', () => {
  const digest = buildDigest(RUN);
  assert.equal(digest.match(/TimeoutError: locator\.click/g).length, 1);
  assert.equal(digest.includes('/Users/me/tests'), false);
  assert.match(digest, /Voyage Summary not found/);
});

test('code frames and artifact paths are dropped from the errors', () => {
  const digest = buildDigest(RUN);
  assert.equal(digest.includes('583 |'), false);
  assert.equal(digest.includes('test-failed-1.png'), false);
  assert.equal(digest.includes('Error Context'), false);
});

test('the error list respects its cap', () => {
  const noisy = {
    ...RUN,
    log: Array.from({ length: 40 }, (_, i) => `Error number ${i}: something broke`).join('\n'),
  };
  const digest = buildDigest(noisy, { maxErrorLines: 5 });
  assert.equal(digest.match(/Error number/g).length, 5);
});

test('a clean run says so instead of inventing a problem', () => {
  const clean = { ...RUN, status: 'passed', sheets: RUN.sheets.map((s) => ({ ...s, status: 'saved', mismatches: [] })), log: '' };
  const digest = buildDigest(clean);
  assert.match(digest, /Failing sheets: none/);
  assert.equal(digest.includes('mismatch(es)'), false);
});

test('the assertion diff is not pasted into the errors', () => {
  const noisy = {
    ...RUN,
    log: [
      'Error: fields that did not keep the JSON value:',
      '    - Expected  -  1',
      '    + Received  + 27',
      '- Array []',
      '+ Array [',
      '+   "sheet 21 : Voyage Summary not found",',
    ].join('\n'),
  };
  const digest = buildDigest(noisy);
  assert.match(digest, /fields that did not keep the JSON value/);
  for (const fragment of ['Received', 'Array [', 'Expected  -']) {
    assert.equal(digest.includes(fragment), false, `digest kept diff fragment ${fragment}`);
  }
});

test('the instruction forbids inventing numbers', () => {
  assert.match(SUMMARY_SYSTEM_PROMPT, /Never invent/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /STANDS OUT/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /unclear from the digest/);
});
