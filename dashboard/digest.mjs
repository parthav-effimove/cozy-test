/**
 * Builds the digest a finished run is summarised from.
 *
 * Structure only on purpose: field names, which sheets they failed on, statuses and error lines.
 * No expected/actual values, no hire, freight, bunker or P&L figures leave the machine, so the
 * digest is safe to hand to a third-party model and the model is told not to invent numbers.
 */

const MAX_FIELDS_PER_SHEET = 30;
const MAX_ERROR_LINES = 20;
const MAX_ERROR_LENGTH = 220;

const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * Collapses a Playwright stack/error block to its useful line: code frames, attachment paths and
 * artifact file names are dropped, because they buries the actual reason.
 */
function errorLine(line) {
  const text = clean(line);
  if (!text) return null;
  if (/^(at |\{|}|\d+ \||\d+ (failed|passed)\b)/.test(text)) return null;
  if (/^(Error Context|attachment #|Screenshot|Video|Test timeout)/i.test(text)) return null;
  // Fragments of Playwright's assertion diff (`+ "…"`, `- Expected`, `Array []`) restate the
  // mismatches in an unreadable form, so they are dropped.
  if (/^[+-] /.test(text) || /^(Expected|Received|Array)\b/.test(text)) return null;
  if (/\.(png|webm|zip|md)\b/i.test(text) || /(^|\/)test-results\//.test(text)) return null;
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

function duration(run) {
  if (!run.startedAt) return '';
  const end = run.finishedAt ?? Date.now();
  const minutes = Math.max(0, Math.round((end - run.startedAt) / 60000));
  return minutes >= 1 ? `${minutes}m` : '<1m';
}

export function buildDigest(run, options = {}) {
  const maxErrorLines = options.maxErrorLines ?? MAX_ERROR_LINES;
  const sheets = Array.isArray(run.sheets) ? run.sheets : [];
  const saved = sheets.filter((s) => s.status === 'saved').length;
  const failed = sheets.filter((s) => s.status === 'failed').length;
  const skipped = sheets.filter((s) => ['stopped', 'skipped'].includes(s.status)).length;

  const head = [
    `Run: ${clean(run.name ?? run.path ?? 'unnamed')} (${run.target ?? 'run'})`,
    `Status: ${run.status ?? 'unknown'} · ${sheets.length}${run.total ? `/${run.total}` : ''} sheet(s) · ${saved} saved · ${failed} failed${skipped ? ` · ${skipped} stopped` : ''}`,
    `Mode: ${run.headed ? 'headed' : 'headless'} browser · ${run.speed ?? 'watch'} speed · ${(run.shards ?? 1) > 1 ? `${run.shards} shards` : 'one browser'} · ${duration(run)}`,
  ];

  const failures = [];
  for (const sheet of sheets) {
    if (sheet.status === 'saved') continue;
    const mismatches = Array.isArray(sheet.mismatches) ? sheet.mismatches : [];
    const fields = mismatches.map((m) => clean(m.field)).filter(Boolean);
    const unique = [...new Set(fields)];
    const shown = unique.slice(0, MAX_FIELDS_PER_SHEET).join(', ');
    const more = unique.length > MAX_FIELDS_PER_SHEET ? ` (+${unique.length - MAX_FIELDS_PER_SHEET} more)` : '';
    const id = `#${sheet.index ?? '?'}${sheet.vessel ? ` ${clean(sheet.vessel)}` : ''}`;
    failures.push(
      `- ${id}: ${sheet.status ?? 'unknown'}` +
        (sheet.checked != null ? `, ${sheet.checked} field(s) checked` : '') +
        (unique.length ? `, ${unique.length} mismatch(es): ${shown}${more}` : '') +
        (mismatches.some((m) => /Voyage Summary not found/i.test(String(m.field ?? ''))) ? ', Voyage Summary never appeared' : ''),
    );
  }

  // A field that fails on several sheets usually has one shared cause, so call those out first.
  const byField = new Map();
  for (const sheet of sheets) {
    for (const mismatch of sheet.mismatches ?? []) {
      const field = clean(mismatch.field);
      if (!field) continue;
      const entry = byField.get(field) ?? { sheets: new Set(), label: field };
      entry.sheets.add(`#${sheet.index ?? '?'}`);
      byField.set(field, entry);
    }
  }
  const shared = [...byField.values()]
    .filter((entry) => entry.sheets.size > 1)
    .sort((a, b) => b.sheets.size - a.sheets.size)
    .slice(0, 10)
    .map((entry) => `- ${entry.label}: ${entry.sheets.size} sheet(s) (${[...entry.sheets].join(', ')})`);

  // Errors and warnings from the log, deduplicated; the amounts never appear on these lines.
  const seen = new Set();
  const errors = [];
  for (const raw of String(run.log ?? '').split('\n')) {
    if (!/error|timeout|no backend suggestion|not found|failed|cannot|unable/i.test(raw)) continue;
    const line = errorLine(raw);
    if (!line || seen.has(line)) continue;
    if (/^MISMATCH/i.test(raw)) continue; // field names already cover those
    seen.add(line);
    errors.push(`- ${line}`);
    if (errors.length >= maxErrorLines) break;
  }

  const sections = [
    head.join('\n'),
    failures.length ? `Failing sheets:\n${failures.join('\n')}` : 'Failing sheets: none',
    shared.length ? `Fields failing on more than one sheet:\n${shared.join('\n')}` : '',
    errors.length ? `Log errors (deduplicated):\n${errors.join('\n')}` : '',
  ];
  return sections.filter(Boolean).join('\n\n');
}

/** The instruction the model works from; kept next to the digest so the two cannot drift. */
export const SUMMARY_SYSTEM_PROMPT = [
  'You summarise one run of a Playwright suite that replays voyage-calculation sheets into a web app.',
  'The digest lists field names, sheet numbers, statuses and error lines only. It contains no numeric values at all.',
  'Rules:',
  '- Use only what the digest says. Never invent or estimate amounts, prices, percentages or vessel details.',
  '- If the digest cannot explain something, say "unclear from the digest" rather than guessing.',
  '- Be specific about which sheets and which fields, because that is what the reader will act on.',
  '- Reply in exactly three labelled parts, plain text, no markdown, under 90 words total:',
  'STANDS OUT: one or two sentences.',
  'LIKELY CAUSE: one or two sentences, or "unclear from the digest".',
  'NEXT STEP: one concrete action.',
].join('\n');
