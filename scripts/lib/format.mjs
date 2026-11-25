// The text the hooks put in front of the AI. Short, plain, and always under a hard character cap.

export const START_CAP = 3500;
export const FILE_CAP = 1500;
const HANDOFF_CUT = 900;
const TITLE_CUT = 100;
const ITEM_CUT = 220;
const FILE_ITEM_CUT = 300;
const MORE_RESERVE = 110;
const NOTE_ORDER = ['file', 'repo', 'search'];

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** One line: control characters and runs of spaces or newlines become one space. */
export function oneLine(text) {
  return String(text ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

/** `text` as one line, cut to at most `max` characters with "…" at the end when cut. */
export function clip(text, max) {
  const t = oneLine(text);
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Like clip, but keeps single line breaks (for a handoff's Goal / Done / Next parts). */
function clipLines(text, max) {
  const t = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** A repo or branch name safe to place inside quotes in the text. */
function safeName(value, fallback) {
  const clean = oneLine(value).replace(/["\\`]/g, '').slice(0, 200);
  return clean || fallback;
}

/** "just now", "12 min ago", "3 h ago", "5 days ago", or a date for older things. '' when unknown. */
export function ageText(ms, now = Date.now()) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const seconds = Math.max(0, (now - ms) / 1000);
  if (seconds < 90) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  const hours = minutes / 60;
  if (hours < 36) return `${Math.round(hours)} h ago`;
  const days = hours / 24;
  if (days < 60) return `${Math.round(days)} days ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

/** When a recalled item last changed, in ms: updated_at_ms, else created, else source.at. */
function whenMs(src) {
  for (const value of [src.updated_at_ms, src.source_created_at_ms]) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const at = src.source && src.source.at;
  const parsed = typeof at === 'number' ? at : Date.parse(at || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Who saved a recalled item (an AI tool or a person), or ''. */
function whoSaved(src) {
  for (const value of [src.saved_by, src.created_by, src.source && src.source.app]) {
    if (typeof value === 'string' && value.trim()) return oneLine(value).slice(0, 60);
    if (value && typeof value === 'object' && typeof value.name === 'string') return oneLine(value.name).slice(0, 60);
  }
  return '';
}

/** "title: text" without saying the same words twice. */
function titleAndText(src, textMax) {
  const title = clip(src.title, TITLE_CUT);
  const text = clip(src.text, textMax);
  if (title && text && !text.toLowerCase().startsWith(title.replace(/…$/, '').toLowerCase())) return `${title}: ${text}`;
  return text || title || '(no text)';
}

/** Keep sources that are objects with an id, first copy of each id only. */
function cleanSources(sources) {
  const seen = new Set();
  const out = [];
  for (const src of Array.isArray(sources) ? sources : []) {
    if (!src || typeof src !== 'object') continue;
    const id = typeof src.id === 'string' || typeof src.id === 'number' ? String(src.id) : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...src, id });
  }
  return out;
}

/** Adds lines while they fit in `budget` characters. */
class Filler {
  constructor(budget) {
    this.budget = budget;
    this.lines = [];
    this.dropped = 0;
  }

  add(lines) {
    const size = lines.reduce((n, line) => n + line.length + 1, 0);
    if (size > this.budget) {
      this.dropped += 1;
      return false;
    }
    this.lines.push(...lines);
    this.budget -= size;
    return true;
  }
}

const ID_BAD_CHARS = /[^A-Za-z0-9._:@-]/g;
const ID_MAX = 128;

/**
 * The handoff memory id for a repo and branch. The server only takes ids made of letters, digits and
 * . _ : @ - (at most 128 characters), so every other character becomes "-" and the repo part is lowercased:
 *   ("Acme/Web-App", "feat/login") -> "handoff:acme-web-app@feat-login"
 * A missing branch becomes "none"; a detached HEAD becomes "detached".
 */
export function handoffId(repo, branch) {
  const r = (String(repo || '').trim().toLowerCase() || 'repo').replace(ID_BAD_CHARS, '-');
  const raw = String(branch || '').trim();
  const b = (raw === 'HEAD' ? 'detached' : raw || 'none').replace(ID_BAD_CHARS, '-');
  return `handoff:${r}@${b}`.slice(0, ID_MAX);
}

/** The line added after a compaction: save a handoff now if there is none yet. */
export function compactLine(repo, branch) {
  const r = safeName(repo, 'owner/name');
  return `Context was just compacted. If a handoff for this work is not saved yet, save one now: memory_add(kind="handoff", id="${handoffId(repo, branch)}", places=[{"repo": "${r}"}], text="Goal: ... Done: ... Next: ... Open questions: ... Branch and key files: ...").`;
}

function howToUse(repo, branch, saveTo) {
  const r = safeName(repo, 'owner/name');
  const to = safeName(saveTo, 'me');
  return [
    `How to use: recall more with memory_recall(repo="${r}", query="..."). Save decisions with memory_add(kind="decision", text="...", places=[{"repo": "${r}", "path": "..."}], to="${to}"). Update one with replaces=<id>.`,
    `Before stopping or switching tools, save a handoff: memory_add(kind="handoff", id="${handoffId(repo, branch)}", places=[{"repo": "${r}"}], text="Goal / Done / Next / Open questions / Branch and key files", to="${to}"). If the last handoff came from another tool, also pass replaces=<its id>.`,
  ].join('\n');
}

/**
 * The session-start block: last handoff, then rules, then decisions and notes for the repo.
 * Inputs: repo, branch, the recall `sources`, where saves go, whether this start follows a compaction.
 * Order inside each part is the server's (newest first). Items that do not fit the cap are left out and counted.
 */
export function startBlock({ repo, branch, sources, saveTo = 'me', compact = false, now = Date.now(), cap = START_CAP }) {
  const header = `Constella memory (repo: ${safeName(repo, 'unknown')}, branch: ${safeName(branch, 'unknown')})`;
  const extra = compact ? compactLine(repo, branch) : '';
  const footer = howToUse(repo, branch, saveTo);
  const fixed = header.length + 1 + (extra ? extra.length + 1 : 0) + footer.length + MORE_RESERVE;
  const fill = new Filler(cap - fixed);

  const list = cleanSources(sources);
  const handoff = list.find((s) => s.tier === 'handoff');
  const rules = list.filter((s) => s.tier === 'rule');
  // Notes pinned to files first, then whole-repo notes, then search hits; server order inside each tier.
  const rank = (s) => NOTE_ORDER.indexOf(s.tier) + 1 || NOTE_ORDER.length + 1;
  const notes = list
    .filter((s) => s.tier !== 'rule' && s.tier !== 'handoff')
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
    .map(({ s }) => s);

  if (handoff) {
    const about = [whoSaved(handoff), ageText(whenMs(handoff), now), `id ${handoff.id}`].filter(Boolean).join(', ');
    const text = clipLines(handoff.text || handoff.title, HANDOFF_CUT);
    fill.add([`Last handoff (${about}): ${text}`]);
  }
  for (const [heading, items] of [['Rules:', rules], ['Decisions and notes for this repo:', notes]]) {
    let first = true;
    for (const src of items) {
      // Name the tool that saved it, so the reader knows whose decision it is before changing it.
      const who = whoSaved(src);
      const line = `- ${titleAndText(src, ITEM_CUT)}   [${src.id}]${who ? ` (saved by ${who})` : ''}`;
      if (fill.add(first ? [heading, line] : [line])) first = false;
    }
  }
  if (!list.length) fill.add(['No saved handoff, rules or decisions for this repo yet.']);

  const out = [header];
  if (extra) out.push(extra);
  out.push(...fill.lines);
  if (fill.dropped) {
    out.push(`(${fill.dropped} more not shown here; memory_recall(repo="${safeName(repo, 'owner/name')}") lists them.)`);
  }
  out.push(footer);
  return out.join('\n').slice(0, cap);
}

/** The short text used when memory could not be loaded (no key, no network, an error, too slow). */
export function fallbackBlock({ repo, branch, compact = false }) {
  const r = safeName(repo, 'owner/name');
  const lines = [
    `Constella memory is connected for this repo (repo: ${r}, branch: ${safeName(branch, 'unknown')}), but its saved rules, decisions and last handoff were not loaded automatically.`,
    `Before starting, call memory_recall(repo="${r}", files=[the files you expect to touch]) to load them.`,
    `Save new decisions with memory_add(..., places=[{"repo": "${r}"}]), and before stopping or switching tools a handoff: memory_add(kind="handoff", id="${handoffId(repo, branch)}", places=[{"repo": "${r}"}], text="Goal / Done / Next / Open questions / Branch and key files").`,
  ];
  if (compact) lines.push(compactLine(repo, branch));
  return lines.join('\n');
}

/**
 * The block shown before a file edit: rules and decisions pinned to these files or their folders.
 * Inputs: the repo-relative files, the repo, and the `file`-tier sources not shown before.
 */
export function fileBlock({ files, repo, sources, now = Date.now(), cap = FILE_CAP }) {
  const list = cleanSources(sources);
  const where = files.length === 1 ? `${files[0]} or its folders` : 'the files being edited';
  const header = `Constella memory pinned to ${where} (repo: ${safeName(repo, 'unknown')}), saved by the user or their AI tools:`;
  const fill = new Filler(cap - header.length - 1 - MORE_RESERVE);
  for (const src of list) {
    const about = [whoSaved(src), ageText(whenMs(src), now)].filter(Boolean).join(', ');
    fill.add([`- ${titleAndText(src, FILE_ITEM_CUT)}   [${src.id}]${about ? ` (${about})` : ''}`]);
  }
  const out = [header, ...fill.lines];
  if (fill.dropped) out.push(`(${fill.dropped} more: memory_recall(repo="${safeName(repo, 'owner/name')}", files=[...]).)`);
  return out.join('\n').slice(0, cap);
}

/** What the PreCompact hook asks the summary to keep. */
export function compactInstructions() {
  return [
    'In the summary, keep: the decisions made and why, what is done, what is next, the open questions, and the branch and key files.',
    'Also say whether a Constella handoff (memory_add with kind="handoff") was saved for this work yet.',
  ].join('\n');
}
