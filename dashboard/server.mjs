import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createStore, importLegacyRuns } from './db.mjs';

/**
 * Local test console for the VoyageCalc Playwright suite.
 *
 * Serves a single-page UI and drives `playwright test tests/oct21-json-replay.spec.ts`
 * with REPLAY_DIR (folder run) or REPLAY_FILE (single sheet run). Results come from the
 * spec's own log lines: "--- sheet N/M", "saved sheet N/M", "MISMATCH …" and
 * "… Voyage Summary N checked, M mismatch(es)".
 */

const ROOT = process.env.DASHBOARD_ROOT ? resolve(process.env.DASHBOARD_ROOT) : process.cwd();
const PUBLIC = join(ROOT, 'dashboard', 'public');
const DATA = join(ROOT, 'dashboard');
const PORT = Number(process.env.DASHBOARD_PORT ?? 4317);
const HOST = '127.0.0.1';

const IGNORE_DIRS = new Set([
  'node_modules',
  'test-results',
  'playwright-report',
  '.git',
  '.freebuff',
  'dashboard',
  'reports',
  'screenshots',
  // Saved test definitions live here; they are not sheets.
  'workbooks',
  '.cache',
]);

// Shape of an expected-output file (the Voyage Summary groups), used when one is created blank.
const OUTPUT_TEMPLATE = {
  hire: { incl_hire: 0, excl_hire: 0 },
  time: { ballast_days: 0, laden_days: 0, at_sea_days: 0, in_port_canal_days: 0, total_time_days: 0 },
  cargo_economics: {
    ntce: 0,
    gtce: 0,
    cargo_1_gross_rate_per_mt: 0,
    cargo_1_quantity_mt: 0,
    pnl: 0,
    pnl_per_day: 0,
    net_freight: 0,
    gross_freight: 0,
    bunker_cost: 0,
    total_hsfo_t: 0,
    hsfo_for_eu_ets_fuel_eu_t: 0,
    total_vlsfo_t: 0,
    vlsfo_for_eu_ets_fuel_eu_t: 0,
    total_lsmgo_t: 0,
    lsmgo_for_eu_ets_fuel_eu_t: 0,
  },
  environmental: { eeoi_gco2_per_tnm: 0, aer_cii_gco2_per_dwtnm: 0, estimated_voyage_cii_rating: 'D' },
  eu_ets: {
    total_co2_t: 0,
    total_co2_cost: 0,
    eua_co2_t: 0,
    total_eua_co2_cost: 0,
    co2_cost_per_t: 0,
    eua_freight_impact_per_mt: 0,
    apply_eua_freight_impact: false,
    warnings: [],
  },
  uk_ets: {
    uk_co2_t: 0,
    total_uk_ets_co2_cost: 0,
    co2_cost_per_t: 0,
    uk_ets_freight_impact_per_mt: 0,
    apply_uk_ets_freight_impact: false,
  },
  fuel_eu_maritime: {
    wind_reward_factor: 1,
    hsfo_fuel_eu_penalty: 0,
    hsfo_penalty_per_t: 0,
    vlsfo_fuel_eu_penalty: 0,
    vlsfo_penalty_per_t: 0,
    lsmgo_fuel_eu_penalty: 0,
    lsmgo_penalty_per_t: 0,
    total_fuel_eu_cost: 0,
    fuel_eu_freight_impact_per_mt: 0,
    apply_fuel_eu_freight_impact: false,
  },
};

const MAPPING_FILE = join(DATA, 'mapping.json');
const HISTORY_FILE = join(DATA, 'history.json');
// Folders created from the UI. They are remembered because a folder with no sheets yet cannot be
// discovered by scanning for JSON files — but it still has to show up (and be deletable) in the list.
const FOLDERS_FILE = join(DATA, 'folders.json');
// SQLite: per-sheet comments inside a workbook, plus the run history of each workbook.
const STATE_DB = join(DATA, 'state.db');
// A workbook is one named test: an ordered list of sheets that may come from any folder.
const WORKBOOK_DIR = join(ROOT, 'workbooks');
const LOG_DIR = join(DATA, 'logs');

// ---------------------------------------------------------------- helpers

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const toRel = (abs) => relative(ROOT, abs).split(sep).join('/');

/** Resolves a path from the UI and refuses anything outside the project. */
function safePath(rel) {
  if (typeof rel !== 'string' || rel.trim() === '') throw new HttpError(400, 'path is required');
  if (isAbsolute(rel)) throw new HttpError(400, 'path must be relative to the project');
  const abs = resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) throw new HttpError(400, 'path escapes the project');
  return abs;
}

const isJsonFile = (name) => name.endsWith('.json') && !name.startsWith('.');

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// Allowed difference between an expected number and the one on screen.
// Amounts are currency totals summed from rounded figures, so they get slack; rates, ratios and
// quantities stay tight. "fields" overrides both, keyed by the expected-output path of the field.
const DEFAULT_TOLERANCE = { amount: 0.5, rate: 0.01, fields: {} };

const tolNum = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

function normaliseTolerance(raw, legacyAmount) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const fields = {};
  for (const [path, value] of Object.entries(src.fields && typeof src.fields === 'object' ? src.fields : {})) {
    if (!path) continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) fields[path] = n;
  }
  return {
    // An older global value becomes the amount default; rates and quantities start tight.
    amount: tolNum(src.amount, legacyAmount ?? DEFAULT_TOLERANCE.amount),
    rate: tolNum(src.rate, DEFAULT_TOLERANCE.rate),
    fields,
  };
}

/** The Voyage Summary field table the replay also uses (label, expected path, kind). */
async function summaryFields() {
  return readJson(join(ROOT, 'dashboard', 'summary-fields.json'), []);
}

async function mapping() {
  const cfg = await readJson(MAPPING_FILE, {});
  // An older mapping held one global value; it becomes the default for both groups.
  const legacy = cfg.summaryTolerance === undefined ? undefined : tolNum(cfg.summaryTolerance, undefined);
  return {
    defaultOutputDir: typeof cfg.defaultOutputDir === 'string' ? cfg.defaultOutputDir : 'sheets/ballast-op',
    outputs: cfg.outputs && typeof cfg.outputs === 'object' ? cfg.outputs : {},
    tolerance: normaliseTolerance(cfg.tolerance, legacy),
    fields: await summaryFields(),
  };
}

/** Counts the sheets in a file: the spec accepts one sheet object or an array of them. */
function sheetCount(parsed) {
  if (Array.isArray(parsed)) return parsed.length;
  return parsed && typeof parsed === 'object' ? 1 : 0;
}

async function describeSheet(abs) {
  const info = await stat(abs);
  let count = 0;
  let broken = false;
  let format = 'input';
  try {
    const parsed = JSON.parse(await readFile(abs, 'utf8'));
    count = sheetCount(parsed);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    // Expected-output files hold the Voyage Summary groups instead of the sheet inputs.
    if (first && typeof first === 'object' && ('cargo_economics' in first || 'hire' in first)) format = 'expected';
  } catch {
    broken = true;
  }
  return { name: basename(abs), path: toRel(abs), size: info.size, mtime: info.mtimeMs, sheets: count, broken, format };
}

async function listJsonFiles(absDir) {
  const names = (await readdir(absDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && isJsonFile(e.name))
    .map((e) => e.name);
  const files = [];
  for (const name of names) files.push(await describeSheet(join(absDir, name)));
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return files;
}

/** Folder paths created through the dashboard, so empty ones stay visible. */
async function trackedFolders() {
  const data = await readJson(FOLDERS_FILE, { folders: [] });
  const list = Array.isArray(data) ? data : (data.folders ?? []);
  return [...new Set(list.filter((p) => typeof p === 'string' && p.trim() !== ''))];
}

async function setTrackedFolders(list) {
  await writeJson(FOLDERS_FILE, { folders: [...new Set(list)].sort() });
}

async function trackFolder(relPath) {
  const list = await trackedFolders();
  if (!list.includes(relPath)) await setTrackedFolders([...list, relPath]);
}

/** Forgets a folder and anything created inside it. */
async function untrackFolder(relPath) {
  const list = await trackedFolders();
  const keep = list.filter((p) => p !== relPath && !p.startsWith(`${relPath}/`));
  if (keep.length !== list.length) await setTrackedFolders(keep);
}

async function retrackFolder(from, to) {
  const list = await trackedFolders();
  const next = list.map((p) => (p === from ? to : p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p));
  if (next.join('\n') !== list.join('\n')) await setTrackedFolders(next);
}

/** Folders (one or two levels deep) that hold JSON sheets, plus empty ones created in the UI. */
async function listFolders() {
  const folders = [];
  const top = await readdir(ROOT, { withFileTypes: true }).catch(() => []);
  for (const entry of top) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || IGNORE_DIRS.has(entry.name)) continue;
    const abs = join(ROOT, entry.name);
    const files = await listJsonFiles(abs).catch(() => []);
    if (files.length > 0) {
      const kind = files.every((f) => f.format === 'expected') ? 'outputs' : 'inputs';
      folders.push({ path: toRel(abs), name: entry.name, kind, sheets: files });
    }
    // One level deeper: sheets/<case>/sheet1.json
    const children = await readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (!child.isDirectory() || child.name.startsWith('.') || IGNORE_DIRS.has(child.name)) continue;
      const childAbs = join(abs, child.name);
      const childFiles = await listJsonFiles(childAbs).catch(() => []);
      if (childFiles.length > 0) {
        const kind = childFiles.every((f) => f.format === 'expected') ? 'outputs' : 'inputs';
        folders.push({ path: toRel(childAbs), name: `${entry.name}/${child.name}`, kind, sheets: childFiles });
      }
    }
  }
  // A folder created from the UI has no JSON files yet, so the scan above cannot find it.
  const seen = new Set(folders.map((f) => f.path));
  for (const rel of await trackedFolders()) {
    if (seen.has(rel)) continue;
    if (IGNORE_DIRS.has(rel.split('/')[0])) continue;
    const abs = resolve(ROOT, rel);
    if (abs !== ROOT && !abs.startsWith(ROOT + sep)) continue;
    const info = await stat(abs).catch(() => null);
    if (!info?.isDirectory()) continue;
    folders.push({ path: rel, name: rel, kind: 'inputs', sheets: [] });
  }
  folders.sort((a, b) => a.path.localeCompare(b.path));
  return folders;
}

/** A filesystem-safe file name for a workbook, derived from the test name the user typed. */
const slug = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'workbook';

async function listWorkbooks() {
  const names = (await readdir(WORKBOOK_DIR).catch(() => [])).filter((n) => n.endsWith('.json'));
  const out = [];
  for (const name of names.sort()) {
    const file = join(WORKBOOK_DIR, name);
    const info = await stat(file).catch(() => null);
    const raw = await readJson(file, null);
    if (!info || !raw) {
      out.push({ file: toRel(file), name: name.replace(/\.json$/, ''), sheets: [], broken: true, mtime: info?.mtimeMs ?? 0 });
      continue;
    }
    out.push({
      file: toRel(file),
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : name.replace(/\.json$/, ''),
      sheets: Array.isArray(raw.sheets) ? raw.sheets : [],
      broken: false,
      mtime: info.mtimeMs,
    });
  }
  return out.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
}

/** Validates the sheet paths of a workbook; every entry must be a real JSON file. */
function validateWorkbookSheets(sheets) {
  if (!Array.isArray(sheets) || sheets.length === 0) throw new HttpError(400, 'A workbook needs at least one sheet');
  const paths = [];
  for (const entry of sheets) {
    const rel = typeof entry === 'string' ? entry : entry?.path;
    const abs = safePath(rel);
    if (!abs.endsWith('.json')) throw new HttpError(400, `${rel} is not a JSON sheet`);
    if (!existsSync(abs)) throw new HttpError(400, `${rel} does not exist`);
    paths.push({ path: toRel(abs), index: typeof entry === 'object' ? entry.index : undefined });
  }
  return paths;
}

/** Every expected-output file in the project, grouped by folder, for the mapping selects. */
async function expectedFiles() {
  const out = [];
  for (const folder of await listFolders()) {
    if (folder.kind !== 'outputs') continue;
    for (const file of folder.sheets) {
      out.push({ path: file.path, name: file.name, folder: folder.path, size: file.size, broken: file.broken });
    }
  }
  return out;
}

function validateExpected(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new HttpError(400, `Invalid JSON: ${e.message}`);
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || typeof first !== 'object') throw new HttpError(400, 'An expected output must be a JSON object');
  // Catch an input sheet being saved as an expectation by mistake.
  if (!('cargo_economics' in first) && !('hire' in first)) {
    throw new HttpError(400, 'That JSON is not expected-output shaped (needs cargo_economics or hire)');
  }
}

// ---------------------------------------------------------------- runs

const runs = new Map();
let activeRunId = null;
let history = [];

const newestFirst = (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0);

async function loadHistory() {
  const saved = await readJson(HISTORY_FILE, []);
  history = Array.isArray(saved) ? saved.sort(newestFirst).slice(0, 20) : [];
  // Seed the database with runs recorded before it existed, so workbook history is complete.
  try {
    const pathsByName = {};
    for (const wb of await listWorkbooks()) pathsByName[wb.name] = wb.sheets.map((s) => s.path ?? s);
    importLegacyRuns(store, history, pathsByName);
  } catch (err) {
    console.error(`Could not import earlier runs into ${STATE_DB}: ${err.message}`);
  }
}

const store = createStore(STATE_DB);

async function saveHistory() {
  const entry = (run) => ({
    id: run.id,
    target: run.target,
    path: run.path,
    name: run.name ?? null,
    tolerance: run.tolerance ?? null,
    headed: run.headed,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    total: run.total,
    checked: run.sheets.reduce((n, s) => n + (s.checked ?? 0), 0),
    mismatchCount: run.sheets.reduce((n, s) => n + s.mismatches.length, 0),
    error: run.error ?? null,
    // Keep the per-sheet results so a reload can restore the last run, not just a one-line summary.
    sheets: run.sheets.map((s) => ({
      index: s.index,
      vessel: s.vessel,
      path: run.sheetPaths?.[s.index - 1] ?? null,
      status: s.status,
      checked: s.checked ?? null,
      mismatches: s.mismatches,
      notes: s.notes ?? [],
    })),
  });
  const done = [...runs.values()].filter((r) => r.status !== 'running').map(entry);
  const merged = [...done, ...history.filter((h) => !done.some((d) => d.id === h.id))].slice(0, 20);
  history = merged.sort(newestFirst);
  await writeJson(HISTORY_FILE, history);
}

function publicRun(run) {
  return {
    id: run.id,
    target: run.target,
    path: run.path,
    name: run.name ?? null,
    tolerance: run.tolerance ?? null,
    headed: run.headed,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    exitCode: run.exitCode,
    total: run.total,
    current: run.current,
    notes: run.notes,
    error: run.error ?? null,
    logSize: run.log.length,
    sheets: run.sheets.map((s) => ({
      index: s.index,
      vessel: s.vessel,
      path: run.sheetPaths?.[s.index - 1] ?? null,
      status: s.status,
      checked: s.checked,
      mismatches: s.mismatches,
    })),
  };
}

function sheetFor(run, index, vessel) {
  let sheet = run.sheets.find((s) => s.index === index);
  if (!sheet) {
    sheet = { index, vessel: vessel ?? '', status: 'running', checked: null, mismatches: [], notes: [] };
    run.sheets.push(sheet);
    run.sheets.sort((a, b) => a.index - b.index);
  }
  if (vessel && !sheet.vessel) sheet.vessel = vessel;
  return sheet;
}

/** Turns one line of spec output into run state. Only column-0 lines are parsed. */
function parseLine(run, raw) {
  const line = raw.replace(/\r$/, '');
  let m;

  // Playwright indents the thrown error line; record the first one before the indent guard below.
  // Assertion summaries are not run errors: a finished run with mismatches reports those separately.
  if ((m = /^\s*Error: (.+)$/.exec(line)) && !run.error && !/^(fields that did not keep|missing fields:|app errors:)/.test(m[1])) {
    run.error = m[1].slice(0, 300);
  }

  if (line !== line.trimStart()) return; // other indented lines repeat text already handled

  if ((m = /^--- sheet (\d+)\/(\d+): (.+)$/.exec(line))) {
    run.total = Number(m[2]);
    run.current = { index: Number(m[1]), vessel: m[3], of: Number(m[2]) };
    sheetFor(run, Number(m[1]), m[3]);
    return;
  }

  if ((m = /^saved sheet (\d+)\/(\d+)$/.exec(line))) {
    const sheet = sheetFor(run, Number(m[1]));
    // A sheet that saved but did not match its output is a failure, not a pass.
    if (sheet.status === 'running') sheet.status = sheet.mismatches.length ? 'failed' : 'saved';
    run.current = { index: Number(m[1]), vessel: sheet.vessel, of: Number(m[2]) };
    return;
  }

  if (line.startsWith('MISMATCH ')) {
    parseMismatch(run, line.slice('MISMATCH '.length));
    return;
  }

  if ((m = /^sheet (\d+) (.*?): Voyage Summary (\d+) checked, (\d+) mismatch/.exec(line))) {
    const sheet = sheetFor(run, Number(m[1]), m[2]);
    sheet.checked = Number(m[3]);
    sheet.summaryCount = Number(m[4]);
    return;
  }

  if ((m = /^sheet (\d+) (.*?): (no expected summary .*|expected summary could not be read .*)$/.exec(line))) {
    const sheet = sheetFor(run, Number(m[1]), m[2]);
    (sheet.notes ??= []).push(m[3]);
    return;
  }

  if (/not settled on pass \d+/.test(line)) {
    const idx = run.current?.index ?? 0;
    (sheetFor(run, idx).notes ??= []).push(line.trim());
    return;
  }

  if (/no save confirmation on attempt/.test(line)) {
    const idx = run.current?.index ?? 0;
    (sheetFor(run, idx).notes ??= []).push(line.trim());
    return;
  }

}

function parseMismatch(run, text) {
  const head = /^sheet (\d+) (.*)$/.exec(text);
  if (!head) {
    run.notes.push(text);
    return;
  }
  const index = Number(head[1]);
  const rest = head[2];
  const sheet = sheetFor(run, index);
  const tail = sheet.vessel && rest.startsWith(`${sheet.vessel} `) ? rest.slice(sheet.vessel.length + 1) : rest;

  const wantedAt = tail.lastIndexOf(': wanted ');
  if (wantedAt > 0) {
    const gotMatch = /^(.*), got (.*)$/.exec(tail.slice(wantedAt + 9));
    const field = tail.slice(0, wantedAt);
    if (gotMatch) {
      sheet.mismatches.push({ field, expected: gotMatch[1], actual: gotMatch[2] });
      return;
    }
  }
  const notFound = /^(.*?): (row not found in Voyage Summary)$/.exec(tail);
  if (notFound) {
    sheet.mismatches.push({ field: notFound[1], expected: '(row present)', actual: notFound[2] });
    return;
  }
  sheet.mismatches.push({ field: tail, expected: '', actual: '' });
}

async function startRun({ target, path, headed }) {
  if (activeRunId) throw new HttpError(409, 'A run is already in progress. Stop it or wait for it to finish.');
  if (!['folder', 'sheet', 'workbook'].includes(target)) throw new HttpError(400, 'target must be "folder", "sheet" or "workbook"');
  const abs = safePath(path);
  if (!existsSync(abs)) throw new HttpError(404, `${path} does not exist`);
  if (target === 'folder' && !(await stat(abs)).isDirectory()) throw new HttpError(400, `${path} is not a folder`);
  if (target === 'sheet' && !(await stat(abs)).isFile()) throw new HttpError(400, `${path} is not a file`);

  // A workbook run: one named test over an ordered list of sheets from any folder.
  let workbook = null;
  if (target === 'workbook') {
    const raw = await readJson(abs, null);
    if (!raw) throw new HttpError(400, `${path} is not a readable workbook`);
    workbook = {
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : basename(abs, '.json'),
      sheets: validateWorkbookSheets(raw.sheets),
    };
  }

  const cfg = await mapping();
  const env = { ...process.env, SLOW_MO: String(process.env.SLOW_MO ?? 150) };
  delete env.REPLAY_DIR;
  delete env.REPLAY_FILE;
  delete env.REPLAY_LIST;
  delete env.WORKBOOK_NAME;
  delete env.SUMMARY_MAP;
  if (target === 'folder') env.REPLAY_DIR = path;
  else if (target === 'sheet') env.REPLAY_FILE = path;
  else {
    const listFile = join(DATA, '.replay-list.json');
    await writeJson(listFile, { name: workbook.name, sheets: workbook.sheets });
    env.REPLAY_LIST = listFile;
    // The app workbook is named after the test, not a timestamp.
    env.WORKBOOK_NAME = workbook.name;
  }

  // Expected outputs: one default folder, plus any per-sheet mapping the user saved.
  env.SUMMARY_DIR = cfg.defaultOutputDir || 'sheets/ballast-op';
  const tolFile = join(DATA, '.summary-tolerances.json');
  await writeJson(tolFile, cfg.tolerance);
  env.SUMMARY_TOLERANCES = tolFile;
  // A sheet with no expected output is a failure, not a silent pass.
  env.REQUIRE_EXPECTED = '1';
  const targets =
    target === 'folder'
      ? Object.keys(cfg.outputs).filter((input) => dirname(input) === path)
      : target === 'sheet'
        ? [path]
        : workbook.sheets.map((entry) => entry.path);
  const outputs = {};
  for (const input of targets) if (cfg.outputs[input]) outputs[input] = cfg.outputs[input];
  const mapFile = join(DATA, '.summary-map.json');
  await writeJson(mapFile, outputs);
  env.SUMMARY_MAP = mapFile;

  const id = randomUUID();
  const run = {
    id,
    target,
    path,
    name: workbook?.name ?? null,
    tolerance: cfg.tolerance,
    headed: Boolean(headed),
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    total: null,
    current: null,
    notes: [],
    error: null,
    sheets: [],
    // Sheet index (1-based) -> file, so history can say which sheet failed.
    sheetPaths: workbook ? workbook.sheets.map((entry) => entry.path) : target === 'sheet' ? [path] : [],
    log: '',
    buffer: '',
    child: null,
    stopRequested: false,
  };
  runs.set(id, run);
  activeRunId = id;

  const args = [
    'playwright',
    'test',
    'tests/oct21-json-replay.spec.ts',
    '--project',
    run.headed ? 'chrome' : 'chromium-headless',
    '--workers=1',
    '--reporter=list',
  ];
  const child = spawn('npx', args, { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  run.child = child;

  const onChunk = (chunk) => {
    const text = chunk.toString();
    run.log += text;
    if (run.log.length > 2_000_000) run.log = run.log.slice(-1_500_000);
    run.buffer += text;
    let nl;
    while ((nl = run.buffer.indexOf('\n')) >= 0) {
      const line = run.buffer.slice(0, nl);
      run.buffer = run.buffer.slice(nl + 1);
      // A parser bug must never take the dashboard down mid-run.
      try {
        parseLine(run, line);
      } catch (err) {
        run.notes.push(`log parse error: ${err.message}`);
      }
    }
  };
  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);

  const finish = async (code) => {
    // A killed run is 'stopping' and must still be settled: log written, history saved.
    if (run.status !== 'running' && run.status !== 'stopping') return;
    run.exitCode = code;
    run.finishedAt = Date.now();
    run.status = run.stopRequested ? 'stopped' : code === 0 ? 'passed' : 'failed';
    for (const sheet of run.sheets) {
      // A sheet cut off by a kill is 'stopped', not a failed comparison.
      if (sheet.status === 'running') sheet.status = run.status === 'passed' ? 'saved' : run.status === 'stopped' ? 'stopped' : 'failed';
    }
    activeRunId = null;
    await mkdir(LOG_DIR, { recursive: true });
    await writeFile(join(LOG_DIR, `${id}.log`), run.log, 'utf8').catch(() => {});
    await saveHistory();
    try {
      store.recordRun(run);
    } catch (err) {
      run.notes.push(`history not saved: ${err.message}`);
    }
  };

  child.on('close', (code) => void finish(code ?? 1));
  child.on('error', async (err) => {
    run.notes.push(`Could not start Playwright: ${err.message}`);
    await finish(1);
  });

  return id;
}

/**
 * Kills a run's whole process tree (Playwright plus the browser it launched).
 * Safe to call twice: a second kill just escalates or reports the current state.
 */
function stopRun(id) {
  const run = runs.get(id);
  if (!run) throw new HttpError(404, 'Unknown run');
  if (run.status !== 'running' && run.status !== 'stopping') return { status: run.status, alreadyStopped: true };

  run.stopRequested = true;
  const wasStopping = run.status === 'stopping';
  run.status = 'stopping';

  const kill = (signal) => {
    const pid = run.child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal); // the child leads its own group, so this takes Chrome with it
    } catch {
      try {
        run.child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  };

  kill('SIGTERM');
  // A browser that ignores SIGTERM must not leave the dashboard stuck on "stopping".
  setTimeout(() => kill('SIGKILL'), 3000);
  // Last resort: if the child never reports close at all, settle the run anyway.
  setTimeout(() => {
    if (run.status !== 'stopping') return;
    run.status = 'stopped';
    run.exitCode = run.exitCode ?? null;
    run.finishedAt = Date.now();
    for (const sheet of run.sheets) if (sheet.status === 'running') sheet.status = 'stopped';
    if (activeRunId === run.id) activeRunId = null;
    void (async () => {
      await mkdir(LOG_DIR, { recursive: true });
      await writeFile(join(LOG_DIR, `${run.id}.log`), run.log, 'utf8').catch(() => {});
      await saveHistory();
      try {
        store.recordRun(run);
      } catch {
        /* history is best-effort here */
      }
    })();
  }, 8000);

  return { status: 'stopping', alreadyStopped: wasStopping };
}

// ---------------------------------------------------------------- sheet / folder edits

const TEMPLATE = {
  vessel: {
    name: 'FUGA',
    dwt: 35000,
    hasScrubber: false,
    speedProfile: 'eco',
    ecoConsumption: {
      speed: { laden: 12, ballast: 13 },
      vlsfo: { idle: 2.5, load: 4, canal: 2.5, laden: 28.5, misc1: 0, misc2: 0, ballast: 28.5, discharge: 4 },
      lsmgo: { idle: 0, load: 0, canal: 0, laden: 0, misc1: 0, misc2: 0, ballast: 0, discharge: 0 },
      ae: { idle: 2.5, load: 4, canal: 2.5, laden: 28.5, misc1: 0, misc2: 0, ballast: 28.5, discharge: 4 },
      aeScrubber: { idle: 0, load: 0, canal: 0, laden: 0, misc1: 0, misc2: 0, ballast: 0, discharge: 0 },
      hsfo: { idle: 0, load: 0, canal: 0, laden: 0, misc1: 0, misc2: 0, ballast: 0, discharge: 0 },
    },
  },
  sequence: [
    { port: 'Singapore', type: 'port', quantity: 0, productivity: 0, turnTime: 0, expDa: 0, distance: 0, ecaDistance: 0, seaMargin: 5, coefficientFactor: 1, extraTime: 0, draft: 0 },
    { port: 'Tubarao', type: 'port', operation: 'loading', quantity: 30000, productivity: 8000, turnTime: 12, expDa: 8000, distance: 3000, ecaDistance: 0, seaMargin: 5, coefficientFactor: 1, extraTime: 0, draft: 12, assignedCargoIds: [1] },
    { port: 'Qingdao', type: 'port', operation: 'discharging', quantity: 30000, productivity: 8000, turnTime: 12, expDa: 8000, distance: 4000, ecaDistance: 0, seaMargin: 5, coefficientFactor: 1, extraTime: 0, draft: 12, assignedCargoIds: [1] },
    { port: 'Qingdao', type: 'repos', quantity: 0, productivity: 0, turnTime: 0, expDa: 0, distance: 0, ecaDistance: 0, seaMargin: 0, coefficientFactor: 1, extraTime: 0, draft: 0 },
  ],
  cargos: [
    { rate: 30, voyageCommission: 3.75, demurrageRate: 0, despatchRate: 0, ntcBase: 0, tcCommission: 3.75, gtcTarget: 0 },
  ],
  bunker: {
    hsfo: { price: 983, robStart: 0 },
    vlsfo: { price: 620, robStart: 0 },
    lsmgo: { price: 900, robStart: 0 },
    euEtsPrice: 90,
    ukEtsPrice: 0,
    fuelMode: 'average',
    ignoreBOB: false,
    portBunkering: [],
  },
  misc: {
    miscCost: 0,
    extraFees: 0,
    extraInsurance: 0,
    canalCost1: 0,
    extraTime: { canal1: { value: 0, unit: 'days' } },
  },
  hireRate: 100,
  vesselCost: 0,
};

function validateSheetContent(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new HttpError(400, `Invalid JSON: ${e.message}`);
  }
  const sheets = Array.isArray(parsed) ? parsed : [parsed];
  if (sheets.length === 0) throw new HttpError(400, 'The file must hold at least one sheet');
  for (const [i, sheet] of sheets.entries()) {
    if (!sheet || typeof sheet !== 'object') throw new HttpError(400, `Sheet ${i + 1} is not an object`);
    if (!sheet.vessel || typeof sheet.vessel.name !== 'string') throw new HttpError(400, `Sheet ${i + 1} needs vessel.name`);
    if (!Array.isArray(sheet.sequence) || sheet.sequence.length === 0) throw new HttpError(400, `Sheet ${i + 1} needs a sequence with at least the open leg`);
    if (!Array.isArray(sheet.cargos) || sheet.cargos.length === 0) throw new HttpError(400, `Sheet ${i + 1} needs at least one cargo`);
    if (!sheet.bunker) throw new HttpError(400, `Sheet ${i + 1} needs a bunker block`);
  }
  return { parsed, count: sheets.length };
}

async function saveSheet(relPath, content) {
  const abs = safePath(relPath);
  if (!abs.endsWith('.json')) throw new HttpError(400, 'Sheet files must end in .json');
  validateSheetContent(content);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  return toRel(abs);
}

async function uniqueName(dirAbs, name) {
  let candidate = name;
  let n = 2;
  while (existsSync(join(dirAbs, candidate))) {
    candidate = name.replace(/\.json$/, '') + `-${n++}.json`;
  }
  return candidate;
}

// ---------------------------------------------------------------- HTTP

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Request body must be JSON');
  }
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(res, urlPath) {
  const name = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = join(PUBLIC, name);
  if (!abs.startsWith(PUBLIC + sep) || !existsSync(abs)) return send(res, 404, { error: 'Not found' });
  send(res, 200, await readFile(abs), CONTENT_TYPES[extname(abs)] ?? 'application/octet-stream');
}

async function state() {
  const cfg = await mapping();
  const folders = await listFolders();
  const active = activeRunId ? runs.get(activeRunId) : null;
  return {
    root: ROOT,
    folders,
    workbooks: await listWorkbooks(),
    mapping: cfg,
    expected: await expectedFiles(),
    activeRun: active ? publicRun(active) : null,
    history,
    notes: store.allNotes(),
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  try {
    if (req.method === 'GET' && (path === '/' || path.endsWith('.js') || path.endsWith('.css') || path.endsWith('.html'))) {
      return await serveStatic(res, path);
    }

    if (req.method === 'GET' && path === '/api/state') return send(res, 200, await state());

    if (req.method === 'GET' && path === '/api/template') return send(res, 200, { template: TEMPLATE });

    if (req.method === 'GET' && path === '/api/sheet') {
      const abs = safePath(url.searchParams.get('path'));
      return send(res, 200, { path: toRel(abs), content: await readFile(abs, 'utf8'), ...(await describeSheet(abs)) });
    }

    if (req.method === 'GET' && path === '/api/files') {
      const abs = safePath(url.searchParams.get('dir'));
      return send(res, 200, { files: await listJsonFiles(abs) });
    }

    if (req.method === 'GET' && path === '/api/run') {
      const run = runs.get(url.searchParams.get('id'));
      if (!run) throw new HttpError(404, 'Unknown run');
      const from = Math.max(0, Number(url.searchParams.get('from') ?? 0));
      return send(res, 200, { run: publicRun(run), log: run.log.slice(from), offset: run.log.length });
    }

    if (req.method === 'POST' && path === '/api/sheet') {
      const body = await readBody(req);
      if (body.action === 'create') {
        const dirAbs = safePath(body.folder);
        const name = String(body.name ?? '').trim();
        if (!name) throw new HttpError(400, 'A file name is required');
        const fileName = await uniqueName(dirAbs, name.endsWith('.json') ? name : `${name}.json`);
        const content = typeof body.content === 'string' ? body.content : JSON.stringify(body.template ?? TEMPLATE, null, 2);
        validateSheetContent(content);
        const saved = await saveSheet(toRel(join(dirAbs, fileName)), content);
        return send(res, 200, { path: saved });
      }
      if (body.action === 'save') {
        return send(res, 200, { path: await saveSheet(body.path, String(body.content ?? '')) });
      }
      if (body.action === 'rename') {
        const abs = safePath(body.path);
        const name = String(body.newName ?? '').trim();
        if (!name) throw new HttpError(400, 'A new name is required');
        const target = join(dirname(abs), name.endsWith('.json') ? name : `${name}.json`);
        if (existsSync(target)) throw new HttpError(409, `${basename(target)} already exists`);
        const fromRel = toRel(abs);
        const toRelPath = toRel(target);
        await rename(abs, target);
        // Keep the sheet's expected-output mapping after a rename, or it would silently lose its check.
        const cfg = await mapping();
        if (cfg.outputs[fromRel]) {
          cfg.outputs[toRelPath] = cfg.outputs[fromRel];
          delete cfg.outputs[fromRel];
          await writeJson(MAPPING_FILE, cfg);
        }
        return send(res, 200, { path: toRelPath });
      }
      if (body.action === 'duplicate') {
        const abs = safePath(body.path);
        const copyName = await uniqueName(dirname(abs), basename(abs).replace(/\.json$/, '-copy.json'));
        const target = join(dirname(abs), copyName);
        await writeFile(target, await readFile(abs, 'utf8'), 'utf8');
        return send(res, 200, { path: toRel(target) });
      }
      if (body.action === 'delete') {
        const abs = safePath(body.path);
        await rm(abs);
        return send(res, 200, { ok: true });
      }
      throw new HttpError(400, 'Unknown sheet action');
    }

    if (req.method === 'POST' && path === '/api/folder') {
      const body = await readBody(req);
      if (body.action === 'create') {
        const parent = body.parent ? safePath(body.parent) : ROOT;
        const name = String(body.name ?? '').trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)) throw new HttpError(400, 'Folder names use letters, numbers, spaces, dots, dashes and underscores');
        const abs = join(parent, name);
        if (existsSync(abs)) throw new HttpError(409, `${name} already exists`);
        await mkdir(abs, { recursive: true });
        await trackFolder(toRel(abs));
        return send(res, 200, { path: toRel(abs) });
      }
      if (body.action === 'rename') {
        const abs = safePath(body.path);
        const name = String(body.newName ?? '').trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)) throw new HttpError(400, 'Folder names use letters, numbers, spaces, dots, dashes and underscores');
        const target = join(dirname(abs), name);
        if (existsSync(target)) throw new HttpError(409, `${name} already exists`);
        await rename(abs, target);
        await retrackFolder(toRel(abs), toRel(target));
        return send(res, 200, { path: toRel(target) });
      }
      if (body.action === 'delete') {
        const abs = safePath(body.path);
        if (abs === ROOT) throw new HttpError(400, 'Refusing to delete the project root');
        const files = await listJsonFiles(abs).catch(() => []);
        if (files.length > 0) throw new HttpError(400, `That folder still holds ${files.length} sheet(s); empty it first`);
        await rm(abs, { recursive: true });
        await untrackFolder(toRel(abs));
        return send(res, 200, { ok: true });
      }
      throw new HttpError(400, 'Unknown folder action');
    }

    if (req.method === 'POST' && path === '/api/output') {
      const body = await readBody(req);
      if (body.action === 'create') {
        const cfg = await mapping();
        const folderRel = String(body.folder ?? cfg.defaultOutputDir).trim() || cfg.defaultOutputDir;
        const folderAbs = safePath(folderRel);
        const name = String(body.name ?? '').trim();
        if (!name) throw new HttpError(400, 'A file name is required');
        const fileName = name.endsWith('.json') ? name : `${name}.json`;
        const content = typeof body.content === 'string' && body.content.trim() ? body.content : JSON.stringify(OUTPUT_TEMPLATE, null, 2);
        validateExpected(content);
        const abs = join(folderAbs, fileName);
        if (existsSync(abs)) throw new HttpError(409, `${fileName} already exists in ${folderRel}`);
        await mkdir(folderAbs, { recursive: true });
        await writeFile(abs, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
        return send(res, 200, { path: toRel(abs) });
      }
      if (body.action === 'delete') {
        const abs = safePath(body.path);
        await rm(abs);
        return send(res, 200, { ok: true });
      }
      throw new HttpError(400, 'Unknown output action');
    }

    if (req.method === 'GET' && path === '/api/output/template') return send(res, 200, { template: OUTPUT_TEMPLATE });

    if (req.method === 'GET' && path === '/api/workbooks') return send(res, 200, { workbooks: await listWorkbooks() });

    // Comments on individual sheets inside a named test, kept per workbook so the same sheet can
    // carry a different reason in a different test.
    if (req.method === 'GET' && path === '/api/notes') {
      const workbook = String(url.searchParams.get('workbook') ?? '').trim();
      if (!workbook) return send(res, 200, { notes: store.allNotes() });
      return send(res, 200, { workbook, notes: store.notesFor(workbook) });
    }

    if (req.method === 'POST' && path === '/api/notes') {
      const body = await readBody(req);
      const workbook = String(body.workbook ?? '').trim();
      const sheetPath = String(body.sheetPath ?? '').trim();
      if (!workbook) throw new HttpError(400, 'A workbook name is required');
      if (!sheetPath) throw new HttpError(400, 'A sheet path is required');
      safePath(sheetPath);
      const note = store.saveNote({ workbook, sheetPath, comment: body.comment, expectFail: Boolean(body.expectFail) });
      return send(res, 200, { ok: true, note });
    }

    // Run history for one workbook: every run, plus which sheets keep failing.
    if (req.method === 'GET' && path === '/api/workbook-history') {
      const workbook = String(url.searchParams.get('workbook') ?? '').trim();
      if (!workbook) throw new HttpError(400, 'A workbook name is required');
      return send(res, 200, store.workbookHistory(workbook));
    }

    if (req.method === 'POST' && path === '/api/workbooks') {
      const body = await readBody(req);
      if (body.action === 'create') {
        const name = String(body.name ?? '').trim();
        if (!name) throw new HttpError(400, 'A test name is required');
        const sheets = validateWorkbookSheets(body.sheets ?? []);
        await mkdir(WORKBOOK_DIR, { recursive: true });
        let fileName = `${slug(name)}.json`;
        for (let n = 2; existsSync(join(WORKBOOK_DIR, fileName)); n++) fileName = `${slug(name)}-${n}.json`;
        const file = join(WORKBOOK_DIR, fileName);
        await writeJson(file, { name, sheets });
        return send(res, 200, { file: toRel(file), name, sheets });
      }
      if (body.action === 'save') {
        const abs = safePath(body.file);
        if (!abs.startsWith(WORKBOOK_DIR + sep)) throw new HttpError(400, 'That path is not a workbook');
        if (!existsSync(abs)) throw new HttpError(404, 'Unknown workbook');
        const name = String(body.name ?? '').trim();
        if (!name) throw new HttpError(400, 'A test name is required');
        const sheets = validateWorkbookSheets(body.sheets);
        await writeJson(abs, { name, sheets });
        return send(res, 200, { file: toRel(abs), name, sheets });
      }
      if (body.action === 'delete') {
        const abs = safePath(body.file);
        if (!abs.startsWith(WORKBOOK_DIR + sep)) throw new HttpError(400, 'That path is not a workbook');
        await rm(abs);
        return send(res, 200, { ok: true });
      }
      throw new HttpError(400, 'Unknown workbook action');
    }

    if (req.method === 'POST' && path === '/api/mapping') {
      const body = await readBody(req);
      const outputs = {};
      for (const [input, output] of Object.entries(body.outputs ?? {})) {
        if (!input || !output) continue;
        safePath(input);
        safePath(String(output));
        outputs[input] = String(output);
      }
      const defaultOutputDir = String(body.defaultOutputDir ?? 'sheets/ballast-op');
      safePath(defaultOutputDir);
      const tolerance = normaliseTolerance(body.tolerance);
      await writeJson(MAPPING_FILE, { defaultOutputDir, outputs, tolerance });
      return send(res, 200, { ok: true, tolerance });
    }

    if (req.method === 'POST' && path === '/api/run') {
      const body = await readBody(req);
      const id = await startRun({ target: body.target, path: body.path, headed: body.headed });
      return send(res, 200, { id });
    }

    if (req.method === 'POST' && path === '/api/run/stop') {
      const body = await readBody(req);
      return send(res, 200, { ok: stopRun(body.id) });
    }

    if (req.method === 'GET' && path === '/api/log') {
      const id = String(url.searchParams.get('id') ?? '');
      if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new HttpError(400, 'Invalid run id');
      const run = runs.get(id);
      if (run) return send(res, 200, run.log, 'text/plain; charset=utf-8');
      // Past runs keep their log on disk so history stays useful after a restart.
      const file = join(LOG_DIR, `${id}.log`);
      if (existsSync(file)) return send(res, 200, await readFile(file, 'utf8'), 'text/plain; charset=utf-8');
      throw new HttpError(404, 'Unknown run');
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    send(res, status, { error: err.message ?? 'Unexpected error' });
  }
});

await mkdir(DATA, { recursive: true });
await loadHistory();
server.listen(PORT, HOST, () => {
  console.log(`VoyageCalc test console: http://${HOST}:${PORT}  (project: ${ROOT})`);
});
