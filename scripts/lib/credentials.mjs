// The key `constella setup` saved on this machine: ~/.constella/credentials.json (folder 0700, file 0600).
//   { "api_key": "csk_...", "api_url": "https://api.constella.app", "email": "you@x.com", "saved_at": "..." }
// The hooks, the MCP header helper and the CLI read it when no key is in the environment, so memory works in
// every tool with no shell profile edit, also in apps opened from the Dock. The key is only ever used for the
// server it was saved for (see `savedFor`), and nothing here prints it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Addresses of the one production server. A key saved for one of them is good for the others.
const PRODUCTION_HOSTS = new Set(['api.constella.app', 'fastfind.app', 'www.fastfind.app']);

/** The folder setup keeps its files in: CONSTELLA_HOME, else ~/.constella. */
export function homeDir(env = process.env) {
  return env.CONSTELLA_HOME || path.join(os.homedir(), '.constella');
}

export function credentialsFile(env = process.env) {
  return path.join(homeDir(env), 'credentials.json');
}

function hostOf(url) {
  try {
    return new URL(String(url)).host.toLowerCase();
  } catch {
    return '';
  }
}

/** True when two base URLs are the same server (same host, or both production addresses). */
export function sameServer(a, b) {
  const [x, y] = [hostOf(a), hostOf(b)];
  if (!x || !y) return false;
  return x === y || (PRODUCTION_HOSTS.has(x) && PRODUCTION_HOSTS.has(y));
}

/** The saved credentials, or null when there are none or the file is unreadable. Never throws. */
export function readCredentials(env = process.env) {
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsFile(env), 'utf8'));
    const key = typeof raw.api_key === 'string' ? raw.api_key.trim() : '';
    const url = typeof raw.api_url === 'string' ? raw.api_url.trim().replace(/\/+$/, '') : '';
    if (!key || !url) return null;
    return { api_key: key, api_url: url, email: typeof raw.email === 'string' ? raw.email : '', saved_at: raw.saved_at || '' };
  } catch {
    return null;
  }
}

/**
 * The saved credentials when they may be used with `wantedBase`, else null.
 * `wantedBase` is CONSTELLA_API_URL when the person set one ('' when they did not: then any saved server is
 * fine, and the caller talks to the saved `api_url`). A key is never handed out for a different server.
 */
export function savedFor(wantedBase, env = process.env) {
  const saved = readCredentials(env);
  if (!saved) return null;
  if (wantedBase && !sameServer(wantedBase, saved.api_url)) return null;
  return saved;
}

/** Save credentials (temp file then rename; only this user can read them). Returns the file path. */
export function writeCredentials({ api_key, api_url, email = '' }, env = process.env) {
  const dir = homeDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* Windows: no modes */
  }
  const file = credentialsFile(env);
  const tmp = `${file}.${process.pid}.tmp`;
  const body = { api_key, api_url: String(api_url).replace(/\/+$/, ''), email, saved_at: new Date().toISOString() };
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/** Delete the saved credentials. True when a file was removed. */
export function removeCredentials(env = process.env) {
  try {
    fs.unlinkSync(credentialsFile(env));
    return true;
  } catch {
    return false;
  }
}
