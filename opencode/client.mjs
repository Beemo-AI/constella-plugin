// Zero-dependency HTTP client for Constella's Platform API (Node 18+ / Bun fetch).
//
// Supports two auth shapes:
//   1. Workspace / Platform mode (recommended for self-hosted OpenCode teams):
//        token = scoped `cps_...` session token (or `cak_live_...` for local dev) + `userId`
//        POST {base}/platform/v1/users/{uid}/tools/{name}
//        POST {base}/platform/v1/users/{uid}/ingest?sync={true|false}
//        GET  {base}/platform/v1/ingest/{job_id}
//   2. Personal mode (solo developers using their own Constella API key):
//        token = `csk_...` (no `userId`)
//        POST {base}/platform/v1/me/tools/{name}
//
// Never throws on network or HTTP failures; never leaks the bearer token in returned objects.

export const PLUGIN_VERSION = '0.2.0';
export const DEFAULT_API_URL = 'https://api.constella.app';

/** Clean a base URL (no trailing slash). */
export function normalizeBaseUrl(raw) {
  const cleaned = String(raw || '').trim().replace(/\/+$/, '');
  return cleaned || DEFAULT_API_URL;
}

/** Clean a client/agent label for `X-Constella-Client` (max 40 lowercase alnum/dash chars). */
export function normalizeClient(raw, fallback = 'opencode') {
  const cleaned = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  return cleaned || fallback;
}

/**
 * Resolve runtime configuration from explicit plugin options (`ctx.options` or factory args)
 * with environment variable fallbacks.
 */
export function resolveConfig(options = {}, env = process.env) {
  const opt = options && typeof options === 'object' ? options : {};
  const token = String(
    opt.token || opt.sessionToken || opt.apiKey ||
    env.CONSTELLA_SESSION_TOKEN || env.CONSTELLA_TOKEN || env.CONSTELLA_API_KEY || ''
  ).trim();
  const userId = String(opt.userId || opt.user_id || env.CONSTELLA_USER_ID || '').trim();
  const workspaceId = String(opt.workspaceId || opt.workspace_id || env.CONSTELLA_WORKSPACE_ID || '').trim();
  const apiUrl = normalizeBaseUrl(opt.apiUrl || opt.api_url || env.CONSTELLA_API_URL || DEFAULT_API_URL);
  const agent = normalizeClient(opt.agent || opt.client || env.CONSTELLA_AGENT || 'opencode');

  const rawRecall = String(opt.recallMode || opt.recall_mode || env.CONSTELLA_RECALL_MODE || 'hybrid').trim().toLowerCase();
  const recallMode = ['hybrid', 'tools', 'every_turn'].includes(rawRecall) ? rawRecall : 'hybrid';

  const rawUpload = String(opt.uploadMode || opt.upload_mode || env.CONSTELLA_UPLOAD_MODE || 'end').trim().toLowerCase();
  const uploadMode = ['end', 'incremental', 'manual'].includes(rawUpload) ? rawUpload : 'end';

  let defaultPlaces = Array.isArray(opt.places) ? opt.places : [];
  if (!defaultPlaces.length && env.CONSTELLA_DEFAULT_PLACES) {
    try {
      const parsed = JSON.parse(env.CONSTELLA_DEFAULT_PLACES);
      if (Array.isArray(parsed)) defaultPlaces = parsed;
    } catch {
      // Ignore malformed env JSON rather than breaking OpenCode startup.
    }
  }

  const startTimeoutMs = positiveInt(opt.startTimeoutMs ?? env.CONSTELLA_START_TIMEOUT_MS, 3000, 200, 30000);
  const toolTimeoutMs = positiveInt(opt.toolTimeoutMs ?? env.CONSTELLA_TOOL_TIMEOUT_MS, 10000, 500, 60000);
  const ingestTimeoutMs = positiveInt(opt.ingestTimeoutMs ?? env.CONSTELLA_INGEST_TIMEOUT_MS, 15000, 1000, 120000);
  const minIncrementalMessages = positiveInt(
    opt.minIncrementalMessages ?? env.CONSTELLA_MIN_INCREMENTAL_MESSAGES,
    4,
    1,
    200
  );

  return {
    token,
    userId,
    workspaceId,
    apiUrl,
    agent,
    recallMode,
    uploadMode,
    defaultPlaces,
    startTimeoutMs,
    toolTimeoutMs,
    ingestTimeoutMs,
    minIncrementalMessages,
    includeToolOutputs: Boolean(opt.includeToolOutputs ?? false),
    fileRecall: opt.fileRecall !== false,
    beforeUpload: typeof opt.beforeUpload === 'function' ? opt.beforeUpload : null,
    fetchImpl: typeof opt.fetch === 'function' ? opt.fetch : globalThis.fetch,
  };
}

function positiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * Build the HTTP path for a Constella tool call.
 * Uses `/platform/v1/users/{uid}/tools/{name}` when `userId` is set (workspace/platform mode),
 * else `/platform/v1/me/tools/{name}` (personal mode).
 */
export function toolPath(config, toolName) {
  const encTool = encodeURIComponent(toolName);
  if (config.userId) {
    return `/platform/v1/users/${encodeURIComponent(config.userId)}/tools/${encTool}`;
  }
  return `/platform/v1/me/tools/${encTool}`;
}

/** Low-level JSON request with timeout and safe error handling. Never throws. */
async function requestJson(config, { method, path, body, timeoutMs }) {
  if (!config.token) {
    return { ok: false, status: 0, code: 'no_token', message: 'CONSTELLA_SESSION_TOKEN or CONSTELLA_API_KEY is not set.' };
  }
  const fetchFn = config.fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { ok: false, status: 0, error: 'fetch_unavailable' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.floor(timeoutMs || 10000)));
  try {
    const headers = {
      authorization: `Bearer ${config.token}`,
      accept: 'application/json',
      'x-constella-client': config.agent,
      'user-agent': `constella-opencode-plugin/${PLUGIN_VERSION}`,
    };
    const init = { method, headers, signal: controller.signal };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetchFn(`${config.apiUrl}${path}`, init);
    const raw = await response.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      return { ok: false, status: response.status, error: 'bad_json' };
    }
    const isObj = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
    if (response.ok && isObj) {
      return { ok: true, status: response.status, data: parsed };
    }
    const detail = isObj && parsed.detail && typeof parsed.detail === 'object' ? parsed.detail : {};
    return {
      ok: false,
      status: response.status,
      code: typeof detail.code === 'string' ? detail.code : undefined,
      message: typeof detail.message === 'string' ? detail.message : (typeof parsed?.detail === 'string' ? parsed.detail : undefined),
      error: response.ok ? 'bad_json' : undefined,
    };
  } catch (err) {
    const timedOut = controller.signal.aborted || (err && err.name === 'AbortError');
    return { ok: false, status: 0, error: timedOut ? 'timeout' : String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Create a bound Constella client from a resolved config. */
export function createClient(config) {
  return {
    config,

    /** Call one Constella catalog tool (`memory_recall`, `memory_add`, `notes_read`, `memory_forget`). */
    async callTool(name, args = {}, { timeoutMs } = {}) {
      const res = await requestJson(config, {
        method: 'POST',
        path: toolPath(config, name),
        body: { arguments: args || {} },
        timeoutMs: timeoutMs ?? config.toolTimeoutMs,
      });
      if (!res.ok) return res;
      return { ok: true, status: res.status, result: res.data.result };
    },

    /**
     * Ingest a scrubbed transcript, text, or JSON payload into the member's PRIVATE box.
     * Requires Platform mode (`userId` + `cps_` or `cak_live_` token).
     */
    async ingest(payload, { sync = false, timeoutMs } = {}) {
      if (!config.userId) {
        return {
          ok: false,
          status: 0,
          code: 'missing_user_id',
          message: 'Transcript ingest requires userId (Platform mode with a cps_ session token).',
        };
      }
      const query = sync ? '?sync=true' : '?sync=false';
      const res = await requestJson(config, {
        method: 'POST',
        path: `/platform/v1/users/${encodeURIComponent(config.userId)}/ingest${query}`,
        body: payload,
        timeoutMs: timeoutMs ?? config.ingestTimeoutMs,
      });
      if (!res.ok) return res;
      return { ok: true, status: res.status, result: res.data };
    },

    /** Poll status of an async ingest job. */
    async getIngestJob(jobId, { timeoutMs } = {}) {
      const res = await requestJson(config, {
        method: 'GET',
        path: `/platform/v1/ingest/${encodeURIComponent(jobId)}`,
        timeoutMs: timeoutMs ?? config.toolTimeoutMs,
      });
      if (!res.ok) return res;
      return { ok: true, status: res.status, result: res.data };
    },
  };
}
