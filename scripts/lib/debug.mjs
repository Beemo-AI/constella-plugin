// Optional debug log for troubleshooting. Off unless CONSTELLA_DEBUG=1.
// Lines go to <data folder>/debug.log, never to stdout or stderr (those would reach the AI model).
// The key, and anything that looks like a key or a bearer token, is replaced before writing.

import fs from 'node:fs';
import path from 'node:path';
import { apiKey } from './api.mjs';
import { dataDir } from './state.mjs';

const TOKENISH = /\b(?:csk|cot|cak_live|cak)_[A-Za-z0-9_-]+|Bearer\s+\S+/g;

/** Remove the key and token-like strings from a text. */
export function scrub(text, env = process.env) {
  let out = String(text ?? '');
  const key = apiKey(env);
  if (key) out = out.split(key).join('[key]');
  return out.replace(TOKENISH, '[key]');
}

/** True when CONSTELLA_DEBUG is on. */
export function debugOn(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.CONSTELLA_DEBUG || '').toLowerCase());
}

/** Path of the debug log. */
export function debugFile(env = process.env) {
  return path.join(dataDir(env), 'debug.log');
}

/** Append one scrubbed JSON line to the debug log when debugging is on. Never throws. */
export function debugLog(env, fields) {
  if (!debugOn(env)) return;
  try {
    const line = scrub(JSON.stringify({ at: new Date().toISOString(), ...fields }), env);
    fs.mkdirSync(dataDir(env), { recursive: true });
    fs.appendFileSync(debugFile(env), `${line}\n`);
  } catch {
    /* debugging must never break the hook */
  }
}
