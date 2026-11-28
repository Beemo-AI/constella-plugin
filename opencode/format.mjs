// Compact, prompt-cache-safe formatting for OpenCode v2 context injection.
//
// Design rules:
// - The session-start block is computed ONCE per session and pushed identically on every turn so
//   provider prompt caching stays warm.
// - Hard character caps keep token overhead predictable (`START_CAP = 3500`, `TURN_CAP = 1200`).
// - Works identically for coding repos (repo/files) and non-code teams (role/client/task/topic).

export const START_CAP = 3500;
export const TURN_CAP = 1200;
const HANDOFF_CUT = 900;
const TITLE_CUT = 100;
const ITEM_CUT = 220;
const INDEX_CUT = 180;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Collapse control characters and whitespace into a single line. */
export function oneLine(text) {
  return String(text ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

/** Clip text to a single line of at most `max` characters. */
export function clip(text, max) {
  const t = oneLine(text);
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Keep single newlines (useful for handoff sections), clipped to `max`. */
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

function whoSaved(src) {
  const actor = src && typeof src.actor === 'object' ? src.actor : null;
  if (actor) {
    const parts = [actor.person, actor.agent].filter((v) => typeof v === 'string' && v.trim());
    if (parts.length) return oneLine(parts.join(' via ')).slice(0, 60);
  }
  for (const val of [src?.saved_by, src?.created_by, src?.source?.app]) {
    if (typeof val === 'string' && val.trim()) return oneLine(val).slice(0, 60);
    if (val && typeof val === 'object' && typeof val.name === 'string') return oneLine(val.name).slice(0, 60);
  }
  return '';
}

function scopeBadge(src) {
  const s = oneLine(src?.scope || src?.box_label || src?.reach || '');
  if (!s) return '';
  if (s === 'me' || s === 'personal') return 'personal';
  return s.slice(0, 32);
}

function titleAndText(src, textMax) {
  const title = clip(src?.title, TITLE_CUT);
  const text = clip(src?.text, textMax);
  if (title && text && !text.toLowerCase().startsWith(title.replace(/…$/, '').toLowerCase())) {
    return `${title}: ${text}`;
  }
  return text || title || '(no text)';
}

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

class BudgetLines {
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

/**
 * Format the static session-start memory block (`<constella-memory>...</constella-memory>`).
 * Returns `{ text, shownIds }` so later turn recalls can skip already-shown memory IDs.
 */
export function formatStartBlock(result, { workspaceId = '', repo = '', recallMode = 'hybrid' } = {}) {
  const sources = cleanSources(result?.sources);
  const shownIds = new Set();

  const headerParts = ['<constella-memory>'];
  const scopeLabel = [
    repo ? `repo="${oneLine(repo)}"` : null,
    workspaceId ? `workspace="${oneLine(workspaceId)}"` : null,
  ].filter(Boolean).join(' ');
  headerParts.push(scopeLabel ? `Constella memory loaded (${scopeLabel}).` : 'Constella memory loaded.');

  const guidance = [
    'Memory tools:',
    '- Call `constella_recall` whenever the user asks about past work, people, clients, roles, decisions, or preferences not shown below.',
    '- Call `constella_fetch` with an item `id` to read the full text of any compact index entry below.',
    '- Call `constella_save` to save durable rules, decisions, preferences, or a session handoff. Use `scope="me"` for personal notes and `scope="workspace"` ONLY for facts meant for the whole team.',
  ];
  if (recallMode === 'every_turn') {
    guidance.push('- Automatic per-turn recall is enabled; still call `constella_recall` for targeted or multi-entity lookups.');
  }
  const footer = ['', ...guidance, '</constella-memory>'];

  const overhead = headerParts.join('\n').length + footer.join('\n').length + 120;
  const filler = new BudgetLines(Math.max(400, START_CAP - overhead));

  if (!sources.length) {
    filler.add(['', '(No prior memories matched this session start.)']);
    return {
      text: [...headerParts, ...filler.lines, ...footer].join('\n'),
      shownIds,
    };
  }

  const handoffs = sources.filter((s) => s.tier === 'handoff' || s.kind === 'handoff');
  const rules = sources.filter((s) => (s.tier === 'rule' || s.kind === 'rule') && !handoffs.includes(s));
  const indexItems = sources.filter((s) => s.tier === 'index' && !handoffs.includes(s) && !rules.includes(s));
  const notes = sources.filter((s) => !handoffs.includes(s) && !rules.includes(s) && !indexItems.includes(s));

  if (handoffs.length) {
    const h = handoffs[0];
    const meta = [scopeBadge(h), whoSaved(h)].filter(Boolean).join(' · ');
    const lines = ['', `## Last Handoff${meta ? ` (${meta})` : ''} [id:${h.id}]`, clipLines(h.text || h.title, HANDOFF_CUT)];
    if (filler.add(lines)) shownIds.add(h.id);
  }

  if (rules.length) {
    let headingAdded = false;
    for (const r of rules) {
      const meta = [scopeBadge(r), whoSaved(r)].filter(Boolean).join(' · ');
      const bullet = `- [rule${meta ? `, ${meta}` : ''}] ${titleAndText(r, ITEM_CUT)} [id:${r.id}]`;
      const block = headingAdded ? [bullet] : ['', '## Rules', bullet];
      if (filler.add(block)) {
        headingAdded = true;
        shownIds.add(r.id);
      }
    }
  }

  if (notes.length) {
    let headingAdded = false;
    for (const n of notes) {
      const kind = oneLine(n.kind || 'memory');
      const meta = [kind, scopeBadge(n), whoSaved(n)].filter(Boolean).join(' · ');
      const bullet = `- [${meta}] ${titleAndText(n, ITEM_CUT)} [id:${n.id}]`;
      const block = headingAdded ? [bullet] : ['', '## Relevant Context', bullet];
      if (filler.add(block)) {
        headingAdded = true;
        shownIds.add(n.id);
      }
    }
  }

  if (indexItems.length) {
    let headingAdded = false;
    for (const item of indexItems) {
      const kind = oneLine(item.kind || 'memory');
      const bullet = `- [${kind}] ${titleAndText(item, INDEX_CUT)} [id:${item.id}]`;
      const block = headingAdded ? [bullet] : ['', '## Memory Index (call constella_fetch with id for full text)', bullet];
      if (filler.add(block)) {
        headingAdded = true;
        shownIds.add(item.id);
      }
    }
  }

  if (filler.dropped > 0) {
    filler.lines.push(`(${filler.dropped} more memories omitted; call constella_recall to search.)`);
  }

  return {
    text: [...headerParts, ...filler.lines, ...footer].join('\n'),
    shownIds,
  };
}

/**
 * Fallback instructions block when session-start recall is disabled (`recallMode="tools"`),
 * no token is configured, or the API call fails/times out.
 */
export function formatFallbackBlock({ workspaceId = '' } = {}) {
  const wsLine = workspaceId ? ` Active workspace: "${oneLine(workspaceId)}".` : '';
  return [
    '<constella-memory>',
    `Constella memory tools are available.${wsLine}`,
    '- Call `constella_recall` at the start of work or whenever past context, rules, people, or decisions may help.',
    '- Call `constella_fetch` with an item `id` to read the full body of a recalled memory.',
    '- Call `constella_save` to save durable rules, decisions, preferences, or handoffs (`scope="me"` for personal, `scope="workspace"` only when shared with the team).',
    '</constella-memory>',
  ].join('\n');
}

/**
 * Format dynamic per-turn recall hits (`<constella-turn-recall>`) for `recallMode="every_turn"`
 * or file-edit recall. Skips any IDs already present in `skipIds`. Returns '' when nothing new matches.
 */
export function formatTurnRecallBlock(result, { skipIds = new Set(), label = 'Turn recall' } = {}) {
  const sources = cleanSources(result?.sources).filter((s) => !skipIds.has(s.id));
  if (!sources.length) return { text: '', addedIds: [] };

  const header = [`<constella-turn-recall>`, `${oneLine(label)}:`];
  const footer = ['</constella-turn-recall>'];
  const filler = new BudgetLines(Math.max(200, TURN_CAP - 80));
  const addedIds = [];

  for (const src of sources.slice(0, 6)) {
    const kind = oneLine(src.kind || 'memory');
    const scope = scopeBadge(src);
    const meta = [kind, scope].filter(Boolean).join(' · ');
    const line = `- [${meta}] ${titleAndText(src, ITEM_CUT)} [id:${src.id}]`;
    if (filler.add([line])) {
      addedIds.push(src.id);
    }
  }

  if (!addedIds.length) return { text: '', addedIds: [] };
  return {
    text: [...header, ...filler.lines, ...footer].join('\n'),
    addedIds,
  };
}
