#!/usr/bin/env node
// The one Constella hook, for Claude Code and Codex.
//   start    SessionStart: put the last handoff, the rules and the repo's notes in front of the AI
//   file     PreToolUse on file edits: show what is pinned to that file's folders, once per folder per session
//   compact  PreCompact: tell the summary what to keep (Claude Code only; Codex ignores PreCompact text)
// It never blocks and never breaks a session. On any failure (no key, no git, no network, an error answer,
// bad JSON, too slow) `start` prints a short fallback and the others print nothing. Exit code is always 0
// and nothing is written to stderr. The key is sent only in the Authorization header to the Constella API.
// What leaves the machine: the repo name and the repo-relative paths of files being edited. Never file
// contents, the branch, or the transcript. The branch is only used locally, inside the text shown to the AI.

import { apiBase, apiKey, callTool, saveTo } from './lib/api.mjs';
import { debugLog } from './lib/debug.mjs';
import { compactInstructions, fallbackBlock, fileBlock, startBlock } from './lib/format.mjs';
import { detectHost, editedFiles, pickMode, readStdinJson } from './lib/input.mjs';
import { detectRepo, folderOf, relativeToRepo } from './lib/repo.mjs';
import { loadState, pruneSessions, saveState } from './lib/state.mjs';

// Node 18 prints an "experimental fetch" warning to stderr; a hook must stay silent there.
process.emitWarning = () => {};

const BUDGET_MS = { start: 3000, file: 1500, compact: 500 };
const SAFETY_MS = 80;

let finished = false;
let fallbackOutput = '';
let watchdog = null;

/** Print `text` (if any) and exit 0, exactly once. */
function finish(text) {
  if (finished) return;
  finished = true;
  if (watchdog) clearTimeout(watchdog);
  const exit = () => process.exit(0);
  setTimeout(exit, 300);
  if (!text) return exit();
  try {
    process.stdout.write(text, exit);
  } catch {
    exit();
  }
}

/** A hook answer that adds `text` to the AI's context. Claude Code and Codex read the same shape. */
function contextJson(event, text) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

/** True when the block shows this id: items end with "[id]", the handoff says "id <id>)". */
function wasShown(text, id) {
  return text.includes(`[${id}]`) || text.includes(`id ${id})`);
}

/** Milliseconds left in this run's budget, minus a small safety margin. */
function remaining(started, budget) {
  return Math.max(50, budget - (Date.now() - started) - SAFETY_MS);
}

/** SessionStart: recall the handoff, rules and repo items, and print them as one compact block. */
async function runStart({ env, input, host, started, budget }) {
  const compact = input.source === 'compact';
  const cwd = input.cwd || process.cwd();
  fallbackOutput = contextJson('SessionStart', fallbackBlock({ repo: '', branch: '', compact }));
  const info = await detectRepo(cwd, 700);
  const fallback = contextJson('SessionStart', fallbackBlock({ repo: info.repo, branch: info.branch, compact }));
  fallbackOutput = fallback;
  pruneSessions(env);

  const key = apiKey(env);
  if (!key) {
    debugLog(env, { mode: 'start', host, outcome: 'no_key', repo: info.repo, ms: Date.now() - started });
    return finish(fallback);
  }
  const res = await callTool({
    base: apiBase(env),
    key,
    client: host,
    name: 'memory_recall',
    args: { repo: info.repo, limit: 12, scope: 'all' },
    timeoutMs: remaining(started, budget),
  });
  const sources = res.ok && res.result && Array.isArray(res.result.sources) ? res.result.sources : null;
  if (!sources) {
    debugLog(env, { mode: 'start', host, outcome: 'fallback', status: res.status, code: res.code, error: res.error, repo: info.repo, ms: Date.now() - started });
    return finish(fallback);
  }
  const text = startBlock({ repo: info.repo, branch: info.branch, sources, saveTo: saveTo(env), compact });

  // Remember what this context now holds, so the file hook does not repeat it. A compaction or /clear
  // starts a fresh context, so the folders asked before are asked again.
  const state = loadState(env, input.session_id);
  if (compact || input.source === 'clear') {
    state.asked.clear();
    state.shown.clear();
  }
  for (const src of sources) {
    if (src && src.id != null && wasShown(text, src.id)) state.shown.add(String(src.id));
  }
  saveState(state);
  debugLog(env, { mode: 'start', host, outcome: 'ok', status: res.status, items: sources.length, chars: text.length, repo: info.repo, ms: Date.now() - started });
  return finish(contextJson('SessionStart', text));
}

/** PreToolUse on an edit: once per folder per session, show the `file`-tier items not shown yet. */
async function runFile({ env, input, host, started, budget }) {
  const key = apiKey(env);
  if (!key) return finish('');
  const files = editedFiles(input);
  if (!files.length) return finish('');
  const cwd = input.cwd || process.cwd();
  const info = await detectRepo(cwd, 500);
  if (!info.top) return finish('');
  const rels = [...new Set(files.map((f) => relativeToRepo(info.top, f, cwd)).filter(Boolean))];
  if (!rels.length) {
    debugLog(env, { mode: 'file', host, outcome: 'outside_repo', ms: Date.now() - started });
    return finish('');
  }

  const state = loadState(env, input.session_id);
  const fresh = rels.filter((rel) => !state.asked.has(folderOf(rel))).slice(0, 5);
  if (!fresh.length) return finish('');
  // Mark the folders as asked before calling, so a slow or failing server costs at most one call per folder.
  fresh.forEach((rel) => state.asked.add(folderOf(rel)));
  saveState(state);

  const res = await callTool({
    base: apiBase(env),
    key,
    client: host,
    name: 'memory_recall',
    args: { repo: info.repo, files: fresh, limit: 6 },
    timeoutMs: remaining(started, budget),
  });
  const sources = res.ok && res.result && Array.isArray(res.result.sources) ? res.result.sources : null;
  if (!sources) {
    debugLog(env, { mode: 'file', host, outcome: 'nothing', status: res.status, code: res.code, error: res.error, files: fresh, ms: Date.now() - started });
    return finish('');
  }
  const items = sources.filter((s) => s && s.tier === 'file' && s.id != null && !state.shown.has(String(s.id)));
  if (!items.length) {
    debugLog(env, { mode: 'file', host, outcome: 'no_new_items', status: res.status, files: fresh, ms: Date.now() - started });
    return finish('');
  }
  const text = fileBlock({ files: fresh, repo: info.repo, sources: items });
  items.forEach((s) => wasShown(text, s.id) && state.shown.add(String(s.id)));
  saveState(state);
  debugLog(env, { mode: 'file', host, outcome: 'ok', status: res.status, items: items.length, files: fresh, ms: Date.now() - started });
  return finish(contextJson('PreToolUse', text));
}

/** PreCompact: Claude Code uses plain stdout as instructions for the summary. Codex ignores it, so print nothing. */
function runCompact({ env, host, started }) {
  debugLog(env, { mode: 'compact', host, ms: Date.now() - started });
  return finish(host === 'codex' ? '' : compactInstructions());
}

async function main() {
  const started = Date.now();
  const argv = process.argv.slice(2);
  const env = process.env;
  const early = pickMode(argv, null);
  const budget = BUDGET_MS[early] || 1500;
  watchdog = setTimeout(() => finish(fallbackOutput), budget);

  const input = await readStdinJson(Math.min(1000, budget / 2));
  const mode = early || pickMode([], input);
  const host = detectHost(argv, env, input);
  const ctx = { env, input, host, started, budget };
  if (mode === 'start') return runStart(ctx);
  if (mode === 'file') return runFile(ctx);
  if (mode === 'compact') return runCompact(ctx);
  return finish('');
}

process.on('uncaughtException', () => finish(fallbackOutput));
process.on('unhandledRejection', () => finish(fallbackOutput));
main().catch(() => finish(fallbackOutput));
