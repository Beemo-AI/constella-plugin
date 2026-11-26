// Sign in to Constella from the terminal, once, in the browser.
//
// Plain version: `constella setup` starts a small helper process (`constella _signin`). The helper listens on
// this computer only (127.0.0.1), opens Constella's own sign-in page, and when the person presses Allow the
// page sends the browser back to the helper with a one-time code. The helper swaps the code for the person's
// API key, saves it (credentials.mjs), ends that sign-in on the server, and exits.
//
// It is a separate process so the sign-in survives when an AI tool stops the setup command after its time
// limit: run `constella setup` again and it picks the same sign-in up. Its state is one small file,
// ~/.constella/signin.json: { pid, url, started_at, status: waiting | done | error, message }. No secret is
// ever written there, printed, or put in a URL.
//
// The server side is Constella's OAuth sign-in (the one `codex mcp login` uses) with one more scope,
// `constella:key`, which the server only grants to a program on the person's own computer.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { DEFAULT_API, VERSION } from './api.mjs';
import { homeDir, writeCredentials } from './credentials.mjs';

export const SIGN_IN_LIMIT_MS = 10 * 60 * 1000;
const SCOPES = 'constella:mcp constella:mcp:write constella:key';
const USER_AGENT = `constella-agent-plugin/${VERSION}`;

/** The server to sign in to: CONSTELLA_API_URL, else https://api.constella.app. (Never a saved one: we are signing in fresh.) */
export function signInBase(env = process.env) {
  return String(env.CONSTELLA_API_URL || DEFAULT_API).trim().replace(/\/+$/, '') || DEFAULT_API;
}

/** The MCP address for a base: CONSTELLA_MCP_URL, else <base>/mcp. */
export function mcpUrl(base, env = process.env) {
  return String(env.CONSTELLA_MCP_URL || '').trim() || `${base}/mcp`;
}

/** Where the sign-in routes live: the MCP address's own origin + /mcp/oauth. */
export function oauthBase(base, env = process.env) {
  return `${new URL(mcpUrl(base, env)).origin}/mcp/oauth`;
}

export function signInFile(env = process.env) {
  return path.join(homeDir(env), 'signin.json');
}

/** The sign-in state file's content, or null. Never throws. */
export function readSignIn(env = process.env) {
  try {
    const raw = JSON.parse(fs.readFileSync(signInFile(env), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function writeSignIn(state, env) {
  const dir = homeDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = signInFile(env);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function clearSignIn(env = process.env) {
  try {
    fs.unlinkSync(signInFile(env));
  } catch {
    /* nothing to clear */
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

/** A sign-in that is still waiting for the person (its helper is alive and not too old), or null. */
export function liveSignIn(env = process.env, now = Date.now()) {
  const state = readSignIn(env);
  if (!state || state.status !== 'waiting' || !state.url) return null;
  if (!alive(state.pid) || now - Number(state.started_at || 0) > SIGN_IN_LIMIT_MS) return null;
  return state;
}

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  return { status: res.status, ok: res.ok, data: data && typeof data === 'object' ? data : {} };
}

async function postForm(url, form) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': USER_AGENT },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(20000),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  return { status: res.status, ok: res.ok, data: data && typeof data === 'object' ? data : {} };
}

function page(title, text) {
  // Fixed words only: nothing from the request is ever put into this page.
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Constella</title>
<body style="font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:440px;margin:18vh auto;padding:0 20px;color:#16161d">
<h1 style="font-size:22px">${title}</h1><p>${text}</p></body>`;
}

/** Why the key could not be fetched, in words a person can act on. */
function keyProblem(status, data) {
  const said = typeof data.error_description === 'string' ? data.error_description : '';
  if (status === 404 && !data.error) return 'This Constella server is too old for one-step setup. Use a key instead: see the README, "The key".';
  if (status === 403 && data.error === 'insufficient_scope') return 'The sign-in did not allow fetching your key (was "Allow" pressed with writing on?). Run setup again.';
  return said || `The server answered ${status} when asked for your key.`;
}

/**
 * The helper process: do one whole sign-in, then return. Never throws; the outcome is in signin.json
 * ({status: "done"} with the credentials saved, or {status: "error", message}).
 * `emailHint` only fills the email box on the sign-in page.
 */
export async function runSignIn(env = process.env, { emailHint = '', limitMs = SIGN_IN_LIMIT_MS } = {}) {
  const base = signInBase(env);
  const oauth = oauthBase(base, env);
  const started = Date.now();
  const state = { pid: process.pid, started_at: started, status: 'starting', api_url: base };
  const fail = (message) => writeSignIn({ ...state, status: 'error', message, url: undefined }, env);

  const expectedState = base64url(crypto.randomBytes(24));
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());

  let finish;
  const answered = new Promise((resolve) => {
    finish = resolve;
  });
  let reply = null; // set once the outcome is known, so the browser tab shows the true result
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    if (url.searchParams.get('state') !== expectedState) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('That link is not for this sign-in', 'Go back to your terminal and run setup again.'));
      return;
    }
    if (reply) {
      // The one-time code was already used (a reloaded tab): the first answer stands.
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('This sign-in was already used', 'Go back to your terminal.'));
      return;
    }
    reply = (ok, text) => {
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(ok ? page('You are signed in', 'Constella is set up on this computer. You can close this tab and go back to your terminal.') : page('Sign-in did not finish', text));
    };
    finish({ code: url.searchParams.get('code') || '', error: url.searchParams.get('error') || '' });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const redirect = `http://127.0.0.1:${server.address().port}/callback`;

    const reg = await postJson(`${oauth}/register`, {
      client_name: 'Constella setup',
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      scope: SCOPES,
    });
    const clientId = reg.data.client_id;
    if (!reg.ok || typeof clientId !== 'string') {
      fail(`Could not start the sign-in (${oauth} answered ${reg.status}).`);
      return;
    }

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: expectedState,
      scope: SCOPES,
    });
    if (emailHint) params.set('login_hint', emailHint);
    writeSignIn({ ...state, status: 'waiting', url: `${oauth}/authorize?${params}` }, env);

    const timer = setTimeout(() => finish({ code: '', error: 'timeout' }), Math.max(1000, limitMs));
    const got = await answered;
    clearTimeout(timer);
    if (got.error || !got.code) {
      const why = got.error === 'timeout' ? 'Nobody signed in within 10 minutes.' : got.error === 'access_denied' ? 'The sign-in was cancelled.' : `The sign-in page answered "${got.error || 'no code'}".`;
      if (reply) reply(false, 'Go back to your terminal and run setup again.');
      fail(`${why} Run setup again.`);
      return;
    }

    const token = await postForm(`${oauth}/token`, {
      grant_type: 'authorization_code',
      code: got.code,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier,
    });
    const access = token.data.access_token;
    if (!token.ok || typeof access !== 'string') {
      if (reply) reply(false, 'Go back to your terminal and run setup again.');
      fail(`Could not finish the sign-in (the server answered ${token.status}). Run setup again.`);
      return;
    }

    const key = await postJson(`${oauth}/api-key`, undefined, { authorization: `Bearer ${access}` });
    // That sign-in has done its one job: end it on the server, whether or not the key came.
    await postForm(`${oauth}/revoke`, { client_id: clientId, token: access }).catch(() => {});
    if (!key.ok || typeof key.data.api_key !== 'string' || !key.data.api_key) {
      const problem = keyProblem(key.status, key.data);
      if (reply) reply(false, 'Go back to your terminal: it says what to do next.');
      fail(problem);
      return;
    }

    writeCredentials({ api_key: key.data.api_key, api_url: base, email: typeof key.data.email === 'string' ? key.data.email : '' }, env);
    writeSignIn({ ...state, status: 'done' }, env);
    if (reply) reply(true, '');
  } catch (err) {
    if (reply) reply(false, 'Go back to your terminal and run setup again.');
    const reason = err && err.name === 'TimeoutError' ? 'the server took too long to answer' : String((err && err.message) || err);
    fail(`Could not reach ${oauth} (${reason}). A sandbox with no network also causes this.`);
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve());
      if (server.closeAllConnections) server.closeAllConnections();
    });
  }
}

/** Start the helper as its own process, so it outlives this command. Returns its pid. */
export function startSignInHelper(cliPath, env = process.env, { emailHint = '' } = {}) {
  clearSignIn(env);
  const args = [cliPath, '_signin'];
  if (emailHint) args.push('--email', emailHint);
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env, windowsHide: true });
  child.unref();
  return child.pid;
}

/** Open a URL in the person's browser. Returns false when no opener could be started. Never throws. */
export function openBrowser(url, env = process.env) {
  if (env.CONSTELLA_NO_BROWSER) return false;
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
