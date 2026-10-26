# VoyageCalc — Visual Playwright Suite

Target: **https://cozy-crafting-cloud.lovable.app/** (VoyageCalc maritime estimator)

## What it covers

| File | What it tests |
|---|---|
| `tests/auth-gate.spec.ts` | Login wall renders (no creds needed), empty-submit stays put |
| `tests/vessel-search.spec.ts` | `Search vessel...` → backend dropdown (e.g. **FUGA**, IMO/DWT) → select hydrates DWT; manual-entry option |
| `tests/sequence-ports.spec.ts` | `Select port...` → backend dropdown (e.g. **Riau / IDRAU**, `hu` → Huachipato/CLHPO) → select; **Add** appends a port row; empty `disch` row shows `aria-invalid` + `ring-destructive`; Add/Repos/Fetch-distance/Dep controls |
| `tests/input-validation.spec.ts` | Eco speed required (`Speed must be greater than 0`), junk in numeric fields, Scrubbers/Speed-Profile/L=D=I, GTC/NTC input behavior + live validation map (save-triggered flags), sea-time summary |
| `tests/cargo-misc-bunker.spec.ts` | **Add Cargo** appends entry (#2); Cargo rate/commission/demurrage/despatch/charterer, Misc costs + canal time/fuel (HSFO disabled), BOB/ETS/wind-reward, Notes |
| `tests/save-sheet.spec.ts` | Toolbar **Save** → dialog (name + workbook picker incl. testing -a, Cancel = no save); footer **Save Sheet** saves directly (`Sheet saved` toast); dialog-driven real save opt-in via `SAVE_SHEETS=1` |
| `tests/visual-full.spec.ts` | Viewport + full-page + per-card screenshots (Vessel, Sequence, Cargo, Bunker, Notes) |
| `tests/full-voyage.spec.ts` | Full sheet E2E: FUGA + speeds/consumption, 4 real ports (Singapore → Tubarao → Qingdao → Santos) + Durban **Repos** leg, cargo #2 with demurrage/despatch, **Intake Calculator** (Update Intake), misc/canal, bunker/ETS, balanced load=discharge, zero-item Voyage Summary, save |
| `tests/real-sheet.spec.ts` | One legit hand-built sheet: FUGA loads 35,000 MT at Tubarao, discharges 20,000 + 15,000 (SUM-equal), custom per-leg coefficient factors (1.05/1.02/0.98), sea margins, intake calculator + Update Intake, zero-item summary, saved into `testing -a` |
| `tests/random-sheets.spec.ts` | Seeded randomized sheets (`RANDOM_SEED`, `RANDOM_SHEETS`, default 3): random vessel (FUGA/OCEAN/… with fallback), random real ports, random extra/Add/Repos legs, quantities balanced, random cargo/intake/misc/bunker, each saved via dialog as `Random <seed>-<n>`; evidence in `test-results/random-sheets.json` |
| `tests/automation-workbooks.spec.ts` | Sharded 32-sheet run: creates `SHARDS` workbooks (`WORKBOOK_NAME`, default `automation test <stamp>-A/B/C…`) via **New Workbook** → name → **Create** → **Open**, each filled with valid randomized sheets (DWT-capped load, split discharge, per-row rates, zero `needs attention`) and quick-saved; evidence in `test-results/automation-workbooks-<shard>.json` |
| `tests/summary-compare.spec.ts` | Browser-free unit tests for the Voyage Summary comparison: amount vs rate tolerance, per-field overrides, exact text, EU/UK repeated labels, missing rows, config parsing |
| `tests/fuzz-*.spec.ts` | Hostile-payload fuzz (letters/symbols/groupings/empties) over vessel/misc/bunker (A), sequence/cargo (B), and decimal torture (C: 27–30dp, float traps, locale commas, double extremes) — 0 crashes/NaN expected; evidence in `test-results/fuzz-{a,b,c}.json` |

Screenshots land in `screenshots/` (git-ignored). Video + trace are kept on failure.

## Test console (browser UI)

```bash
npm run dashboard        # http://127.0.0.1:4317
```

A local page for running the sheet replays without the command line:

- **Folders** on the left list every folder holding JSON sheets, plus empty folders created with **+** (they show `0` until a sheet is added, and can be renamed or deleted like any other); expected-output folders are detected and kept out of that list.
- **Sheets** — run one sheet or the whole folder, edit or duplicate a sheet in a JSON editor with live validation, import a file, rename, delete.
- **Outputs** — pick the default expected-output folder, map any input sheet to any output file in the project, and see coverage for the chosen folder ("18/18 mapped"). Each row shows whether its output is ready, empty, missing or absent.
- **Allowed difference** — two group defaults plus per-field overrides, because a cent of drift on a summed total is not the same as a cent on a per-mt rate. **Amounts (±)** covers currency totals (default `0.5`) and **Rates & quantities (±)** covers per-mt rates, ratios, tonnes and days (default `0.01`). **Per-field allowed difference** lists every Voyage Summary field with its expected-output path: leave a box blank to use the group default, type `0` for an exact match, and clear it to go back. Text fields such as the CII rating are always exact. All of it is saved with the mapping and shown on every run.
- **Add output** creates an output file straight from a sheet row: blank, copied from an existing output, or pasted JSON. **Delete file** removes an output again and unmaps it. A sheet with no output is reported as a failure, never a silent pass.
- **Workbooks** — a named test that combines sheets from any folder: give it a name, add sheets from each folder, set the run order, and run it. The name is also given to the workbook the run creates in the app. Workbooks are saved as JSON in `workbooks/`, so the same test can be re-run or versioned.
- **Notes** — a comment per sheet inside one test, for sheets that fail on purpose. Tick **expected to fail** and the sheet carries a `known failure` note into every run view, so a known failure is not read as a regression.
- **History** — every finished run is stored per test, with what each sheet did. The History dialog shows, per sheet, how many runs it has been through and how many it failed (a sheet that failed 5 of 5 reads `always fails`, 2 of 5 reads `flaky`), the fields that failed last time, and its note. Runs written before this existed are imported from `history.json` on first start.
- **Runs** — live progress per sheet (saved / failed), every mismatch as Field · Expected · Actual, the execution log, and a **Kill run** button (top bar and run summary). It terminates Playwright *and* the browser it opened: SIGTERM to the process group, SIGKILL if the browser ignores it, and a fallback that settles the run even if the child never reports back. A killed run is recorded as `stopped` rather than failed, with its log kept.

Keep **Watch browser** on. The app only returns port suggestions to a visible browser, so a headless run stalls at the first port with `no backend suggestion for …` even though the same sheet passes headed.

The **Watch browser** switch runs headed Chrome (`chrome` project) instead of headless Chromium. Runs use `REPLAY_DIR` for a folder, `REPLAY_FILE` for a single sheet and `REPLAY_LIST` for a workbook (with `WORKBOOK_NAME` naming the app workbook), plus `SUMMARY_MAP` for per-sheet output mappings and `SUMMARY_TOLERANCES` (a file of `{ amount, rate, fields }`) for the allowed differences. The older single `SUMMARY_TOLERANCE` value still works and applies to every number.

Notes and run history live in a local SQLite database, `dashboard/state.db`, through Node's built-in `node:sqlite` — no server to run and no dependency to install. It is git-ignored; delete the file to start the history over.

The field table lives in [dashboard/summary-fields.json](dashboard/summary-fields.json) — label, expected-output path and kind (`money`, `quantity`, `rate`, `text`) — and is shared by the replay and the dashboard's per-field list. The comparison itself is a pure function in [tests/summary-compare.ts](tests/summary-compare.ts) with browser-free tests in [tests/summary-compare.spec.ts](tests/summary-compare.spec.ts):

```bash
npx playwright test tests/summary-compare.spec.ts --project=chromium-headless
node --test dashboard/db.test.mjs        # notes + workbook history storage
```

The replay fills the bunker card's **EU ETS price** and **UK ETS price** from `bunker.euEtsPrice` / `bunker.ukEtsPrice`, and re-asserts the UK price after the rest of the card settles. UK ETS only applies to ports flagged as UK: the backend returns same-name ports in several countries, so `Belfast` and `Bristol` are pinned to the United Kingdom (the US rows leave UK CO2 at zero).

Screenshots land in `screenshots/` (git-ignored). Video + trace are kept on failure.

## Run it (opens real Chrome)

```bash
cp .env.example .env   # optional: add VOYAGE_EMAIL + VOYAGE_PASSWORD
npm install
npx playwright install chrome   # one-time: real Google Chrome for Playwright
npm run test:chrome              # headed Chrome, slow-mo, list reporter
```

Other commands:

```bash
npm test              # headless Chromium (CI-friendly)
npm run test:headed   # same as test:chrome
npm run test:debug    # headed Chrome with the Playwright debugger attached
npx playwright test tests/vessel-search.spec.ts --headed --project=chrome
npx playwright test tests/auth-gate.spec.ts --project=chromium-headless
npx playwright test tests/suite.spec.ts --project=chromium-headless --workers=1 --reporter=list
npx playwright test tests/functional.spec.ts --project=chromium-headless --workers=1 --reporter=list
npm run report         # open HTML report
npm run codegen        # record new steps against the live site
```

Per-file / per-group:

```bash
# Single spec file, headed Chrome
npx playwright test tests/vessel-search.spec.ts --headed --project=chrome --reporter=list
npx playwright test tests/sequence-ports.spec.ts --project=chrome --reporter=list
npx playwright test tests/input-validation.spec.ts --project=chrome --reporter=list
npx playwright test tests/cargo-misc-bunker.spec.ts --project=chrome --reporter=list
npx playwright test tests/save-sheet.spec.ts --project=chrome --reporter=list
npx playwright test tests/visual-full.spec.ts --project=chrome --reporter=list
npx playwright test tests/full-voyage.spec.ts --project=chrome --reporter=list
npx playwright test tests/real-sheet.spec.ts --project=chrome --reporter=list
npx playwright test tests/random-sheets.spec.ts --project=chrome --reporter=list
npx playwright test tests/automation-workbooks.spec.ts --project=chrome --reporter=list
npx playwright test tests/fuzz-vessel-bunker.spec.ts --project=chromium-headless --reporter=list
npx playwright test tests/fuzz-sequence-cargo.spec.ts --project=chromium-headless --reporter=list
npx playwright test tests/fuzz-decimals.spec.ts --project=chromium-headless --reporter=list

# Single spec file, headless Chromium
npx playwright test tests/vessel-search.spec.ts --project=chromium-headless --reporter=list
npx playwright test tests/sequence-ports.spec.ts --project=chromium-headless --reporter=list
npx playwright test tests/input-validation.spec.ts --project=chromium-headless --reporter=list
npx playwright test tests/cargo-misc-bunker.spec.ts --project=chromium-headless --reporter=list
npx playwright test tests/save-sheet.spec.ts --project=chromium-headless --reporter=list
npx playwright test tests/visual-full.spec.ts --project=chromium-headless --reporter=list
npx playwright test tests/full-voyage.spec.ts --project=chromium-headless --reporter=list
npx playwright test tests/real-sheet.spec.ts --project=chromium-headless --reporter=list
npx playwright test tests/random-sheets.spec.ts --project=chromium-headless --reporter=list
npx playwright test tests/automation-workbooks.spec.ts --project=chromium-headless --reporter=list
npx playwright test tests/fuzz-vessel-bunker.spec.ts --project=chromium-headless --reporter=list
npx playwright test tests/fuzz-sequence-cargo.spec.ts --project=chromium-headless --reporter=list
npx playwright test tests/fuzz-decimals.spec.ts --project=chromium-headless --reporter=list
npx playwright test tests/suite.spec.ts --project=chromium-headless --workers=1 --reporter=list
npx playwright test tests/functional.spec.ts --project=chromium-headless --workers=1 --reporter=list

# Single test by title substring
npx playwright test tests/vessel-search.spec.ts -g "pick backend suggestion" --project=chrome --reporter=list
npx playwright test tests/sequence-ports.spec.ts -g "Add button appends" --project=chrome --reporter=list
npx playwright test tests/save-sheet.spec.ts -g "quick Save Sheet saves directly" --project=chrome --reporter=list
npx playwright test tests/full-voyage.spec.ts -g "complete sheet" --project=chrome --reporter=list
npx playwright test tests/real-sheet.spec.ts -g "legit balanced voyage" --project=chrome --reporter=list
npx playwright test tests/random-sheets.spec.ts -g "randomized sheets" --project=chrome --reporter=list
npx playwright test tests/suite.spec.ts -g "Unit test" --project=chromium-headless --workers=1 --reporter=list
npx playwright test tests/functional.spec.ts -g "FT-001" --project=chromium-headless --workers=1 --reporter=list
```

```bash
# All specs at once, headed Chrome (one worker — drives the visible browser)
npx playwright test --headed --project=chrome --workers=1 --reporter=list
# All specs at once, headless Chromium
npx playwright test --project=chromium-headless --reporter=list
# All specs at once, headless Chromium, 10 parallel workers
PW_WORKERS=10 npx playwright test --project=chromium-headless --workers=10 --reporter=list
```

## Speed: parallel workers + sharding

File-level tests already parallelize across workers (default **4** locally,
2 on CI — override with `PW_WORKERS=N`). The 32-sheet spec additionally
shards into `SHARDS` parallel tests with one workbook each.

```bash
# 10 parallel workers — everything headless
PW_WORKERS=10 npx playwright test --project=chromium-headless --workers=10 --reporter=list

# A single heavy file with 10 workers (e.g. the sharded automation spec)
PW_WORKERS=10 npx playwright test tests/automation-workbooks.spec.ts --project=chromium-headless --workers=10 --reporter=list

# 30 valid sheets, headless — 3 workbooks x 10 sheets in parallel (~8 min)
SHEETS=30 SHARDS=3 PW_WORKERS=3 npx playwright test tests/automation-workbooks.spec.ts --project=chromium-headless --reporter=line

# The same 30 sheets in ONE workbook, watchable in real Chrome (~25 min)
SHEETS=30 SHARDS=1 npx playwright test tests/automation-workbooks.spec.ts --project=chrome --workers=1 --reporter=list
```

Rules of thumb: keep `SHARDS <= PW_WORKERS` (a shard per worker), one
workbook per shard (no shared-state races), headed Chrome runs stay at
1 worker since they drive the visible browser.

A workbook is capped at **50 sheets** by the backend, and each saved sheet
is one row, so keep `PER_SHARD` (`= ceil(SHEETS / SHARDS)`) well under it.
The spec creates a unique workbook name per run and suffixes a duplicate
name with `r2`, `r3`, … — otherwise it would reopen an older, possibly full
workbook and every save would 409 while still showing "Sheet saved".

## Auth + navigation flow

The app shows a **Welcome back / Login** gate, then a dashboard. With
`VOYAGE_EMAIL` + `VOYAGE_PASSWORD` in `.env`, `ensureCalculator()` signs in,
dismisses the MFA upsell (Remind me later), opens **Voyage Estimator** →
workbook **testing -a** → **Open**, and waits for `Search vessel...`.
Without credentials only `auth-gate` runs — the rest skip with a message.

Verified live: vessel `FUGA` → IMO 9624615 → DWT **38036** hydrates the
vessel card; port search hits `/ports/search`. Type slowly (250 ms/char)
and wait for the final `q=…` response — fast typing races the debounced
backend search and renders a stale "No vessels found".
