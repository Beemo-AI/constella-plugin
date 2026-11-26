// Shared test helpers: a fake Constella API on 127.0.0.1, throwaway git repos, and a way to run the
// hook or the CLI as a child process with a clean environment (no real key, no real network).

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK = path.join(ROOT, 'scripts', 'constella-hook.mjs');
export const CLI = path.join(ROOT, 'scripts', 'constella.mjs');
export const FAKE_KEY = 'csk_test_SECRETdoNotLeak123';

/**
 * Start a fake API. `reply(req)` decides each answer: { status, body, raw, delayMs }.
 * Every request is recorded in `server.requests` as { method, url, headers, body }.
 */
export async function fakeApi(reply = () => ({ status: 200, body: { result: { sources: [] } } })) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', async () => {
      let body = null;
      try {
        body = JSON.parse(data);
      } catch {
        body = data;
      }
      const entry = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(entry);
      const answer = (await reply(entry)) || {};
      const send = () => {
        if (res.writableEnded) return;
        res.writeHead(answer.status || 200, { 'content-type': 'application/json' });
        res.end(answer.raw !== undefined ? answer.raw : JSON.stringify(answer.body ?? {}));
      };
      if (answer.delayMs) setTimeout(send, answer.delayMs);
      else send();
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        sockets.forEach((s) => s.destroy());
        server.close(() => resolve());
      }),
  };
}

/** A port with nothing listening on it (a server that is down). */
export async function deadUrl() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

/** A fresh temp folder. */
export function tempDir(prefix = 'constella-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Remove a temp folder made by tempDir. */
export function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** A throwaway git repo with one empty commit on `branch`, and `remote` as origin (if given). */
export function makeRepo({ remote, branch = 'main', name = 'widget' } = {}) {
  const parent = tempDir();
  const dir = path.join(parent, name);
  fs.mkdirSync(dir);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', env: cleanEnv() });
  git('init', '-q', '-b', branch);
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (remote) git('remote', 'add', 'origin', remote);
  return { dir, parent };
}

/** A minimal environment: only PATH, HOME and TMPDIR from this process, plus `extra`. */
export function cleanEnv(extra = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || os.tmpdir() };
  // Keep the machine's own git settings (and any global git hooks) out of the tests.
  // Never the developer's own saved key, and never a real browser tab.
  env.CONSTELLA_HOME = path.join(os.tmpdir(), 'constella-test-no-such-home');
  env.CONSTELLA_NO_BROWSER = '1';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = os.devNull;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

/** Run a script with `args`, JSON `input` on stdin and `env`. Resolves { code, stdout, stderr, ms }. */
export function run(script, args, { input, env, cwd } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script, ...args], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input));
  });
}

/** Run the hook in `mode` (start | file | compact). */
export function runHook(mode, input, env) {
  return run(HOOK, [mode], { input, env, cwd: input && input.cwd });
}

/** additionalContext from a hook's JSON stdout ('' when there is none). */
export function contextOf(stdout) {
  if (!stdout.trim()) return '';
  return JSON.parse(stdout).hookSpecificOutput.additionalContext;
}

/** A recall answer with the given sources. */
export function recallAnswer(sources) {
  return { status: 200, body: { result: { sources } } };
}
