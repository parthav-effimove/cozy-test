# Dashboard plan — faster runs, shared-workbook sharding, field history, preflight

Four changes, in build order. Each is independent except that sharding uses the speed presets.

---

## 1. Speed presets (why runs take ~78 s per sheet)

`dashboard/server.mjs` hardcodes `SLOW_MO=150`, so Playwright pauses 150 ms around **every**
action — and a six-leg sheet is hundreds of actions. Nothing else is configurable from the UI.

- `watch` → `SLOW_MO=150` (today's behaviour, good for watching the browser)
- `normal` → `SLOW_MO=60`
- `fast` → `SLOW_MO=0`

A selector in the run bar sends `speed` with the run request and the choice is remembered in
`localStorage`. Nothing in the spec changes, so a slow run and a fast run are comparable.

Measured, not assumed: the same sheet is run at two speeds and the durations recorded in the
table below before this ships as "faster".

## 2. Sharded runs into one workbook

Goal: 18 sheets in well under 23 minutes, still ending up as **one** workbook named after the test.

Protocol:

1. The dashboard splits the workbook's ordered sheet list into `N` round-robin slices
   (`sheet 1 → shard 1, sheet 2 → shard 2, …`), so every shard gets a mix of vessels and sizes.
2. Shard 0 starts with `WORKBOOK_CREATE=1`: it creates the workbook named after the test and opens
   it. Shards 1…N-1 poll the workbook list until that name appears (60 s budget), then open it.
3. Every sheet is logged with its **global** index (`--- sheet 7/18`), so the dashboard merges the
   N logs into one run: per-sheet statuses, one mismatch count, one history row.
4. Each shard starts every sheet on a *new* sheet (the app reopens a workbook on its last sheet), so
   the guard that already exists (`sheetIsBlank`) is applied to every sheet, not just the first.
5. Each sheet is saved as `<n> <vessel>` through the toolbar's Save → name field → **OK**, so a tab
   in the shared workbook can be traced back to its JSON entry (`1 STAR LIBRA`, `2 JIN HAI HUA`)
   instead of every shard producing another `New Sheet 1`.
5. Kill kills every shard's process group (Playwright + its Chrome).

Risk, stated plainly: the app is a hosted SPA and we do not control its write path. If two browsers
saving into one workbook race, a sheet can be lost. The plan is to *test that first* with two
shards over two sheets, and to keep a fallback: `shards=N` with `shared workbook = off` gives each
shard its own workbook (`<name> — shard 2`) and still shows one run in the dashboard.

UI: shard count selector (1–4) next to the speed preset, disabled for single-sheet runs; the run bar
shows `3 shards · 18 sheets`.

## 3. Field-level history

The notes and History views answer "does sheet 9 fail"; they cannot answer "is Gross Rate broken
everywhere, or only on two-cargo sheets".

`run_sheets.fields` already stores `[{field, expected, actual}]` per sheet per run, so this is a
query, not new bookkeeping:

- `store.fieldHistory(workbook)` → per field: runs it appeared in, failures, the sheets it failed on,
  and the last expected/actual.
- History dialog gets a **Fields** section: `Gross Rate — failed in 6/6 runs · sheets 9, 10, 11, 12, 15`.
- Each row offers **Note all sheets** to write one comment onto every sheet that field failed on
  (the note feature already stores per workbook + sheet).

## 4. Preflight

Two failures currently cost minutes at sheet 1 before anything is validated: a logged-out session,
and the app only returning port suggestions to a *visible* browser.

- `tests/preflight.spec.ts` checks, in order: app reachable, login works, calculator opens, and one
  seeded port search returns a suggestion. Each step prints `PREFLIGHT ok|fail <step>: <detail>`.
- `POST /api/preflight` runs it with the same browser profile the run would use and returns the
  steps; the UI shows them as a checklist.
- Runs start with a preflight by default (toggle to skip) and refuse to start when a step fails,
  saying why — e.g. "port search returned nothing: the browser must be visible (Watch browser)".

---

## Verification

| Change | How it is proved | Result |
| --- | --- | --- |
| Speed presets | same sheet (18, 6 legs, headed) at each preset | watch **132 s** · normal **86 s** · fast **69 s**; at 0 ms the port lookup never answers, so `fast` keeps 25 ms |
| Sharding | 2 shards over 2 sheets, one workbook | one run with both sheets (40 fields checked each), shard 2 `joined the workbook after 1 attempt(s)`, 144 s wall clock |
| Field history | `node --test dashboard/db.test.mjs` (7/7) plus the History dialog against the real `test 2` history | `Gross Rate — 2/4 runs, 12 times, sheets 2,9,10,11,12,14,15` |
| Preflight | a real pass, and a real failure | pass: 4/4 checks; failure: `app reachable: ERR_CONNECTION_REFUSED` while the app was down, which is exactly what killed a 2-shard run at login |
