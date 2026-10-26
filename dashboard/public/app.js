/* VoyageCalc test console — vanilla JS, no build step. */

const state = {
  folders: [],
  mapping: {
    defaultOutputDir: 'sheets/ballast-op',
    outputs: {},
    tolerance: { amount: 0.5, rate: 0.01, fields: {} },
    fields: [],
  },
  activeRun: null,
  history: [],
  // Sheet notes per workbook: { [workbookName]: { [sheetPath]: { comment, expectFail } } }
  notes: {},
  selected: null,
  run: null,
  logOffset: 0,
  logText: '',
  expected: [], // every expected-output file in the project
  workbooks: [], // named tests that combine sheets from any folder
  tab: 'sheets',
  editor: null,
  polling: false,
  hydrated: false,
};

const $ = (id) => document.getElementById(id);

/** Small DOM helper: h('div', {class:'x'}, 'text', childNode). */
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(message, kind = '') {
  const node = h('div', { class: `toast ${kind ? `is-${kind}` : ''}`, text: message });
  $('toasts').append(node);
  setTimeout(() => node.remove(), 4200);
}

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtSize = (bytes) => (bytes > 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`);
const fmtDuration = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** "±0.5 amounts / ±0.01 rates", plus a count of per-field overrides. Older runs hold one number. */
function toleranceLabel(tolerance) {
  if (typeof tolerance === 'number') return `±${tolerance} allowed`;
  const amount = tolerance?.amount ?? 0.5;
  const rate = tolerance?.rate ?? 0.01;
  const count = Object.keys(tolerance?.fields ?? {}).length;
  return `±${amount} amounts / ±${rate} rates${count ? ` · ${count} field override(s)` : ''}`;
}

// ------------------------------------------------------------------ load & render

async function refresh() {
  try {
    const data = await api('/api/state');
    state.folders = data.folders;
    state.mapping = data.mapping;
    state.history = data.history ?? [];
    state.workbooks = data.workbooks ?? [];
    state.notes = data.notes ?? {};
    if (!state.selected || !inputFolders().some((f) => f.path === state.selected)) {
      state.selected = inputFolders()[0]?.path ?? null;
    }
    // Adopt a run started elsewhere (another tab, or before this page was opened).
    if (data.activeRun && (!state.run || state.run.id !== data.activeRun.id)) {
      state.run = data.activeRun;
      state.logOffset = 0;
      state.logText = '';
      switchTab('runs');
      void pollRun();
    } else if (!state.run && data.history?.[0] && !state.hydrated) {
      // After a reload, show the most recent run instead of an empty view.
      state.hydrated = true;
      await hydrateRun(data.history[0]);
    }
    $('conn').classList.remove('is-down');
    $('conn').textContent = 'Connected';
    state.expected = data.expected ?? [];
    render();
  } catch (err) {
    $('conn').classList.add('is-down');
    $('conn').textContent = 'Server offline';
    toast(err.message, 'bad');
  }
}

async function hydrateRun(entry) {
  // Older history entries stored only the mismatch count; normalise so rendering stays safe.
  state.run = {
    ...entry,
    sheets: (entry.sheets ?? []).map((s) => ({
      ...s,
      mismatches: Array.isArray(s.mismatches) ? s.mismatches : [],
      notes: s.notes ?? [],
    })),
  };
  state.logOffset = 0;
  try {
    const res = await fetch(`/api/log?id=${encodeURIComponent(entry.id)}`);
    state.logText = res.ok ? await res.text() : '';
  } catch {
    state.logText = '';
  }
  renderRun();
  renderRunBar();
  renderHistory();
}

function currentFolder() {
  return inputFolders().find((f) => f.path === state.selected) ?? null;
}

function render() {
  renderFolders();
  renderSheets();
  renderWorkbooks();
  renderMapping();
  renderRun();
  renderHistory();
  renderRunBar();
}

function inputFolders() {
  const inputs = state.folders.filter((f) => f.kind !== 'outputs');
  // If a project has only expected-output folders, show them rather than an empty sidebar.
  return inputs.length > 0 ? inputs : state.folders;
}

function renderFolders() {
  const list = $('folderList');
  list.replaceChildren();
  const folders = inputFolders();
  if (folders.length === 0) {
    list.append(h('li', { class: 'empty', text: 'No folders with sheets yet.' }));
  }
  for (const folder of folders) {
    const active = folder.path === state.selected;
    list.append(
      h(
        'li',
        { class: `folder-item ${active ? 'is-active' : ''}`, onclick: () => selectFolder(folder.path) },
        h('span', { class: 'folder-name', text: folder.name, title: folder.path }),
        h('span', { class: 'folder-count', text: String(folder.sheets.length) }),
        h(
          'span',
          { class: 'folder-actions' },
          h('button', { class: 'icon-btn', title: 'Rename folder', text: '✎', onclick: (e) => { e.stopPropagation(); renameFolder(folder); } }),
          h('button', { class: 'icon-btn', title: 'Delete folder', text: '🗑', onclick: (e) => { e.stopPropagation(); deleteFolder(folder); } }),
        ),
      ),
    );
  }
  const total = folders.reduce((n, f) => n + f.sheets.length, 0);
  $('sheetTotal').textContent = `${folders.length} folder(s) · ${total} sheet(s)`;
}

function selectFolder(path) {
  state.selected = path;
  render();
}

function renderSheets() {
  const folder = currentFolder();
  const rows = $('sheetRows');
  rows.replaceChildren();
  $('folderTitle').textContent = folder ? folder.name : 'Choose a folder';
  $('folderMeta').textContent = folder ? folder.path : 'Pick a folder on the left to see its sheets.';
  $('runFolder').disabled = !folder || folder.sheets.length === 0 || Boolean(state.run && state.run.status === 'running');
  $('newSheet').disabled = !folder;

  const sheets = folder?.sheets ?? [];
  $('sheetEmpty').hidden = sheets.length > 0;
  for (const sheet of sheets) {
    const mapped = state.mapping.outputs[sheet.path];
    rows.append(
      h(
        'tr',
        {},
        h(
          'td',
          {},
          h(
            'div',
            { class: 'cell-name' },
            h('span', { class: 'row-title', text: sheet.name }),
            sheet.broken ? h('span', { class: 'tag tag-bad', text: 'invalid JSON' }) : null,
            mapped ? h('span', { class: 'tag', text: 'mapped' }) : null,
          ),
        ),
        h('td', { class: 'num', text: sheet.broken ? '—' : String(sheet.sheets) }),
        h('td', { class: 'num', text: fmtSize(sheet.size) }),
        h('td', { class: 'muted', text: fmtDate(sheet.mtime) }),
        h(
          'td',
          {},
          h(
            'div',
            { class: 'cell-actions' },
            h('button', { class: 'btn btn-sm btn-primary', text: 'Run', onclick: () => startRun('sheet', sheet.path) }),
            h('button', { class: 'btn btn-sm', text: 'Edit', onclick: () => openEditor('edit', sheet) }),
            h('button', { class: 'btn btn-sm', text: 'Duplicate', onclick: () => duplicateSheet(sheet) }),
            h('button', { class: 'btn btn-sm', text: 'Rename', onclick: () => openEditor('rename', sheet) }),
            h('button', { class: 'btn btn-sm btn-quiet', text: 'Delete', onclick: () => deleteSheet(sheet) }),
          ),
        ),
      ),
    );
  }
}

const expectedIndex = () => new Map((state.expected ?? []).map((f) => [f.path, f]));

function expectedGroups() {
  const groups = new Map();
  for (const file of state.expected ?? []) {
    if (!groups.has(file.folder)) groups.set(file.folder, []);
    groups.get(file.folder).push(file);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** The output a sheet is validated against: its mapping, else the same file name in the default folder. */
function outputFor(sheet, index) {
  const saved = state.mapping.outputs[sheet.path];
  if (saved) return saved;
  const guess = state.mapping.defaultOutputDir ? `${state.mapping.defaultOutputDir}/${sheet.name}` : '';
  return guess && index.has(guess) ? guess : '';
}

/** Folder an output created from this row should land in: its own output's folder, else the default one. */
function outputFolderFor(sheet) {
  const current = sheet ? outputFor(sheet, expectedIndex()) : '';
  if (current?.includes('/')) return current.slice(0, current.lastIndexOf('/'));
  return state.mapping.defaultOutputDir || 'sheets/outputs';
}

function statusTag(path, index) {
  if (!path) return h('span', { class: 'tag', text: 'no expectation' });
  const file = index.get(path);
  if (!file) return h('span', { class: 'tag tag-bad', text: 'file missing' });
  if (file.broken) return h('span', { class: 'tag tag-bad', text: 'invalid JSON' });
  if (file.size === 0) return h('span', { class: 'tag tag-warn', text: 'empty file' });
  return h('span', { class: 'tag tag-ok', text: 'ready' });
}

let mappingTimer = null;
async function persistMapping(note = 'Saved') {
  clearTimeout(mappingTimer);
  try {
    await api('/api/mapping', {
      method: 'POST',
      body: JSON.stringify({
        defaultOutputDir: state.mapping.defaultOutputDir,
        outputs: state.mapping.outputs,
        tolerance: state.mapping.tolerance,
      }),
    });
    const el = $('mappingState');
    if (el) el.textContent = `${note} · ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    toast(err.message, 'bad');
  }
}

function renderMapping() {
  const folder = currentFolder();
  const index = expectedIndex();
  const groups = expectedGroups();

  // Suggest both sheet folders and folders that already hold expected outputs.
  const dirs = $('outputDirs');
  dirs.replaceChildren();
  const seen = new Set();
  for (const f of state.folders) {
    seen.add(f.path);
    dirs.append(h('option', { value: f.path, label: `${f.name} (${f.sheets.length} sheet(s))` }));
  }
  for (const folder of groups.map(([name]) => name)) {
    if (seen.has(folder)) continue;
    seen.add(folder);
    dirs.append(h('option', { value: folder, label: `${folder} (outputs)` }));
  }
  const dirInput = $('defaultOutputDir');
  if (document.activeElement !== dirInput) dirInput.value = state.mapping.defaultOutputDir ?? '';
  renderToleranceGroups();

  const sheets = folder?.sheets ?? [];
  const rows = $('mappingRows');
  rows.replaceChildren();
  $('mappingEmpty').hidden = sheets.length > 0;
  if (!folder) {
    $('mappingEmpty').hidden = false;
    $('coverage').replaceChildren();
    return;
  }

  const mapped = sheets.filter((s) => outputFor(s, index)).length;
  const coverage = $('coverage');
  coverage.replaceChildren();
  coverage.className = `coverage ${mapped === sheets.length ? '' : 'is-partial'}`;
  coverage.append(
    h('strong', { text: `${mapped}/${sheets.length} mapped` }),
    h('div', { class: 'coverage-bar' }, h('div', { class: 'coverage-fill', style: `width:${sheets.length ? Math.round((mapped / sheets.length) * 100) : 0}%` })),
    mapped === sheets.length
      ? h('span', { class: 'tag tag-ok', text: 'every sheet validates against an output' })
      : h('span', { class: 'tag tag-warn', text: `${sheets.length - mapped} sheet(s) without an output` }),
  );

  const onlyUnmapped = $('onlyUnmapped').checked;
  let shown = 0;
  for (const sheet of sheets) {
    const chosen = outputFor(sheet, index);
    if (onlyUnmapped && chosen) continue;
    shown++;

    const select = h('select', {
      onchange: (e) => {
        if (e.target.value) state.mapping.outputs[sheet.path] = e.target.value;
        else delete state.mapping.outputs[sheet.path];
        renderMapping();
        void persistMapping(`Mapped ${sheet.name}`);
      },
    });
    select.append(h('option', { value: '', text: '— none —' }));
    for (const [groupName, files] of groups) {
      const og = h('optgroup', { label: groupName });
      for (const file of files) og.append(h('option', { value: file.path, text: file.name, selected: file.path === chosen }));
      select.append(og);
    }
    // A saved mapping can point at a file that is gone; keep it visible so it can be fixed.
    if (chosen && !index.has(chosen)) select.append(h('optgroup', { label: 'missing' }, h('option', { value: chosen, text: chosen.split('/').pop(), selected: true })));

    rows.append(
      h(
        'tr',
        {},
        h('td', { class: 'cell-name', text: sheet.name }),
        h('td', {}, select),
        h('td', {}, statusTag(chosen, index)),
        h(
          'td',
          {},
          h(
            'div',
            { class: 'cell-actions' },
            h('button', { class: 'btn btn-sm', text: 'Add output', onclick: () => openOutputDialog(sheet) }),
            chosen
              ? h('button', {
                  class: 'btn btn-sm btn-quiet',
                  text: 'Unmap',
                  onclick: () => {
                    delete state.mapping.outputs[sheet.path];
                    renderMapping();
                    void persistMapping(`Unmapped ${sheet.name}`);
                  },
                })
              : null,
            // An output created by mistake lives on disk until it is removed here.
            chosen && index.has(chosen)
              ? h('button', {
                  class: 'btn btn-sm btn-quiet',
                  text: 'Delete file',
                  onclick: async () => {
                    if (!confirm(`Delete the expected output file ${chosen}? This cannot be undone.`)) return;
                    try {
                      await api('/api/output', { method: 'POST', body: JSON.stringify({ action: 'delete', path: chosen }) });
                      delete state.mapping.outputs[sheet.path];
                      await persistMapping('Output deleted');
                      toast(`Deleted ${chosen.split('/').pop()}`, 'ok');
                      await refresh();
                      switchTab('outputs');
                    } catch (err) {
                      toast(err.message, 'bad');
                    }
                  },
                })
              : null,
          ),
        ),
      ),
    );
  }
  if (onlyUnmapped && shown === 0) {
    rows.append(h('tr', {}, h('td', { colspan: 4, class: 'empty', text: 'Every sheet has an output.' })));
  }
}

$('defaultOutputDir').addEventListener('change', (e) => {
  state.mapping.defaultOutputDir = e.target.value.trim();
  renderMapping();
  void persistMapping('Default folder saved');
});

$('onlyUnmapped').addEventListener('change', renderMapping);

/** The two group defaults: amounts (currency totals) and rates/quantities. */
function renderToleranceGroups() {
  state.mapping.tolerance ??= { amount: 0.5, rate: 0.01, fields: {} };
  state.mapping.tolerance.fields ??= {};
  const tolerance = state.mapping.tolerance;
  for (const [id, key, fallback] of [
    ['tolAmount', 'amount', 0.5],
    ['tolRate', 'rate', 0.01],
  ]) {
    const input = $(id);
    if (!input) continue;
    if (document.activeElement !== input) input.value = String(tolerance[key] ?? fallback);
  }
  const count = Object.keys(tolerance.fields ?? {}).length;
  const badge = $('toleranceCount');
  if (badge) badge.textContent = count ? `· ${count} field override(s)` : '· group defaults only';
  renderToleranceFields();
}

for (const [id, key, fallback] of [
  ['tolAmount', 'amount', 0.5],
  ['tolRate', 'rate', 0.01],
]) {
  $(id).addEventListener('change', (e) => {
    const value = Number(e.target.value);
    // An empty or negative box falls back to the built-in default for that group.
    state.mapping.tolerance[key] = Number.isFinite(value) && value >= 0 ? value : fallback;
    e.target.value = String(state.mapping.tolerance[key]);
    void persistMapping(`${key === 'amount' ? 'Amount' : 'Rate'} tolerance saved`);
    renderToleranceFields();
  });
}

/** One row per Voyage Summary field; blank means "use the group default". */
function renderToleranceFields() {
  const rows = $('toleranceRows');
  if (!rows) return;
  // Do not pull the list out from under someone typing in it.
  if (rows.contains(document.activeElement)) return;
  const fields = state.mapping.fields ?? [];
  if (fields.length === 0) {
    rows.replaceChildren(h('p', { class: 'empty', text: 'No field list available.' }));
    return;
  }
  const tolerance = state.mapping.tolerance ?? { amount: 0.5, rate: 0.01, fields: {} };
  const overrides = tolerance.fields ?? {};
  const groupDefault = (field) => (field.kind === 'money' ? tolerance.amount : tolerance.rate);
  const nodes = fields.map((field) => {
    const overridden = Object.prototype.hasOwnProperty.call(overrides, field.path);
    const input = h('input', {
      type: 'number',
      min: '0',
      step: '0.001',
      class: 'tol-input',
      placeholder: String(groupDefault(field)),
      value: overridden ? String(overrides[field.path]) : '',
      title: `Allowed difference for ${field.label} (${field.path}). Blank = ${groupDefault(field)}.`,
      onchange: (e) => {
        const raw = e.target.value.trim();
        if (raw === '') delete tolerance.fields[field.path];
        else {
          const value = Number(raw);
          if (!Number.isFinite(value) || value < 0) {
            toast('Allowed difference must be zero or more', 'bad');
            e.target.value = overridden ? String(overrides[field.path]) : '';
            return;
          }
          tolerance.fields[field.path] = value;
        }
        renderToleranceGroups();
        void persistMapping(`${field.label} tolerance saved`);
      },
    });
    return h(
      'div',
      { class: `tol-row${overridden ? ' is-overridden' : ''}` },
      h(
        'div',
        { class: 'tol-name' },
        h('span', { text: field.label }),
        h('span', { class: 'tol-kind', text: field.kind === 'text' ? 'exact text' : field.kind }),
        h('code', { class: 'tol-path', text: field.path }),
      ),
      field.kind === 'text'
        ? h('span', { class: 'tol-exact', text: 'always exact' })
        : input,
    );
  });
  rows.replaceChildren(...nodes);
}

$('mapByName').addEventListener('click', async () => {
  const folder = currentFolder();
  if (!folder) return toast('Choose a folder first', 'bad');
  const index = expectedIndex();
  let n = 0;
  for (const sheet of folder.sheets) {
    const guess = `${state.mapping.defaultOutputDir}/${sheet.name}`;
    if (index.has(guess)) {
      state.mapping.outputs[sheet.path] = guess;
      n++;
    }
  }
  renderMapping();
  await persistMapping('Mapped by name');
  toast(`${n} sheet(s) mapped by file name`, n ? 'ok' : 'bad');
});

$('clearMapping').addEventListener('click', async () => {
  const folder = currentFolder();
  if (!folder) return;
  if (!confirm(`Remove the mapping for all ${folder.sheets.length} sheet(s) in ${folder.path}?`)) return;
  for (const sheet of folder.sheets) delete state.mapping.outputs[sheet.path];
  renderMapping();
  await persistMapping('Mappings cleared');
});

// ------------------------------------------------------------------ add expected output

let outputTarget = null;

function openOutputDialog(sheet) {
  outputTarget = sheet ?? null;
  $('outputForHint').textContent = sheet
    ? `Creating an output for ${sheet.name}; it will be mapped to that sheet.`
    : 'Creating a standalone output file. Map it to a sheet afterwards.';
  const current = sheet ? outputFor(sheet, expectedIndex()) : '';
  $('outputFolder').value = outputFolderFor(sheet);
  $('outputName').value = sheet ? sheet.name : 'output.json';
  // Starting from the sheet's own output is usually what is wanted; otherwise start blank.
  $('outputSource').value = current ? 'copy' : 'blank';
  $('outputPaste').value = '';
  const copy = $('outputCopyFrom');
  copy.replaceChildren();
  for (const file of state.expected ?? []) copy.append(h('option', { value: file.path, text: `${file.folder}/${file.name}` }));
  const preferred = current || (sheet ? `${state.mapping.defaultOutputDir}/${sheet.name}` : '');
  if (preferred && [...copy.options].some((o) => o.value === preferred)) copy.value = preferred;
  $('outputStatus').textContent = '';
  $('outputStatus').className = 'validation';
  syncOutputSource();
  $('outputDialog').showModal();
  $('outputName').focus();
}

function syncOutputSource() {
  const source = $('outputSource').value;
  $('outputCopyField').hidden = source !== 'copy';
  $('outputPasteField').hidden = source !== 'paste';
}

$('outputSource').addEventListener('change', syncOutputSource);
$('outputClose').addEventListener('click', () => $('outputDialog').close());
$('outputCancel').addEventListener('click', () => $('outputDialog').close());

$('addOutput').addEventListener('click', () => openOutputDialog(null));

$('outputSave').addEventListener('click', async () => {
  const source = $('outputSource').value;
  try {
    let content;
    if (source === 'paste') content = $('outputPaste').value;
    if (source === 'copy') {
      const from = $('outputCopyFrom').value;
      if (!from) throw new Error('Choose a file to copy');
      content = (await api(`/api/sheet?path=${encodeURIComponent(from)}`)).content;
    }
    const { path } = await api('/api/output', {
      method: 'POST',
      body: JSON.stringify({ action: 'create', folder: $('outputFolder').value.trim(), name: $('outputName').value.trim(), content }),
    });
    if (outputTarget) {
      state.mapping.outputs[outputTarget.path] = path;
      await persistMapping('Output created');
    }
    $('outputDialog').close();
    toast(`Created ${path}`, 'ok');
    await refresh();
    switchTab('outputs');
  } catch (err) {
    $('outputStatus').textContent = err.message;
    $('outputStatus').className = 'validation is-bad';
  }
});

// ------------------------------------------------------------------ workbooks

const wbBase = (p) => String(p ?? '').split('/').pop();
const wbPath = (entry) => (typeof entry === 'string' ? entry : entry?.path ?? '');
const wbPaths = (wb) => (wb?.sheets ?? []).map(wbPath).filter(Boolean);

/** Notes saved for a workbook's sheets, keyed by sheet path. */
const notesFor = (workbook) => (workbook ? state.notes?.[workbook] ?? {} : {});
const noteFor = (workbook, path) => (path ? notesFor(workbook)[path] : undefined);

function renderWorkbooks() {
  const rows = $('workbookRows');
  rows.replaceChildren();
  const books = state.workbooks ?? [];
  $('workbookEmpty').hidden = books.length > 0;
  for (const wb of books) {
    const notes = Object.values(notesFor(wb.name));
    const expected = notes.filter((n) => n.expectFail).length;
    rows.append(
      h(
        'tr',
        {},
        h(
          'td',
          {},
          h(
            'div',
            { class: 'cell-name' },
            h('span', { class: 'row-title', text: wb.name }),
            wb.broken ? h('span', { class: 'tag tag-bad', text: 'unreadable' }) : null,
            notes.length ? h('span', { class: 'tag', text: `${notes.length} note${notes.length > 1 ? 's' : ''}` }) : null,
            expected ? h('span', { class: 'tag tag-warn', text: `${expected} expected to fail` }) : null,
          ),
        ),
        h('td', { class: 'num', text: String(wbPaths(wb).length) }),
        h('td', { class: 'muted', text: fmtDate(wb.mtime) }),
        h(
          'td',
          {},
          h(
            'div',
            { class: 'cell-actions' },
            h('button', { class: 'btn btn-sm btn-primary', text: 'Run', onclick: () => startRun('workbook', wb.file) }),
            h('button', { class: 'btn btn-sm', text: 'Edit', onclick: () => openWorkbookDialog(wb) }),
            h('button', { class: 'btn btn-sm', text: 'Notes', onclick: () => openNotesDialog(wb) }),
            h('button', { class: 'btn btn-sm', text: 'History', onclick: () => void openHistoryDialog(wb) }),
            h('button', { class: 'btn btn-sm btn-quiet', text: 'Delete', onclick: () => deleteWorkbook(wb) }),
          ),
        ),
      ),
    );
  }
}

let wbDraft = null;
// Boxes ticked in the picker but not added yet; kept across filtering and folder switches.
let wbChecked = new Set();
// The tags in the pick list use the same expectation lookup as the Outputs tab.
const wbFakeSheet = (path) => ({ path, name: wbBase(path) });

function syncWbAll() {
  const boxes = [...$('workbookPick').querySelectorAll('input[type=checkbox]:not(:disabled)')];
  const all = $('workbookAll');
  const ticked = boxes.filter((b) => b.checked).length;
  all.checked = boxes.length > 0 && ticked === boxes.length;
  all.indeterminate = ticked > 0 && ticked < boxes.length;
  $('workbookAdd').disabled = wbChecked.size === 0;
  $('workbookAdd').textContent = wbChecked.size ? `Add ${wbChecked.size} selected` : 'Add selected';
}

function renderWorkbookPick() {
  const folder = inputFolders().find((f) => f.path === $('workbookFolder').value);
  const box = $('workbookPick');
  box.replaceChildren();
  const filter = $('workbookFilter').value.trim().toLowerCase();
  const inDraft = new Set(wbDraft.sheets.map(wbPath));
  const sheets = (folder?.sheets ?? []).filter((s) => !filter || s.name.toLowerCase().includes(filter));
  if (sheets.length === 0) {
    box.append(h('p', { class: 'empty', text: filter ? 'No sheet in this folder matches the filter.' : 'This folder holds no sheets.' }));
  }
  for (const sheet of sheets) {
    const added = inDraft.has(sheet.path);
    box.append(
      h(
        'label',
        { class: `wb-avail ${added ? 'is-added' : ''}`, title: sheet.path },
        h('input', {
          type: 'checkbox',
          checked: wbChecked.has(sheet.path),
          disabled: added,
          onchange: (e) => {
            if (e.target.checked) wbChecked.add(sheet.path);
            else wbChecked.delete(sheet.path);
            syncWbAll();
          },
        }),
        h('span', { class: 'wb-avail-name', text: sheet.name }),
        sheet.sheets > 1 ? h('span', { class: 'tag', text: `${sheet.sheets} sheets` }) : null,
        added ? h('span', { class: 'tag tag-ok', text: 'added' }) : null,
      ),
    );
  }
  syncWbAll();
}

function renderWorkbookDraft() {
  const list = $('workbookSheets');
  list.replaceChildren();
  $('workbookCount').textContent = String(wbDraft.sheets.length);
  if (!wbDraft.sheets.length) {
    list.append(h('li', { class: 'empty', text: 'Nothing picked yet. Tick sheets on the left and add them.' }));
    return;
  }
  const index = expectedIndex();
  wbDraft.sheets.forEach((entry, i) => {
    const path = wbPath(entry);
    const move = (to) => {
      const [item] = wbDraft.sheets.splice(i, 1);
      wbDraft.sheets.splice(to, 0, item);
      renderWorkbookEditor();
    };
    list.append(
      h(
        'li',
        { class: 'wb-item' },
        h('span', { class: 'wb-idx', text: String(i + 1) }),
        h('span', { class: 'wb-path', text: wbBase(path), title: path }),
        h('span', { class: 'wb-folder', text: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '' }),
        statusTag(outputFor(wbFakeSheet(path), index), index),
        h(
          'span',
          { class: 'cell-actions' },
          h('button', { class: 'icon-btn', title: 'Move up', text: '↑', disabled: i === 0, onclick: () => move(i - 1) }),
          h('button', { class: 'icon-btn', title: 'Move down', text: '↓', disabled: i === wbDraft.sheets.length - 1, onclick: () => move(i + 1) }),
          h('button', {
            class: 'icon-btn',
            title: 'Remove',
            text: '×',
            onclick: () => {
              wbDraft.sheets.splice(i, 1);
              renderWorkbookEditor();
            },
          }),
        ),
      ),
    );
  });
}

function renderWorkbookEditor() {
  renderWorkbookDraft();
  renderWorkbookPick();
}

function openWorkbookDialog(wb) {
  wbDraft = wb
    ? { file: wb.file, name: wb.name, sheets: wbPaths(wb).slice() }
    : { file: null, name: '', sheets: [] };
  $('workbookTitle').textContent = wb ? 'Edit workbook' : 'New workbook';
  $('workbookName').value = wbDraft.name;
  const folderSelect = $('workbookFolder');
  folderSelect.replaceChildren();
  for (const folder of inputFolders()) {
    folderSelect.append(h('option', { value: folder.path, label: `${folder.name} (${folder.sheets.length})` }));
  }
  // Start on the folder the workbook already uses, so adding more sheets is quick.
  const first = wbPaths(wb).find((p) => p.includes('/'));
  const start = first ? first.slice(0, first.lastIndexOf('/')) : inputFolders()[0]?.path ?? '';
  folderSelect.value = start;
  $('workbookFilter').value = '';
  wbChecked = new Set();
  renderWorkbookEditor();
  $('workbookStatus').textContent = '';
  $('workbookStatus').className = 'validation';
  $('workbookDialog').showModal();
  $('workbookName').focus();
}

$('newWorkbook').addEventListener('click', () => openWorkbookDialog(null));
$('workbookFolder').addEventListener('change', renderWorkbookEditor);
$('workbookFilter').addEventListener('input', renderWorkbookPick);
$('workbookClose').addEventListener('click', () => $('workbookDialog').close());
$('workbookCancel').addEventListener('click', () => $('workbookDialog').close());

$('workbookAll').addEventListener('change', (e) => {
  for (const box of $('workbookPick').querySelectorAll('input[type=checkbox]:not(:disabled)')) {
    box.checked = e.target.checked;
    const row = box.closest('.wb-avail');
    const path = row?.title;
    if (!path) continue;
    if (box.checked) wbChecked.add(path);
    else wbChecked.delete(path);
  }
  syncWbAll();
});

$('workbookAdd').addEventListener('click', () => {
  if (wbChecked.size === 0) return;
  const paths = [...wbChecked];
  for (const path of paths) {
    if (!wbDraft.sheets.some((e) => wbPath(e) === path)) wbDraft.sheets.push(path);
  }
  wbChecked = new Set();
  renderWorkbookEditor();
});

$('workbookSave').addEventListener('click', async () => {
  const status = $('workbookStatus');
  try {
    const name = $('workbookName').value.trim();
    if (!name) throw new Error('Give the test a name');
    if (!wbDraft.sheets.length) throw new Error('Add at least one sheet');
    const body = { name, sheets: wbDraft.sheets };
    if (wbDraft.file) await api('/api/workbooks', { method: 'POST', body: JSON.stringify({ ...body, action: 'save', file: wbDraft.file }) });
    else await api('/api/workbooks', { method: 'POST', body: JSON.stringify({ ...body, action: 'create' }) });
    $('workbookDialog').close();
    toast(`Saved “${name}”`, 'ok');
    await refresh();
    switchTab('workbooks');
  } catch (err) {
    status.textContent = err.message;
    status.className = 'validation is-bad';
  }
});

// ------------------------------------------------------------------ sheet notes

let notesTarget = null;

function openNotesDialog(wb) {
  notesTarget = wb;
  $('notesTitle').textContent = `Sheet notes · ${wb.name}`;
  const box = $('notesRows');
  box.replaceChildren();
  const notes = notesFor(wb.name);
  const paths = wbPaths(wb);
  if (paths.length === 0) box.append(h('p', { class: 'empty', text: 'This test holds no sheets yet.' }));
  for (const path of paths) {
    const note = notes[path];
    box.append(
      h(
        'div',
        { class: 'note-row', 'data-path': path },
        h(
          'div',
          { class: 'note-head' },
          h('span', { class: 'note-name', text: wbBase(path) }),
          h('code', { class: 'note-path', text: path }),
        ),
        h('textarea', {
          class: 'note-text',
          rows: '2',
          spellcheck: 'false',
          placeholder: 'Why does this sheet fail? e.g. app reports Gross Rate $ 0.00 for two-cargo sheets',
          value: note?.comment ?? '',
        }),
        h(
          'label',
          { class: 'check' },
          h('input', { type: 'checkbox', class: 'note-expect', checked: Boolean(note?.expectFail) }),
          'expected to fail',
        ),
      ),
    );
  }
  $('notesStatus').textContent = '';
  $('notesStatus').className = 'validation';
  $('notesDialog').showModal();
}

$('notesClose').addEventListener('click', () => $('notesDialog').close());
$('notesCancel').addEventListener('click', () => $('notesDialog').close());

$('notesSave').addEventListener('click', async () => {
  const status = $('notesStatus');
  if (!notesTarget) return;
  const saved = notesFor(notesTarget.name);
  const rows = [...$('notesRows').querySelectorAll('.note-row')];
  let changed = 0;
  try {
    status.textContent = 'Saving…';
    status.className = 'validation';
    for (const row of rows) {
      const path = row.dataset.path;
      const comment = row.querySelector('.note-text').value.trim();
      const expectFail = row.querySelector('.note-expect').checked;
      const before = saved[path];
      if ((before?.comment ?? '') === comment && Boolean(before?.expectFail) === expectFail) continue;
      await api('/api/notes', { method: 'POST', body: JSON.stringify({ workbook: notesTarget.name, sheetPath: path, comment, expectFail }) });
      changed++;
    }
    $('notesDialog').close();
    toast(changed ? `${changed} note(s) saved` : 'No changes', changed ? 'ok' : '');
    await refresh();
    renderWorkbooks();
  } catch (err) {
    status.textContent = err.message;
    status.className = 'validation is-bad';
  }
});

// ------------------------------------------------------------------ workbook history

async function openHistoryDialog(wb) {
  $('historyTitle').textContent = `History · ${wb.name}`;
  $('historyStatus').textContent = 'Loading…';
  $('historyStatus').className = 'validation';
  for (const id of ['wbSheetRows', 'wbRunRows']) $(id).replaceChildren();
  $('historySummary').replaceChildren();
  $('historyDialog').showModal();
  let data;
  try {
    data = await api(`/api/workbook-history?workbook=${encodeURIComponent(wb.name)}`);
  } catch (err) {
    $('historyStatus').textContent = err.message;
    $('historyStatus').className = 'validation is-bad';
    return;
  }
  const runs = data.runs ?? [];
  const sheets = data.sheets ?? [];
  const notes = notesFor(wb.name);
  // "Always fails" only means something once a sheet has been through the test more than once.
  const repeated = sheets.filter((s) => s.runs > 1);
  const alwaysFailing = repeated.filter((s) => s.failures === s.runs).length;
  const flaky = repeated.filter((s) => s.failures > 0 && s.failures < s.runs).length;

  const summaryBits = [
    h('strong', { text: `${data.totalRuns ?? runs.length} run(s)` }),
    h('span', { class: 'muted', text: sheets.length ? `${sheets.length} sheet(s) tracked` : 'no sheet results yet' }),
    alwaysFailing ? h('span', { class: 'tag tag-bad', text: `${alwaysFailing} fail every run` }) : null,
    flaky ? h('span', { class: 'tag tag-warn', text: `${flaky} flaky` }) : null,
    runs[0] ? h('span', { class: 'muted', text: `last run ${fmtDate(runs[0].startedAt)}` }) : null,
  ].filter(Boolean);
  $('historySummary').replaceChildren(...summaryBits);

  const sheetRows = $('wbSheetRows');
  $('wbSheetEmpty').hidden = sheets.length > 0;
  for (const sheet of sheets.sort((a, b) => b.failures - a.failures || (a.index ?? 0) - (b.index ?? 0))) {
    const note = sheet.path ? notes[sheet.path] : undefined;
    const last = sheet.last?.fields ?? [];
    sheetRows.append(
      h(
        'tr',
        {},
        h(
          'td',
          {},
          h(
            'div',
            { class: 'cell-name' },
            h('span', { class: 'row-title', text: sheet.vessel || (sheet.path ? wbBase(sheet.path) : `sheet #${sheet.index}`) }),
            sheet.path ? h('span', { class: 'tag', text: `#${sheet.index}` }) : null,
            sheet.runs > 0 && sheet.failures === sheet.runs && sheet.runs > 1 ? h('span', { class: 'tag tag-bad', text: 'always fails' }) : null,
          ),
          sheet.path ? h('div', { class: 'note-path', text: sheet.path }) : null,
        ),
        h('td', { class: 'num', text: String(sheet.runs) }),
        h(
          'td',
          { class: `num ${sheet.failures ? 'is-bad' : ''}`, text: String(sheet.failures) },
        ),
        h(
          'td',
          { class: 'muted small' },
          last.length
            ? `${last.slice(0, 3).map((f) => f.field).join(', ')}${last.length > 3 ? ` +${last.length - 3}` : ''}`
            : sheet.last?.error
              ? sheet.last.error
              : '—',
        ),
        h(
          'td',
          { class: 'muted small' },
          note?.comment
            ? h('span', {}, note.expectFail ? h('span', { class: 'tag tag-warn', text: 'known' }) : null, ` ${note.comment}`)
            : '—',
        ),
      ),
    );
  }

  const runRows = $('wbRunRows');
  $('wbRunEmpty').hidden = runs.length > 0;
  for (const run of runs) {
    runRows.append(
      h(
        'tr',
        {},
        h('td', { class: 'muted', text: fmtDate(run.startedAt) }),
        h('td', {}, h('span', { class: `pill pill-${run.status}`, text: run.status })),
        h('td', { class: 'num', text: run.total === null ? '—' : String(run.total) }),
        h('td', { class: 'num', text: run.checked === null ? '—' : String(run.checked) }),
        h('td', { class: `num ${run.mismatches ? 'is-bad' : ''}`, text: String(run.mismatches) }),
        h('td', { class: 'muted', text: run.finishedAt ? fmtDuration(run.finishedAt - run.startedAt) : '—' }),
        h(
          'td',
          {},
          h(
            'div',
            { class: 'cell-actions' },
            h('button', {
              class: 'btn btn-sm',
              text: 'Open',
              onclick: () => {
                const known = (state.history ?? []).find((h) => h.id === run.id);
                $('historyDialog').close();
                if (known) {
                  switchTab('runs');
                  void hydrateRun(known);
                } else {
                  window.open(`/api/log?id=${encodeURIComponent(run.id)}`, '_blank');
                }
              },
            }),
          ),
        ),
      ),
    );
  }
  $('historyStatus').textContent = `${runs.length} run(s) shown`;
}

$('historyClose').addEventListener('click', () => $('historyDialog').close());
$('historyCancel').addEventListener('click', () => $('historyDialog').close());

async function deleteWorkbook(wb) {
  if (!confirm(`Delete the test “${wb.name}”? The sheets themselves are kept.`)) return;
  try {
    await api('/api/workbooks', { method: 'POST', body: JSON.stringify({ action: 'delete', file: wb.file }) });
    toast(`Deleted “${wb.name}”`, 'ok');
    await refresh();
    switchTab('workbooks');
  } catch (err) {
    toast(err.message, 'bad');
  }
}

// ------------------------------------------------------------------ sheets & folders

async function duplicateSheet(sheet) {
  try {
    const { path } = await api('/api/sheet', { method: 'POST', body: JSON.stringify({ action: 'duplicate', path: sheet.path }) });
    toast(`Created ${path.split('/').pop()}`, 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function deleteSheet(sheet) {
  if (!confirm(`Delete ${sheet.name}? This cannot be undone.`)) return;
  try {
    await api('/api/sheet', { method: 'POST', body: JSON.stringify({ action: 'delete', path: sheet.path }) });
    toast(`Deleted ${sheet.name}`, 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function renameFolder(folder) {
  const name = prompt('New folder name', folder.name.split('/').pop());
  if (!name) return;
  try {
    await api('/api/folder', { method: 'POST', body: JSON.stringify({ action: 'rename', path: folder.path, newName: name }) });
    toast('Folder renamed', 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function deleteFolder(folder) {
  if (!confirm(`Delete the folder ${folder.path}? It must be empty.`)) return;
  try {
    await api('/api/folder', { method: 'POST', body: JSON.stringify({ action: 'delete', path: folder.path }) });
    toast('Folder deleted', 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

$('newFolder').addEventListener('click', async () => {
  const name = prompt('New folder name');
  if (!name) return;
  try {
    const parent = state.selected && state.selected.includes('/') ? state.selected.split('/')[0] : '';
    const { path } = await api('/api/folder', { method: 'POST', body: JSON.stringify({ action: 'create', parent, name }) });
    await refresh();
    if (path) {
      state.selected = path;
      render();
      toast(`Created ${path}`, 'ok');
    }
  } catch (err) {
    toast(err.message, 'bad');
  }
});

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !state.selected) return;
  try {
    const text = await file.text();
    JSON.parse(text); // fail early with a clear message
    await api('/api/sheet', {
      method: 'POST',
      body: JSON.stringify({ action: 'create', folder: state.selected, name: file.name, content: text }),
    });
    toast(`Imported ${file.name}`, 'ok');
    await refresh();
  } catch (err) {
    toast(err instanceof SyntaxError ? `Not valid JSON: ${err.message}` : err.message, 'bad');
  }
});

// ------------------------------------------------------------------ editor dialog

const editor = $('editor');

async function openEditor(mode, sheet) {
  state.editor = { mode, sheet };
  $('editorNameField').hidden = mode === 'edit';
  $('editorText').parentElement.hidden = mode === 'rename';
  $('editorTitle').textContent = mode === 'new' ? 'New sheet' : mode === 'rename' ? 'Rename sheet' : `Edit ${sheet.name}`;
  $('editorStatus').textContent = '';
  $('editorStatus').className = 'validation';

  if (mode === 'new') {
    const { template } = await api('/api/template').catch(() => ({ template: {} }));
    $('editorName').value = `sheet-${Date.now().toString().slice(-5)}.json`;
    $('editorText').value = JSON.stringify(template, null, 2);
    validateEditor();
  } else if (mode === 'rename') {
    $('editorName').value = sheet.name;
  } else {
    const data = await api(`/api/sheet?path=${encodeURIComponent(sheet.path)}`);
    $('editorText').value = data.content;
    $('editorStatus').textContent = `${data.sheets} sheet(s) · ${fmtSize(data.size)}`;
  }
  editor.showModal();
  if (mode !== 'rename') $('editorText').focus();
}

function validateEditor() {
  const status = $('editorStatus');
  const text = $('editorText').value;
  $('editorSave').disabled = false;
  if (!text.trim()) {
    status.textContent = 'Empty file';
    status.className = 'validation is-bad';
    $('editorSave').disabled = true;
    return;
  }
  try {
    const parsed = JSON.parse(text);
    const count = Array.isArray(parsed) ? parsed.length : 1;
    status.textContent = `Valid JSON · ${count} sheet(s)`;
    status.className = 'validation is-ok';
  } catch (err) {
    status.textContent = err.message;
    status.className = 'validation is-bad';
    $('editorSave').disabled = true;
  }
}

$('editorText').addEventListener('input', validateEditor);

$('editorFormat').addEventListener('click', () => {
  try {
    $('editorText').value = JSON.stringify(JSON.parse($('editorText').value), null, 2);
    validateEditor();
  } catch {
    toast('Fix the JSON before formatting', 'bad');
  }
});

const closeEditor = () => editor.close();
$('editorClose').addEventListener('click', closeEditor);
$('editorCancel').addEventListener('click', closeEditor);

$('editorSave').addEventListener('click', async () => {
  const { mode, sheet } = state.editor ?? {};
  const name = $('editorName').value.trim();
  try {
    if (mode === 'rename') {
      if (!name) throw new Error('A new name is required');
      await api('/api/sheet', { method: 'POST', body: JSON.stringify({ action: 'rename', path: sheet.path, newName: name }) });
      toast('Sheet renamed', 'ok');
    } else if (mode === 'new') {
      if (!state.selected) throw new Error('Choose a folder first');
      await api('/api/sheet', { method: 'POST', body: JSON.stringify({ action: 'create', folder: state.selected, name, content: $('editorText').value }) });
      toast('Sheet created', 'ok');
    } else {
      await api('/api/sheet', { method: 'POST', body: JSON.stringify({ action: 'save', path: sheet.path, content: $('editorText').value }) });
      toast('Sheet saved', 'ok');
    }
    editor.close();
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
});

// ------------------------------------------------------------------ run control

$('newSheet').addEventListener('click', () => {
  if (!state.selected) return toast('Choose a folder first', 'bad');
  void openEditor('new');
});

$('runFolder').addEventListener('click', () => {
  if (state.selected) startRun('folder', state.selected);
});

/** Kills a running test: Playwright and the browser it opened. */
async function killRun(id) {
  if (!id) return;
  const button = $('stopRun');
  button.disabled = true;
  try {
    const res = await api('/api/run/stop', { method: 'POST', body: JSON.stringify({ id }) });
    if (res?.alreadyStopped) toast(res.status === 'stopped' ? 'That run is already stopped' : 'Already killing it…');
    else toast('Killing run…');
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    button.disabled = false;
  }
}

$('stopRun').addEventListener('click', () => killRun(state.run?.id));

async function startRun(target, path) {
  try {
    // Every sheet is validated against an output; warn before a run where some have none.
    const index = expectedIndex();
    const pool = state.folders.flatMap((f) => f.sheets);
    const book = target === 'workbook' ? state.workbooks.find((w) => w.file === path) : null;
    const targets =
      target === 'folder'
        ? (state.folders.find((f) => f.path === path)?.sheets ?? pool.filter((s) => s.path.startsWith(`${path}/`)))
        : target === 'workbook'
          ? wbPaths(book).map(wbFakeSheet)
          : pool.filter((s) => s.path === path);
    const unmapped = targets.filter((s) => !outputFor(s, index));
    if (unmapped.length > 0) {
      const names = unmapped.slice(0, 8).map((s) => `• ${s.name}`).join('\n');
      const more = unmapped.length > 8 ? `\n…and ${unmapped.length - 8} more` : '';
      if (!confirm(`${unmapped.length} sheet(s) have no expected output and will be reported as failures:\n\n${names}${more}\n\nStart the run anyway?`)) return;
    }

    const headed = $('headed').checked;
    const { id } = await api('/api/run', { method: 'POST', body: JSON.stringify({ target, path, headed }) });
    state.run = { id, target, path, headed, status: 'running', sheets: [], total: null };
    state.hydrated = true;
    state.logOffset = 0;
    state.logText = '';
    switchTab('runs');
    render();
    void pollRun();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function pollRun() {
  if (!state.run?.id || state.polling) return;
  state.polling = true;
  try {
    const data = await api(`/api/run?id=${encodeURIComponent(state.run.id)}&from=${state.logOffset}`);
    state.run = data.run;
    state.logOffset = data.offset;
    state.logText = (state.logText + data.log).slice(-400_000);
    renderRun();
    renderRunBar();
    renderHistory();
    renderSheets();
    const active = data.run.status === 'running' || data.run.status === 'stopping';
    state.polling = false;
    if (active) setTimeout(pollRun, 1000);
    else {
      $('stopRun').hidden = true;
      await refresh();
      const bad = data.run.sheets.reduce((n, s) => n + s.mismatches.length, 0);
      toast(
        data.run.status === 'passed' ? 'Run passed — every sheet matched' : `Run ${data.run.status} · ${bad} mismatch(es)`,
        data.run.status === 'passed' ? 'ok' : 'bad',
      );
    }
  } catch (err) {
    state.polling = false;
    $('stopRun').hidden = true;
    toast(err.message, 'bad');
  }
}

function renderRunBar() {
  const run = state.run;
  const bar = $('runbar');
  if (!run) {
    bar.hidden = true;
    $('stopRun').hidden = true;
    return;
  }
  bar.hidden = false;
  const active = run.status === 'running' || run.status === 'stopping';
  const kill = $('stopRun');
  kill.hidden = !active;
  kill.disabled = run.status === 'stopping';
  kill.textContent = run.status === 'stopping' ? 'Killing…' : 'Kill run';
  const pill = $('runbarStatus');
  pill.textContent = run.status;
  pill.className = `runbar-status is-${run.status}`;
  const done = run.sheets.filter((s) => s.status === 'saved' || s.status === 'failed').length;
  const total = run.total ?? run.sheets.length ?? 0;
  $('progressFill').style.width = total ? `${Math.min(100, (done / total) * 100)}%` : '0%';
  const currentIndex = run.current?.index ?? done;
  const current = run.sheets.find((s) => s.index === (run.current?.index ?? 0));
  const mismatches = run.sheets.reduce((n, s) => n + s.mismatches.length, 0);
  $('runbarText').textContent = active
    ? `Sheet ${currentIndex || '–'}${total ? ` of ${total}` : ''}${current?.vessel ? ` · ${current.vessel}` : ''} · ${mismatches} mismatch(es)`
    : `${run.name ?? run.path} · ${run.status}${run.finishedAt ? ` in ${fmtDuration(run.finishedAt - run.startedAt)}` : ''}${mismatches ? ` · ${mismatches} mismatch(es)` : ''}`;
}

function renderRun() {
  const view = $('runView');
  const run = state.run;
  if (!run) {
    view.replaceChildren(h('p', { class: 'empty', text: 'No run yet. Start one from the Sheets tab.' }));
    return;
  }
  const mismatches = run.sheets.reduce((n, s) => n + s.mismatches.length, 0);
  const checked = run.sheets.reduce((n, s) => n + (s.checked ?? 0), 0);
  const badge = $('runBadge');
  badge.hidden = mismatches === 0;
  badge.textContent = String(mismatches);

  const activeRun = run.status === 'running' || run.status === 'stopping';
  const summary = h(
    'div',
    { class: 'run-summary' },
    h('span', { class: `pill pill-${run.status}`, text: run.status }),
    h(
      'div',
      {},
      h('h2', { text: `${run.target === 'folder' ? 'Folder' : run.target === 'workbook' ? 'Workbook' : 'Sheet'} run · ${run.name ?? run.path}` }),
      h('div', {
        class: 'meta',
        text: [
          run.headed ? 'headed' : 'headless',
          `${run.sheets.length}${run.total ? `/${run.total}` : ''} sheet(s)`,
          `${checked} field(s) checked`,
          toleranceLabel(run.tolerance),
          `${mismatches} mismatch(es)`,
          run.finishedAt ? fmtDuration(run.finishedAt - run.startedAt) : fmtDuration(Date.now() - run.startedAt),
        ].join(' · '),
      }),
    ),
    activeRun
      ? h('button', {
          class: 'btn btn-danger btn-sm',
          text: run.status === 'stopping' ? 'Killing…' : 'Kill run',
          disabled: run.status === 'stopping',
          onclick: () => killRun(run.id),
        })
      : null,
  );

  const errorBox = run.error
    ? h(
        'div',
        { class: 'error-box' },
        h('strong', { text: 'Run stopped with an error' }),
        h('span', { text: run.error }),
      )
    : null;

  const cards = run.sheets.map((sheet) => {
    // A saved note explains a sheet that fails on purpose, so a known failure is not read as a regression.
    // Older runs stored no sheet path, so fall back to this workbook's order at that position.
    const book = run.name ? (state.workbooks ?? []).find((w) => w.name === run.name) : null;
    const notePath = sheet.path ?? sheet.sheetPath ?? (book ? wbPaths(book)[sheet.index - 1] : null);
    const note = noteFor(run.name, notePath);
    const head = h(
      'div',
      { class: 'sheet-card-head' },
      h('span', { class: 'idx', text: `#${sheet.index}` }),
      h('span', { class: 'name', text: sheet.vessel || '—' }),
      h('span', { class: 'spacer' }),
      sheet.checked !== null && sheet.checked !== undefined ? h('span', { class: 'tag', text: `${sheet.checked} checked` }) : null,
      note?.expectFail ? h('span', { class: 'tag tag-warn', text: 'expected to fail' }) : null,
      sheet.mismatches.length > 0
        ? h('span', { class: 'tag tag-bad', text: `${sheet.mismatches.length} mismatch${sheet.mismatches.length > 1 ? 'es' : ''}` })
        : sheet.status === 'saved'
          ? h('span', { class: 'tag tag-ok', text: 'matches' })
          : null,
      h('span', {
        class: `pill pill-${sheet.status === 'saved' ? 'passed' : ['running', 'stopping', 'stopped'].includes(sheet.status) ? sheet.status : 'failed'}`,
        text: sheet.status,
      }),
    );

    const children = [head];
    if (note?.comment) {
      children.push(
        h(
          'div',
          { class: 'sheet-note' },
          h('strong', { text: note.expectFail ? 'Known failure: ' : 'Note: ' }),
          note.comment,
        ),
      );
    }
    if (sheet.mismatches.length > 0) {
      const table = h(
        'table',
        { class: 'mismatch-table' },
        h('thead', {}, h('tr', {}, h('th', { text: 'Field' }), h('th', { text: 'Expected' }), h('th', { text: 'Actual' }))),
      );
      const body = h('tbody');
      for (const m of sheet.mismatches) {
        body.append(h('tr', {}, h('td', { text: m.field }), h('td', { class: 'exp', text: m.expected }), h('td', { class: 'act', text: m.actual })));
      }
      table.append(body);
      children.push(h('div', { class: 'sheet-card-body' }, table));
    }
    if (sheet.notes?.length) {
      children.push(h('ul', { class: 'notes' }, sheet.notes.map((n) => h('li', { text: n }))));
    }
    return h('div', { class: 'sheet-card' }, children);
  });

  const logLines = state.logText.split('\n').slice(-400);
  const logPre = h('pre', { class: 'log', id: 'logPre' });
  for (const line of logLines) {
    let cls = '';
    if (line.startsWith('MISMATCH')) cls = 'l-mismatch';
    else if (line.startsWith('--- sheet')) cls = 'l-sheet';
    else if (line.startsWith('saved sheet')) cls = 'l-saved';
    logPre.append(h('span', { class: cls, text: `${line}\n` }));
  }

  const logPanel = h(
    'div',
    { class: 'log-panel' },
    h(
      'div',
      { class: 'log-head' },
      h('strong', { text: 'Execution log' }),
      h('span', { class: 'tag', text: activeLabel(run) }),
      h('span', { style: 'flex:1' }),
      h('button', {
        class: 'btn btn-sm',
        text: 'Open full log',
        onclick: () => window.open(`/api/log?id=${encodeURIComponent(run.id)}`, '_blank'),
      }),
    ),
    logPre,
  );

  view.replaceChildren(summary, ...(errorBox ? [errorBox] : []), ...cards, logPanel);
  const pre = $('logPre');
  if (pre) pre.scrollTop = pre.scrollHeight;
}

const activeLabel = (run) => (run.status === 'running' || run.status === 'stopping' ? 'live' : `${run.exitCode ?? '—'} exit`);

function renderHistory() {
  const rows = $('historyRows');
  rows.replaceChildren();
  const items = state.history ?? [];
  $('historyEmpty').hidden = items.length > 0;
  for (const run of items) {
    rows.append(
      h(
        'tr',
        {},
        h('td', { class: 'muted', text: fmtDate(run.startedAt) }),
        h('td', { class: 'cell-name', text: run.name ?? run.path }),
        h('td', { class: 'muted', text: run.headed ? 'headed' : 'headless' }),
        h('td', {}, h('span', { class: `pill pill-${run.status}`, text: run.status })),
        h('td', { class: 'num', text: String(run.checked ?? '—') }),
        h('td', { class: 'num', text: String(run.mismatchCount ?? 0) }),
        h(
          'td',
          {},
          h(
            'div',
            { class: 'cell-actions' },
            h('button', {
              class: 'btn btn-sm',
              text: 'Open',
              onclick: () => {
                void hydrateRun(run);
                switchTab('runs');
              },
            }),
          ),
        ),
      ),
    );
  }
}

// ------------------------------------------------------------------ tabs

function switchTab(name) {
  state.tab = name;
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('is-active', tab.dataset.tab === name);
  for (const pane of document.querySelectorAll('.tabpane')) pane.hidden = pane.id !== `tab-${name}`;
  if (name === 'outputs') renderMapping();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
}

// ------------------------------------------------------------------ boot

void refresh();
setInterval(() => {
  const running = state.run && (state.run.status === 'running' || state.run.status === 'stopping');
  if (!running) void refresh();
}, 8000);
