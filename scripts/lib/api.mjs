// A tiny client for Constella's tool routes over HTTPS (no npm packages, Node 18+ fetch).
//   POST {base}/platform/v1/me/tools/{name}   body {"arguments": {...}}   ->   {"result": ...}
// Errors come back as {"detail": {"code", "message"}}. Auth is `Authorization: Bearer <key>`;
// `X-Constella-Client` names the AI tool, so the server files its saves under that tool.

export const VERSION = '0.1.0';
export const DEFAULT_API = 'https://api.constella.app';

/**
 * The person's Constella key: the plugin option `api_key` (Claude Code exports it as
 * CLAUDE_PLUGIN_OPTION_API_KEY), else CONSTELLA_API_KEY. '' when neither is set.
 */
export function apiKey(env = process.env) {
  return String(env.CLAUDE_PLUGIN_OPTION_API_KEY || env.CONSTELLA_API_KEY || '').trim();
}

/** The API base URL with no trailing slash: CONSTELLA_API_URL, else https://api.constella.app. */
export function apiBase(env = process.env) {
  return String(env.CONSTELLA_API_URL || DEFAULT_API).trim().replace(/\/+$/, '') || DEFAULT_API;
}

/** Where saves go ("me" today; a team box later): plugin option `save_to`, else CONSTELLA_SAVE_TO, else "me". */
export function saveTo(env = process.env) {
  return String(env.CLAUDE_PLUGIN_OPTION_SAVE_TO || env.CONSTELLA_SAVE_TO || 'me').trim() || 'me';
}

/** A safe X-Constella-Client value: lowercase letters, digits and dashes, at most 40 characters. */
export function clientName(value, fallback = 'agents') {
  const clean = String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  return clean || fallback;
}

/**
 * Call one Constella tool. Never throws.
 * Inputs: base URL, key, client name, tool name, its arguments, and a time limit in ms.
 * Returns { ok, status, result, code, message, error }:
 *   ok      true only for a 2xx answer with a JSON object body
 *   result  the tool's result (body.result) when ok
 *   code / message  the server's error detail, when it sent one
 *   error   'timeout', 'bad_json' or a network error message
 * The key is only ever placed in the Authorization header; it is never part of the return value.
 */
export async function callTool({ base, key, client, name, args, timeoutMs = 10000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.floor(timeoutMs)));
  try {
    const response = await fetch(`${base}/platform/v1/me/tools/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'x-constella-client': clientName(client),
        'user-agent': `constella-agent-plugin/${VERSION}`,
      },
      body: JSON.stringify({ arguments: args || {} }),
      signal: controller.signal,
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      return { ok: false, status: response.status, error: 'bad_json' };
    }
    const isObject = body !== null && typeof body === 'object' && !Array.isArray(body);
    if (response.ok && isObject) return { ok: true, status: response.status, result: body.result };
    const detail = isObject && body.detail && typeof body.detail === 'object' ? body.detail : {};
    return {
      ok: false,
      status: response.status,
      code: typeof detail.code === 'string' ? detail.code : undefined,
      message: typeof detail.message === 'string' ? detail.message : undefined,
      error: response.ok ? 'bad_json' : undefined,
    };
  } catch (err) {
    const timedOut = controller.signal.aborted || (err && err.name === 'AbortError');
    return { ok: false, status: 0, error: timedOut ? 'timeout' : String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}
