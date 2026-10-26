/**
 * Local storage for the dashboard's long-lived testing notes: a comment per sheet inside a named
 * test (workbook), and the history of runs for that test.
 *
 * Uses SQLite through Node's built-in `node:sqlite` (no dependency, no server): the database lives
 * in dashboard/state.db. Everything else the dashboard needs (mapping, the last 20 runs for the Run
 * tab) stays in JSON as before.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS workbooks (
  name TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sheet_notes (
  workbook TEXT NOT NULL,
  sheet_path TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  expect_fail INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workbook, sheet_path)
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workbook TEXT,
  target TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  headed INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  exit_code INTEGER,
  total INTEGER,
  checked INTEGER,
  mismatches INTEGER NOT NULL DEFAULT 0,
  tolerance TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS run_sheets (
  run_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  vessel TEXT,
  sheet_path TEXT,
  status TEXT NOT NULL,
  checked INTEGER,
  mismatches INTEGER NOT NULL DEFAULT 0,
  fields TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (run_id, idx)
);
CREATE INDEX IF NOT EXISTS runs_by_workbook ON runs (workbook, started_at DESC);
CREATE INDEX IF NOT EXISTS run_sheets_by_path ON run_sheets (sheet_path);
`;

/** Opens (and creates) the database, applying the schema. */
export function openDatabase(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

export function createStore(file) {
  const db = openDatabase(file);

  const stmt = {
    upsertWorkbook: db.prepare(
      `INSERT INTO workbooks (name, created_at, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at`,
    ),
    notesFor: db.prepare('SELECT sheet_path, comment, expect_fail, updated_at FROM sheet_notes WHERE workbook = ?'),
    allNotes: db.prepare('SELECT workbook, sheet_path, comment, expect_fail, updated_at FROM sheet_notes'),
    upsertNote: db.prepare(
      `INSERT INTO sheet_notes (workbook, sheet_path, comment, expect_fail, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workbook, sheet_path) DO UPDATE SET
         comment = excluded.comment, expect_fail = excluded.expect_fail, updated_at = excluded.updated_at`,
    ),
    deleteNote: db.prepare('DELETE FROM sheet_notes WHERE workbook = ? AND sheet_path = ?'),
    runCount: db.prepare('SELECT COUNT(*) AS n FROM runs WHERE id = ?'),
    insertRun: db.prepare(
      `INSERT INTO runs (id, workbook, target, path, status, headed, started_at, finished_at, exit_code, total, checked, mismatches, tolerance, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertRunSheet: db.prepare(
      `INSERT INTO run_sheets (run_id, idx, vessel, sheet_path, status, checked, mismatches, fields)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    runsFor: db.prepare(
      `SELECT id, status, headed, started_at, finished_at, exit_code, total, checked, mismatches, error
       FROM runs WHERE workbook = ? ORDER BY started_at DESC LIMIT ?`,
    ),
    sheetsFor: db.prepare(
      `SELECT rs.sheet_path, rs.idx, rs.vessel, rs.status, rs.checked, rs.mismatches, rs.fields,
              r.id AS run_id, r.started_at, r.error AS run_error
       FROM run_sheets rs JOIN runs r ON r.id = rs.run_id
       WHERE r.workbook = ? ORDER BY r.started_at DESC`,
    ),
    totalRuns: db.prepare('SELECT COUNT(*) AS n FROM runs WHERE workbook = ?'),
  };

  const noteRow = (row) => ({
    path: row.sheet_path,
    comment: row.comment,
    expectFail: Boolean(row.expect_fail),
    updatedAt: row.updated_at,
  });

  return {
    /** Every note, grouped by workbook, for a small state payload. */
    allNotes() {
      const out = {};
      for (const row of stmt.allNotes.all()) {
        (out[row.workbook] ??= {})[row.sheet_path] = noteRow(row);
      }
      return out;
    },

    notesFor(workbook) {
      const out = {};
      for (const row of stmt.notesFor.all(workbook)) out[row.sheet_path] = noteRow(row);
      return out;
    },

    /** Saves a note; an empty comment with no "expected to fail" flag removes it again. */
    saveNote({ workbook, sheetPath, comment, expectFail }) {
      const name = String(workbook ?? '').trim();
      const path = String(sheetPath ?? '').trim();
      if (!name || !path) throw new Error('workbook and sheet path are required');
      const text = String(comment ?? '').trim();
      const expect = expectFail ? 1 : 0;
      if (!text && !expect) {
        stmt.deleteNote.run(name, path);
        return null;
      }
      const now = Date.now();
      stmt.upsertNote.run(name, path, text, expect, now);
      stmt.upsertWorkbook.run(name, now, now);
      return { path, comment: text, expectFail: Boolean(expect), updatedAt: now };
    },

    touchWorkbook(name) {
      const now = Date.now();
      if (name) stmt.upsertWorkbook.run(name, now, now);
    },

    /**
     * Stores one finished run and its per-sheet results.
     * `run.sheetPaths[index - 1]` maps a 1-based sheet index to its file.
     */
    recordRun(run) {
      if (!run?.id || stmt.runCount.get(run.id).n > 0) return false;
      // Older history.json entries stored a mismatch *count*, not the list of fields; count them
      // through `mismatchCount` so the total stays right even without field names.
      const num = (v) => (Number.isFinite(v) ? v : 0);
      const total = (s) => (Array.isArray(s.mismatches) ? s.mismatches.length : 0) + num(s.mismatchCount);
      const checked = run.sheets.reduce((n, s) => n + num(s.checked), 0);
      const mismatches = run.sheets.reduce((n, s) => n + total(s), 0);
      stmt.insertRun.run(
        run.id,
        run.name ?? null,
        run.target,
        run.path,
        run.status,
        run.headed ? 1 : 0,
        run.startedAt,
        run.finishedAt ?? null,
        run.exitCode ?? null,
        run.total ?? null,
        checked,
        mismatches,
        run.tolerance ? JSON.stringify(run.tolerance) : null,
        run.error ?? null,
      );
      for (const sheet of run.sheets) {
        stmt.insertRunSheet.run(
          run.id,
          sheet.index,
          sheet.vessel ?? null,
          run.sheetPaths?.[sheet.index - 1] ?? sheet.path ?? null,
          sheet.status,
          Number.isFinite(sheet.checked) ? sheet.checked : null,
          total(sheet),
          JSON.stringify(Array.isArray(sheet.mismatches) ? sheet.mismatches : []),
        );
      }
      if (run.name) {
        const now = Date.now();
        stmt.upsertWorkbook.run(run.name, now, now);
      }
      return true;
    },

    /** Runs plus a per-sheet roll-up ("fails every time" vs "flaky") for one workbook name. */
    workbookHistory(name, { limit = 100 } = {}) {
      const runs = stmt.runsFor.all(name, limit).map((row) => ({
        id: row.id,
        status: row.status,
        headed: Boolean(row.headed),
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        exitCode: row.exit_code,
        total: row.total,
        checked: row.checked,
        mismatches: row.mismatches,
        error: row.error,
      }));
      const sheets = new Map();
      for (const row of stmt.sheetsFor.all(name)) {
        const key = row.sheet_path ?? `#${row.idx}`;
        const entry =
          sheets.get(key) ??
          { path: row.sheet_path, index: row.idx, vessel: row.vessel, runs: 0, failures: 0, last: null };
        entry.runs++;
        // "Last failure" prefers a run that got as far as comparing fields, but falls back to the
        // newest failure so a run that died early still explains itself (e.g. a leg-count error).
        const failure = row.status === 'failed' ? { runId: row.run_id, startedAt: row.started_at, fields: JSON.parse(row.fields || '[]'), error: row.run_error ?? null } : null;
        if (failure) {
          entry.failures++;
          if (!entry.last || (entry.last.fields.length === 0 && (failure.fields.length > 0 || !entry.last.error))) entry.last = failure;
        }
        sheets.set(key, entry);
      }
      return { runs, sheets: [...sheets.values()], totalRuns: stmt.totalRuns.get(name).n };
    },

    close() {
      db.close();
    },
  };
}

/** Seeds the database from the dashboard's old history.json (idempotent by run id). */
export function importLegacyRuns(store, entries, sheetPathsByName) {
  let added = 0;
  for (const entry of entries ?? []) {
    if (!entry?.id) continue;
    const run = {
      id: entry.id,
      name: entry.name ?? null,
      target: entry.target ?? 'workbook',
      path: entry.path ?? '',
      status: entry.status ?? 'failed',
      headed: Boolean(entry.headed),
      startedAt: entry.startedAt ?? 0,
      finishedAt: entry.finishedAt ?? null,
      exitCode: entry.exitCode ?? null,
      total: entry.total ?? null,
      error: entry.error ?? null,
      tolerance: typeof entry.tolerance === 'object' ? entry.tolerance : null,
      sheetPaths: sheetPathsByName[entry.name] ?? [],
      sheets: (entry.sheets ?? []).map((s) => ({
        index: s.index,
        vessel: s.vessel ?? '',
        status: s.status ?? 'failed',
        checked: Number.isFinite(s.checked) ? s.checked : null,
        // Some old entries wrote the count as a number instead of a field list.
        mismatches: Array.isArray(s.mismatches) ? s.mismatches : [],
        mismatchCount: Array.isArray(s.mismatches) ? 0 : Number(s.mismatches) || 0,
      })),
    };
    if (store.recordRun(run)) added++;
  }
  return added;
}
