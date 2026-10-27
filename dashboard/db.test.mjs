import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createStore, importLegacyRuns } from './db.mjs';

/** A throwaway database per test, so nothing touches dashboard/state.db. */
function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-db-'));
  const store = createStore(join(dir, 'state.db'));
  try {
    return fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const sheet = (index, status, mismatches = []) => ({
  index,
  vessel: `VESSEL ${index}`,
  status,
  checked: 40,
  mismatches,
});

const run = (over = {}) => ({
  id: over.id ?? 'run-1',
  name: 'test 2',
  target: 'workbook',
  path: 'workbooks/test-2.json',
  status: 'failed',
  headed: false,
  startedAt: 1000,
  finishedAt: 2000,
  exitCode: 1,
  total: 2,
  sheetPaths: ['balast/sheet1.json', 'balast/sheet2.json'],
  sheets: [
    sheet(1, 'failed', [{ field: 'Gross Rate', expected: '9.43', actual: '$ 0.00 /mt' }]),
    sheet(2, 'saved'),
  ],
  ...over,
});

test('a finished run is stored once, with its per-sheet results', () => {
  withStore((store) => {
    assert.equal(store.recordRun(run()), true);
    // The same id is ignored, so a repeated finish cannot double-count.
    assert.equal(store.recordRun(run()), false);

    const history = store.workbookHistory('test 2');
    assert.equal(history.totalRuns, 1);
    assert.equal(history.runs.length, 1);
    assert.equal(history.runs[0].mismatches, 1);
    assert.equal(history.runs[0].checked, 80);

    const byPath = Object.fromEntries(history.sheets.map((s) => [s.path, s]));
    assert.equal(byPath['balast/sheet1.json'].failures, 1);
    assert.equal(byPath['balast/sheet1.json'].last.fields[0].field, 'Gross Rate');
    assert.equal(byPath['balast/sheet2.json'].failures, 0);
  });
});

test('field history says which fields keep failing and on which sheets', () => {
  withStore((store) => {
    store.recordRun(
      run({
        id: 'run-1',
        startedAt: 1000,
        sheets: [
          sheet(1, 'failed', [{ field: 'Gross Rate', expected: '8.75', actual: '$ 0.00 /mt' }]),
          sheet(2, 'failed', [{ field: 'Gross Rate', expected: '9.43', actual: '$ 0.00 /mt' }]),
        ],
      }),
    );
    store.recordRun(
      run({
        id: 'run-2',
        startedAt: 3000,
        sheets: [sheet(1, 'failed', [{ field: 'Gross Rate', expected: '8.75', actual: '$ 0.00 /mt' }, { field: 'Total Time', expected: '34.72', actual: '34.70' }]), sheet(2, 'saved')],
      }),
    );

    const { totalRuns, fields } = store.fieldHistory('test 2');
    assert.equal(totalRuns, 2);
    const gross = fields.find((f) => f.field === 'Gross Rate');
    assert.equal(gross.runs, 2, 'failed in both runs');
    assert.equal(gross.failures, 3, 'three sheet failures in total');
    assert.deepEqual(gross.sheets, ['balast/sheet1.json', 'balast/sheet2.json']);
    assert.equal(gross.last.expected, '8.75');

    const time = fields.find((f) => f.field === 'Total Time');
    assert.equal(time.runs, 1);
    assert.deepEqual(time.sheets, ['balast/sheet1.json']);
    assert.equal(fields[0].field, 'Gross Rate', 'most frequent field first');
  });
});

test('history tells a sheet that always fails from a flaky one', () => {
  withStore((store) => {
    for (const [n, second] of [[0, 'failed'], [1, 'saved'], [2, 'failed']]) {
      store.recordRun(
        run({
          id: `run-${n}`,
          startedAt: 1000 + n,
          sheets: [
            sheet(1, 'failed', [{ field: 'Incl Hire', expected: '1', actual: '2' }]),
            sheet(2, second),
          ],
        }),
      );
    }
    const byPath = Object.fromEntries(store.workbookHistory('test 2').sheets.map((s) => [s.path, s]));
    assert.deepEqual(
      { runs: byPath['balast/sheet1.json'].runs, failures: byPath['balast/sheet1.json'].failures },
      { runs: 3, failures: 3 },
    );
    assert.deepEqual(
      { runs: byPath['balast/sheet2.json'].runs, failures: byPath['balast/sheet2.json'].failures },
      { runs: 3, failures: 2 },
    );
    // Newest run first.
    assert.equal(store.workbookHistory('test 2').runs[0].startedAt, 1002);
  });
});

test('notes upsert per workbook and are dropped when cleared', () => {
  withStore((store) => {
    store.saveNote({ workbook: 'test 2', sheetPath: 'balast/sheet1.json', comment: 'known app bug', expectFail: true });
    store.saveNote({ workbook: 'test 1', sheetPath: 'balast/sheet1.json', comment: 'different reason' });

    assert.equal(store.notesFor('test 2')['balast/sheet1.json'].comment, 'known app bug');
    assert.equal(store.notesFor('test 2')['balast/sheet1.json'].expectFail, true);
    assert.equal(store.notesFor('test 1')['balast/sheet1.json'].comment, 'different reason');
    assert.deepEqual(Object.keys(store.allNotes()).sort(), ['test 1', 'test 2']);

    store.saveNote({ workbook: 'test 2', sheetPath: 'balast/sheet1.json', comment: '', expectFail: false });
    assert.deepEqual(store.notesFor('test 2'), {});
  });
});

test('runs recorded before the database existed are imported with their sheet paths', () => {
  withStore((store) => {
    const legacy = [
      {
        id: 'old-1',
        target: 'workbook',
        path: 'workbooks/test-2.json',
        name: 'test 2',
        headed: true,
        status: 'failed',
        startedAt: 500,
        finishedAt: 900,
        total: 2,
        checked: 40,
        mismatchCount: 1,
        sheets: [
          { index: 1, vessel: 'STAR LEO', status: 'failed', checked: 40, mismatches: [{ field: 'Gross Rate', expected: '6.62', actual: '$ 0.00 /mt' }] },
          { index: 2, vessel: 'SEA ARROW', status: 'saved', checked: 40, mismatches: [] },
        ],
      },
    ];
    const added = importLegacyRuns(store, legacy, { 'test 2': ['balast/sheet1.json', 'balast/sheet2.json'] });
    assert.equal(added, 1);
    // Importing twice must not duplicate.
    assert.equal(importLegacyRuns(store, legacy, {}), 0);

    const history = store.workbookHistory('test 2');
    assert.equal(history.totalRuns, 1);
    assert.deepEqual(history.sheets.map((s) => s.path).sort(), ['balast/sheet1.json', 'balast/sheet2.json']);
    assert.equal(history.sheets.find((s) => s.path === 'balast/sheet1.json').last.fields[0].expected, '6.62');
  });
});

test('a legacy entry that stored a mismatch count instead of a list still imports', () => {
  withStore((store) => {
    const legacy = [
      {
        id: 'old-count',
        target: 'workbook',
        path: 'workbooks/test-2.json',
        name: 'test 2',
        status: 'failed',
        startedAt: 100,
        total: 1,
        sheets: [{ index: 1, vessel: 'STAR LEO', status: 'failed', checked: null, mismatches: 1 }],
      },
    ];
    assert.equal(importLegacyRuns(store, legacy, { 'test 2': ['balast/sheet1.json'] }), 1);
    const history = store.workbookHistory('test 2');
    assert.equal(history.runs[0].mismatches, 1);
    assert.equal(history.sheets[0].failures, 1);
  });
});

test('history of an unknown workbook is empty rather than invented', () => {
  withStore((store) => {
    assert.deepEqual(store.workbookHistory('nothing here'), { runs: [], sheets: [], totalRuns: 0 });
  });
});
