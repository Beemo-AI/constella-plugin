// `constella setup`: one command that signs the person in once and sets Constella memory up in every AI
// tool on this computer (Claude Code, Codex, Cursor). Safe to run again: each step only repairs or updates.
//
//   1. Find a key: CONSTELLA_API_KEY (saved for later), else the key saved before, else sign in in the
//      browser (signin.mjs). The browser sign-in runs in a helper process, so when this command is cut short
//      (an AI tool's time limit) running it again picks the same sign-in up.
//   2. Check the key with the server.
//   3. Set each tool up (tools.mjs).
//   4. Print one line per step, then the steps only the person can do.
//
// Exit codes: 0 all done, 1 something failed, 3 still waiting for the person to sign in (run it again).
// The key is never printed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_API, VERSION } from './api.mjs';
import { readCredentials, removeCredentials, sameServer, savedFor, writeCredentials } from './credentials.mjs';
import { clearSignIn, liveSignIn, openBrowser, readSignIn, startSignInHelper } from './signin.mjs';
import { MARKETPLACE_SOURCE, setUpClaudeCode, setUpCodex, setUpCursor } from './tools.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ask the server whether a key works. Returns 'ok', 'refused' (401/403) or 'unreachable'. */
export async function checkKey(base, key) {
  try {
    const res = await fetch(`${base}/platform/v1/me/tools`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': `constella-agent-plugin/${VERSION}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return 'ok';
    return res.status === 401 || res.status === 403 ? 'refused' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/** The email this person uses for Claude Code, to fill the email box on the sign-in page. '' when unknown. */
export function claudeCodeEmail(env = process.env) {
  const candidates = [env.CLAUDE_CONFIG_DIR && path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), path.join(os.homedir(), '.claude.json')].filter(Boolean);
  for (const file of candidates) {
    try {
      const email = JSON.parse(fs.readFileSync(file, 'utf8'))?.oauthAccount?.emailAddress;
      if (typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email.trim();
    } catch {
      /* no such file, or not JSON */
    }
  }
  return '';
}

/**
 * Step 1 and 2. Returns one of:
 *   { key, base, email, how }   a key that the server accepts ("how" says where it came from)
 *   { waiting: true, url }      the person has not finished signing in yet
 *   { error }                   what went wrong, in plain words
 */
async function findKey({ env, cliPath, flags, waitMs }) {
  const wanted = String(env.CONSTELLA_API_URL || '').trim().replace(/\/+$/, '');

  const fromEnv = String(env.CONSTELLA_API_KEY || '').trim();
  if (fromEnv) {
    const base = wanted || DEFAULT_API;
    const state = await checkKey(base, fromEnv);
    if (state === 'refused') return { error: `${base} did not accept the key in CONSTELLA_API_KEY. Make a new one (Constella app: Settings > Developer), or unset it to sign in in the browser.` };
    if (state === 'unreachable') return { error: `${base} could not be reached. A sandbox with no network also causes this.` };
    writeCredentials({ api_key: fromEnv, api_url: base }, env);
    return { key: fromEnv, base, email: '', how: 'the key in CONSTELLA_API_KEY (now saved for your tools)' };
  }

  const saved = savedFor(wanted, env);
  if (saved) {
    const state = await checkKey(saved.api_url, saved.api_key);
    if (state === 'ok') {
      if (!liveSignIn(env)) clearSignIn(env); // a finished sign-in's note is no longer needed
      return { key: saved.api_key, base: saved.api_url, email: saved.email, how: 'the key saved on this computer' };
    }
    if (state === 'unreachable') return { error: `${saved.api_url} could not be reached. A sandbox with no network also causes this.` };
    removeCredentials(env); // the saved key no longer works: sign in again
  }

  // A sign-in that just failed (the person did go through the browser): say why, once, before starting over.
  const last = readSignIn(env);
  if (last && last.status === 'error' && Date.now() - Number(last.started_at || 0) < 15 * 60 * 1000) {
    clearSignIn(env);
    return { error: last.message || 'The sign-in failed. Run setup again.' };
  }

  // Browser sign-in. Pick up one that is already waiting, else start a new one.
  let waitingOn = liveSignIn(env);
  const reused = Boolean(waitingOn);
  if (!waitingOn) {
    const hint = flags.email !== undefined ? flags.email : claudeCodeEmail(env);
    startSignInHelper(cliPath, env, { emailHint: hint });
    for (let i = 0; i < 100 && !waitingOn; i += 1) {
      await sleep(150);
      const state = readSignIn(env);
      if (state && state.status === 'error') return { error: state.message || 'The sign-in could not start.' };
      if (state && state.status === 'done') break;
      waitingOn = liveSignIn(env);
    }
    if (!waitingOn && !(readSignIn(env) || {}).status) return { error: 'The sign-in could not start. Run setup again, or set CONSTELLA_API_KEY and run it.' };
  }

  // Open the browser once, as soon as the sign-in link is known (never again for a sign-in picked up later).
  let opened = reused || Boolean(flags['no-open']);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const state = readSignIn(env) || {};
    if (!opened && state.status === 'waiting' && state.url) {
      openBrowser(state.url, env);
      opened = true;
    }
    if (state.status === 'done') {
      clearSignIn(env);
      const now = readCredentials(env);
      if (!now) return { error: 'The sign-in finished but no key was saved. Run setup again.' };
      return { key: now.api_key, base: now.api_url, email: now.email, how: 'your browser sign-in' };
    }
    if (state.status === 'error') {
      clearSignIn(env);
      return { error: state.message || 'The sign-in failed. Run setup again.' };
    }
    if (Date.now() >= deadline) return { waiting: true, url: (waitingOn && waitingOn.url) || state.url || '' };
    await sleep(400);
  }
}

/**
 * Run setup and print the report. Returns the exit code.
 * flags: --wait <seconds> (default 100), --no-open, --email <address>, --only claude,codex,cursor
 */
export async function runSetup({ env = process.env, flags = {}, cliPath, out = (text) => process.stdout.write(text) } = {}) {
  const lines = [];
  const todos = [];
  const say = (state, name, text) => lines.push(`${state.padEnd(5)} ${name.padEnd(8)} ${text}`);
  const waitMs = Math.max(0, Math.min(600, Number(flags.wait === undefined ? 100 : flags.wait) || 0)) * 1000;

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    out(`FAIL  node     v${process.versions.node} is too old; Node 18 or newer is needed\n`);
    return 1;
  }

  const found = await findKey({ env, cliPath, flags, waitMs });
  if (found.waiting) {
    out(
      [
        'wait  sign-in  Waiting for you to sign in to Constella in your browser.',
        '',
        found.url ? `If no browser tab opened, open this link:\n${found.url}\n` : '',
        'Sign in, press Allow, then run this same command again. Nothing is set up yet.',
        '',
      ].join('\n'),
    );
    return 3;
  }
  if (found.error) {
    out(`FAIL  sign-in  ${found.error}\n`);
    return 1;
  }
  say('ok', 'sign-in', `${found.email ? `signed in as ${found.email}` : 'signed in'}, using ${found.how}`);

  const mcp = String(env.CONSTELLA_MCP_URL || '').trim() || `${found.base}/mcp`;
  // The tools below run as their own programs: tell them which server, never the key.
  const toolEnv = { ...env };
  if (!sameServer(found.base, DEFAULT_API)) toolEnv.CONSTELLA_API_URL = found.base;
  const only = flags.only ? new Set(String(flags.only).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) : null;
  const source = env.CONSTELLA_PLUGIN_SOURCE || MARKETPLACE_SOURCE;
  const steps = [
    ['claude', () => setUpClaudeCode({ env: toolEnv, mcp, source })],
    ['codex', () => setUpCodex({ env: toolEnv, mcp, key: found.key, source })],
    ['cursor', () => setUpCursor({ env: toolEnv, mcp, key: found.key })],
  ];
  let installed = 0;
  for (const [name, step] of steps) {
    if (only && !only.has(name)) continue;
    let result;
    try {
      result = step();
    } catch (err) {
      result = { state: 'FAIL', text: String((err && err.message) || err) };
    }
    say(result.state, name, result.text);
    if (result.state === 'ok') installed += 1;
    if (result.todo) todos.push(result.todo);
  }
  if (!installed && !lines.some((l) => l.startsWith('FAIL'))) {
    say('FAIL', 'tools', 'no AI tool was found here (looked for Claude Code, Codex and Cursor). Your key is saved, so memory works once you install one and run this again.');
  }

  const report = [...lines, ''];
  if (todos.length) {
    report.push('Only you can do this:');
    todos.forEach((todo, i) => report.push(`  ${i + 1}. ${todo}`));
    report.push('');
  }
  if (installed) {
    report.push('Then start a new session in each tool, inside a git repo, and ask:');
    report.push('  "What does your Constella memory block say?"');
    report.push('');
  }
  out(report.join('\n'));
  return lines.some((l) => l.startsWith('FAIL')) ? 1 : 0;
}

/** `constella logout`: forget the key saved on this computer. The tools' own settings are left as they are. */
export function runLogout({ env = process.env, out = (text) => process.stdout.write(text) } = {}) {
  clearSignIn(env);
  const removed = removeCredentials(env);
  out(removed ? 'The key saved on this computer was removed. Codex and Cursor keep their own copy in their settings until you run setup again or remove it there.\n' : 'No saved key was found.\n');
  return 0;
}
