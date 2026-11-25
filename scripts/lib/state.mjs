// Small files the hook keeps on this machine, in the plugin's data folder:
//   sessions/<session_id>.json   folders already asked about and memory ids already shown, per session
//   debug.log                    only when CONSTELLA_DEBUG=1 (see debug.mjs)
// Nothing here ever holds the key, a file's contents or the session transcript.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The plugin's data folder: CLAUDE_PLUGIN_DATA (Claude Code; Codex sets it too), else PLUGIN_DATA (Codex),
 * else <os temp>/constella-agent-plugin.
 */
export function dataDir(env = process.env) {
  return env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA || path.join(os.tmpdir(), 'constella-agent-plugin');
}

function safeId(sessionId) {
  const clean = String(sessionId || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
  return clean && clean !== '.' && clean !== '..' ? clean : 'unknown';
}

/** Load one session's state. Returns { file, asked: Set<folder>, shown: Set<id> }; empty sets when new or unreadable. */
export function loadState(env, sessionId) {
  const file = path.join(dataDir(env), 'sessions', `${safeId(sessionId)}.json`);
  const state = { file, asked: new Set(), shown: new Set() };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw.asked)) raw.asked.forEach((f) => typeof f === 'string' && state.asked.add(f));
    if (Array.isArray(raw.shown)) raw.shown.forEach((id) => typeof id === 'string' && state.shown.add(id));
  } catch {
    /* new session or unreadable file: start empty */
  }
  return state;
}

/** Save a session's state (write to a temp file, then rename, so a half-written file is never read). Never throws. */
export function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(state.file), { recursive: true });
    const tmp = `${state.file}.${process.pid}.tmp`;
    const body = { asked: [...state.asked].slice(-500), shown: [...state.shown].slice(-1000), saved_at: Date.now() };
    fs.writeFileSync(tmp, JSON.stringify(body));
    fs.renameSync(tmp, state.file);
    return true;
  } catch {
    return false;
  }
}

/** Delete session files older than a week, so the folder does not grow forever. Never throws. */
export function pruneSessions(env, now = Date.now(), maxAgeMs = WEEK_MS) {
  try {
    const dir = path.join(dataDir(env), 'sessions');
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > maxAgeMs) fs.unlinkSync(file);
      } catch {
        /* skip this one */
      }
    }
  } catch {
    /* no folder yet */
  }
}
