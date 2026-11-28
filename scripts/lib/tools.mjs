// What `constella setup` does inside each AI tool it finds on this computer.
//
//   Claude Code  installs the plugin with the tool's own commands. The plugin's MCP server reads the saved key
//                by itself (scripts/mcp-headers.mjs), so nothing secret is written into Claude Code's settings.
//   Codex        installs the plugin, and writes one table, [mcp_servers.constella], into ~/.codex/config.toml
//                with the key in a header (Codex has no helper to fetch it, and an app opened from the Dock
//                sees no shell variables). Hook trust stays with the person: Codex wants a human to do it.
//   Cursor       adds the server to ~/.cursor/mcp.json.
//
// Every function returns { state: 'ok' | 'skip' | 'FAIL', text, todo? } and never throws. `todo` is a step
// only the person can do. The key is never printed and never passed on a command line.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { homeDir, sameServer } from './credentials.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OPENCODE_PLUGIN_ID = 'constella-memory';
const OPENCODE_PLUGIN_FILES = ['index.mjs', 'plugin.mjs', 'client.mjs', 'format.mjs', 'transcript.mjs', 'package.json'];

export const MARKETPLACE_SOURCE = 'Beemo-AI/constella-plugin';
const PLUGIN = 'constella@constella';

/** Run a command and collect what it printed. Never throws; a missing program gives code 127. */
export function run(cmd, args, { env = process.env, timeoutMs = 180000 } = {}) {
  const res = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  if (res.error) return { code: res.error.code === 'ENOENT' ? 127 : 1, out: String(res.error.message || '') };
  return { code: res.status === null ? 1 : res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}

function found(cmd, env) {
  return run(cmd, ['--version'], { env, timeoutMs: 20000 }).code === 0;
}

function lastLine(text) {
  const lines = String(text || '').trim().split('\n').filter((l) => l.trim());
  return (lines[lines.length - 1] || '').trim().slice(0, 200);
}

function writeFileAtomic(file, text, mode) {
  const tmp = `${file}.${process.pid}.constella-tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

function modeOf(file, fallback) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return fallback;
  }
}

// ----------------------------------------------------------------------------------------------- Claude Code

/**
 * Install (or update) the plugin in Claude Code. `source` is the marketplace to add: the GitHub repo by
 * default, or a local folder (CONSTELLA_PLUGIN_SOURCE) when trying a copy that is not pushed yet.
 */
export function setUpClaudeCode({ env = process.env, mcp, source = MARKETPLACE_SOURCE } = {}) {
  if (!found('claude', env)) return { state: 'skip', text: 'not found on this computer' };

  // Add the marketplace (a no-op or an error when it is already there), then always bring it up to date.
  const added = run('claude', ['plugin', 'marketplace', 'add', source], { env });
  const updated = run('claude', ['plugin', 'marketplace', 'update', 'constella'], { env });
  if (added.code !== 0 && updated.code !== 0) {
    return { state: 'FAIL', text: `could not add the plugin marketplace: ${lastLine(added.out) || lastLine(updated.out)}` };
  }
  const installed = run('claude', ['plugin', 'install', PLUGIN], { env });
  if (installed.code !== 0 && !/already installed/i.test(installed.out)) {
    return { state: 'FAIL', text: `could not install the plugin: ${lastLine(installed.out)}` };
  }
  run('claude', ['plugin', 'update', PLUGIN], { env }); // a no-op when it is already the newest
  run('claude', ['plugin', 'enable', PLUGIN], { env }); // a no-op when it is already on

  // A `constella` server the person added themselves wins over the plugin's copy (Claude Code keeps one per
  // address). With a key and no catalog header that server gives the older tool names, and the skills can't save.
  const own = run('claude', ['mcp', 'get', 'constella'], { env, timeoutMs: 60000 });
  const ownUrl = (own.out.match(/^\s*URL:\s*(\S+)/m) || [])[1] || '';
  if (own.code === 0 && ownUrl && sameServer(ownUrl, mcp)) {
    const scope = /Scope:\s*Local/i.test(own.out) ? 'local' : /Scope:\s*Project/i.test(own.out) ? 'project' : 'user';
    if (/Authorization:/i.test(own.out) && !/X-Constella-Tools:\s*catalog/i.test(own.out)) {
      return {
        state: 'ok',
        text: 'plugin installed, but your own "constella" server is used and it gives the older tool names',
        todo: `Claude Code: remove your older Constella server so the plugin's own one is used: claude mcp remove constella -s ${scope}`,
      };
    }
    return { state: 'ok', text: 'plugin installed (skills and hooks); the memory tools come from the "constella" server you already added' };
  }
  return { state: 'ok', text: 'plugin installed; its memory tools, skills and hooks use your saved key' };
}

// ------------------------------------------------------------------------------------------------------ Codex

export function codexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

const TABLE_LINE = /^\s*\[\[?[^\]]+\]\]?\s*(#.*)?$/;
const OUR_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*(constella|"constella")\s*(\.[^\]]*)?\]\s*(#.*)?$/;
const OUR_NOTE = '# Added by `constella setup`. It holds your Constella key: keep this file private.';

/**
 * Return `text` (a config.toml) with the [mcp_servers.constella] table set to `block`.
 * Any older table of that name (and its sub-tables) is taken out first; every other line is kept as it was.
 */
export function withCodexServer(text, block) {
  const kept = [];
  let skipping = false;
  for (const line of String(text || '').split('\n')) {
    if (TABLE_LINE.test(line)) skipping = OUR_TABLE.test(line);
    if (skipping) continue;
    kept.push(line);
  }
  const body = kept.filter((line) => line.trim() !== OUR_NOTE).join('\n').trimEnd();
  return `${body ? `${body}\n\n` : ''}${OUR_NOTE}\n${block.trim()}\n`;
}

function codexBlock(mcp, key) {
  const q = JSON.stringify; // these values are plain ASCII, so a JSON string is also a TOML string
  return `[mcp_servers.constella]\nurl = ${q(mcp)}\nhttp_headers = { Authorization = ${q(`Bearer ${key}`)}, "X-Constella-Client" = "codex", "X-Constella-Tools" = "catalog" }`;
}

/** Install the plugin in Codex and point its `constella` server at the saved key. */
export function setUpCodex({ env = process.env, mcp, key, source = MARKETPLACE_SOURCE } = {}) {
  if (!found('codex', env)) return { state: 'skip', text: 'not found on this computer' };

  const added = run('codex', ['plugin', 'marketplace', 'add', source], { env });
  if (added.code !== 0) return { state: 'FAIL', text: `could not add the plugin marketplace: ${lastLine(added.out)}` };
  run('codex', ['plugin', 'marketplace', 'upgrade', 'constella'], { env });
  const installed = run('codex', ['plugin', 'add', PLUGIN], { env });
  if (installed.code !== 0) return { state: 'FAIL', text: `could not install the plugin: ${lastLine(installed.out)}` };

  const file = path.join(codexHome(env), 'config.toml');
  let before = '';
  try {
    before = fs.readFileSync(file, 'utf8');
  } catch {
    before = '';
  }
  const mode = modeOf(file, 0o600);
  try {
    writeFileAtomic(file, withCodexServer(before, codexBlock(mcp, key)), mode);
  } catch (err) {
    return { state: 'FAIL', text: `plugin installed, but ${file} could not be written (${String((err && err.message) || err)})` };
  }
  // Let Codex read its own settings back. If it can't, put the file back exactly as it was.
  const check = run('codex', ['mcp', 'list'], { env, timeoutMs: 60000 });
  if (check.code !== 0 || !/^constella\s/m.test(check.out)) {
    try {
      writeFileAtomic(file, before, mode);
    } catch {
      /* the check below reports it */
    }
    return { state: 'FAIL', text: `plugin installed, but Codex did not accept the new server entry; ${file} was put back as it was` };
  }

  const trusted = /\[hooks\.state\."constella@constella:[^\]]*session_start/.test(before);
  return {
    state: 'ok',
    text: `plugin installed; the memory tools use your saved key (written to ${file})`,
    todo: trusted
      ? 'Codex: if a new session shows no Constella memory block, type /hooks and trust the Constella hooks again (Codex asks again after a plugin update).'
      : 'Codex: start Codex, type /hooks, and trust the Constella hooks. In the Codex app: Settings > Hooks. Until then memory does not load by itself.',
  };
}

// ----------------------------------------------------------------------------------------------------- Cursor

/** Add the server to ~/.cursor/mcp.json, when Cursor has been used on this computer. */
export function setUpCursor({ env = process.env, mcp, key } = {}) {
  const dir = env.CONSTELLA_CURSOR_HOME || path.join(os.homedir(), '.cursor');
  if (!fs.existsSync(dir)) return { state: 'skip', text: 'not found on this computer' };
  const file = path.join(dir, 'mcp.json');
  let config = {};
  if (fs.existsSync(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { state: 'FAIL', text: `${file} is not valid JSON, so it was left alone; fix it and run setup again` };
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { state: 'FAIL', text: `${file} is not a JSON object, so it was left alone` };
  }
  const servers = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {};
  servers.constella = { url: mcp, headers: { Authorization: `Bearer ${key}`, 'X-Constella-Client': 'cursor', 'X-Constella-Tools': 'catalog' } };
  config.mcpServers = servers;
  try {
    writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`, modeOf(file, 0o600));
  } catch (err) {
    return { state: 'FAIL', text: `${file} could not be written (${String((err && err.message) || err)})` };
  }
  return { state: 'ok', text: `memory tools added to ${file} (Cursor has no hooks: its skills are a copy step, see cursor/README.md)` };
}

// --------------------------------------------------------------------------------------------------- OpenCode

/** Folder where OpenCode reads its user config (`opencode.json` / `opencode.jsonc`). */
export function openCodeHome(env = process.env) {
  if (env.CONSTELLA_OPENCODE_HOME) return env.CONSTELLA_OPENCODE_HOME;
  const xdg = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'opencode');
}

/**
 * Parse JSON or JSONC (line `//`, block `/* *\/`, and trailing commas outside string literals).
 * Throws SyntaxError on invalid input.
 */
export function parseJsonc(raw) {
  let out = '';
  let inString = false;
  let escape = false;
  let i = 0;
  const text = String(raw || '');
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  const withoutTrailingCommas = out.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(withoutTrailingCommas);
}

/** Return a copy of OpenCode's config object with `constella-memory` registered once under `plugins`. */
export function withOpenCodePlugin(config, pluginSource) {
  const base = config && typeof config === 'object' && !Array.isArray(config) ? { ...config } : {};
  const existing = Array.isArray(base.plugins) ? base.plugins : [];
  let prevOptions = null;
  const kept = [];
  for (const entry of existing) {
    if (typeof entry === 'string') {
      if (entry === OPENCODE_PLUGIN_ID || entry.includes('constella-plugin') || entry.includes('opencode-plugin')) continue;
      kept.push(entry);
      continue;
    }
    if (entry && typeof entry === 'object' && entry.id === OPENCODE_PLUGIN_ID) {
      if (entry.options && typeof entry.options === 'object' && !Array.isArray(entry.options)) {
        prevOptions = { ...entry.options };
      }
      continue;
    }
    kept.push(entry);
  }
  const options = { recallMode: 'hybrid', ...(prevOptions || {}) };
  kept.push({ id: OPENCODE_PLUGIN_ID, source: pluginSource, options });
  base.plugins = kept;
  return base;
}

/** Copy the self-contained `opencode/` plugin files into `~/.constella/opencode-plugin` (stable across npx runs). */
function installOpenCodeFiles(env) {
  const srcDir = path.join(REPO_ROOT, 'opencode');
  const destDir = path.join(homeDir(env), 'opencode-plugin');
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  for (const name of OPENCODE_PLUGIN_FILES) {
    const src = path.join(srcDir, name);
    if (!fs.existsSync(src)) continue;
    const content = fs.readFileSync(src, 'utf8');
    writeFileAtomic(path.join(destDir, name), content, 0o644);
  }
  return destDir;
}

/**
 * Install the Constella OpenCode v2 plugin when OpenCode is installed on this computer.
 * Writes NO secrets into `opencode.json` — the plugin reads `~/.constella/credentials.json` directly.
 */
export function setUpOpenCode({ env = process.env, source } = {}) {
  const explicitDir = Boolean(env.CONSTELLA_OPENCODE_HOME && fs.existsSync(env.CONSTELLA_OPENCODE_HOME));
  if (!found('opencode', env) && !explicitDir) return { state: 'skip', text: 'not found on this computer' };

  const dir = openCodeHome(env);
  fs.mkdirSync(dir, { recursive: true });
  const jsoncPath = path.join(dir, 'opencode.jsonc');
  const jsonPath = path.join(dir, 'opencode.json');
  const file = fs.existsSync(jsoncPath) ? jsoncPath : jsonPath;

  let config = {};
  if (fs.existsSync(file)) {
    try {
      config = parseJsonc(fs.readFileSync(file, 'utf8'));
    } catch {
      return { state: 'FAIL', text: `${file} is not valid JSON/JSONC, so it was left alone; fix it and run setup again` };
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return { state: 'FAIL', text: `${file} is not a JSON object, so it was left alone` };
    }
  }

  let pluginSource = env.CONSTELLA_OPENCODE_SOURCE || (source && source !== MARKETPLACE_SOURCE ? source : '');
  if (!pluginSource) {
    try {
      pluginSource = installOpenCodeFiles(env);
    } catch (err) {
      return { state: 'FAIL', text: `could not copy OpenCode plugin files (${String((err && err.message) || err)})` };
    }
  }

  const updated = withOpenCodePlugin(config, pluginSource);
  try {
    writeFileAtomic(file, `${JSON.stringify(updated, null, 2)}\n`, modeOf(file, 0o600));
  } catch (err) {
    return { state: 'FAIL', text: `${file} could not be written (${String((err && err.message) || err)})` };
  }
  return { state: 'ok', text: `plugin registered in ${file} (reads your saved key from ~/.constella/credentials.json)` };
}
