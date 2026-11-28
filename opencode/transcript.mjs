// Session transcript tracker, pluggable scrubber hook, and private-box upload controller.
//
// Upload timing modes:
// - `end` (default, recommended): buffers the session and sends the FULL scrubbed transcript ONCE
//   when the session ends (or when `constella_upload_session` is called). Produces highest
//   extraction & contradiction-resolution quality because the server's Brain sees the entire arc.
// - `incremental`: sends ONLY new turns on `session.idle` once `minIncrementalMessages` accumulate,
//   using monotonically increasing `chunk_seq` (`1, 2, ...`) so nothing is re-sent or double-billed.
// - `manual`: only uploads when `constella_upload_session` is explicitly called.
//
// Privacy rule: ALL transcript ingests target `/platform/v1/users/{uid}/ingest` (private box only).

/** Normalize an OpenCode message object into `{ role, content }` for `/ingest`. */
export function normalizeMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const role = String(msg.role || msg.author || 'user').trim().toLowerCase() || 'user';
  let content = '';
  if (typeof msg.content === 'string') {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    content = msg.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
          if (part.type === 'tool_result' && typeof part.output === 'string') return part.output;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  } else if (Array.isArray(msg.parts)) {
    content = msg.parts
      .map((part) => (typeof part === 'string' ? part : (part && typeof part.text === 'string' ? part.text : '')))
      .filter(Boolean)
      .join('\n');
  } else if (typeof msg.text === 'string') {
    content = msg.text;
  }
  const cleaned = content.trim();
  if (!cleaned) return null;
  return { role, content: cleaned };
}

/** Normalize an array of messages, dropping empties and system prompt noise. */
export function normalizeTranscript(messages, { includeSystem = false } = {}) {
  const out = [];
  for (const raw of Array.isArray(messages) ? messages : []) {
    const norm = normalizeMessage(raw);
    if (!norm) continue;
    if (!includeSystem && norm.role === 'system') continue;
    out.push(norm);
  }
  return out;
}

/** Extract the latest non-empty user message text from an OpenCode messages array. */
export function latestUserPrompt(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const norm = normalizeMessage(list[i]);
    if (norm && norm.role === 'user' && norm.content) {
      return norm.content;
    }
  }
  return '';
}

/**
 * Per-session transcript manager handling full-end and incremental chunked uploads plus
 * the pluggable `beforeUpload(payload)` scrubber hook.
 */
export class TranscriptManager {
  constructor(client, config) {
    this.client = client;
    this.config = config;
    /** @type {Map<string, { messages: Array<{role:string,content:string}>, sentCount: number, chunkSeq: number, uploadedFull: boolean, places: Array<object>, title?: string }>} */
    this.sessions = new Map();
  }

  _ensure(sessionId) {
    const sid = String(sessionId || 'default').trim() || 'default';
    let state = this.sessions.get(sid);
    if (!state) {
      state = {
        messages: [],
        sentCount: 0,
        chunkSeq: 0,
        uploadedFull: false,
        places: Array.isArray(this.config.defaultPlaces) ? [...this.config.defaultPlaces] : [],
        title: undefined,
      };
      this.sessions.set(sid, state);
    }
    return state;
  }

  /** Replace the buffered message list for `sessionId` with the latest normalized conversation snapshot. */
  recordSnapshot(sessionId, messages, { title, places } = {}) {
    const state = this._ensure(sessionId);
    const normalized = normalizeTranscript(messages);
    if (normalized.length >= state.messages.length) {
      state.messages = normalized;
    } else if (normalized.length > 0) {
      // Handle cases where a hook only receives a fresh slice after compaction.
      state.messages = normalized;
      if (state.sentCount > normalized.length) {
        state.sentCount = 0;
      }
    }
    if (title) state.title = String(title).trim().slice(0, 200);
    if (Array.isArray(places) && places.length) state.places = places;
    return state;
  }

  /** Append one or more messages to `sessionId`'s buffer. */
  appendMessages(sessionId, messages) {
    const state = this._ensure(sessionId);
    for (const norm of normalizeTranscript(messages)) {
      state.messages.push(norm);
    }
    return state;
  }

  /**
   * Flush buffered messages for `sessionId` to `POST /platform/v1/users/{uid}/ingest`.
   *
   * - `mode="full"`: sends the complete transcript once with NO `chunk_seq` (idempotent `session:<id>`).
   * - `mode="incremental"`: sends ONLY unsent messages (`messages.slice(sentCount)`) with `chunk_seq: n`.
   */
  async flush(sessionId, { mode = 'full', sync = false, force = false, title, places } = {}) {
    const sid = String(sessionId || 'default').trim() || 'default';
    const state = this._ensure(sid);
    const useIncremental = mode === 'incremental';

    let batch;
    let nextChunkSeq;
    if (useIncremental) {
      batch = state.messages.slice(state.sentCount);
      if (!batch.length) {
        return { ok: true, skipped: true, reason: 'no_new_messages' };
      }
      if (!force && batch.length < this.config.minIncrementalMessages) {
        return { ok: true, skipped: true, reason: 'below_threshold', pending: batch.length };
      }
      nextChunkSeq = state.chunkSeq + 1;
    } else {
      if (state.uploadedFull && !force) {
        return { ok: true, skipped: true, reason: 'already_uploaded' };
      }
      batch = state.messages;
      if (!batch.length) {
        return { ok: true, skipped: true, reason: 'empty_session' };
      }
      nextChunkSeq = undefined;
    }

    let payload = {
      session_id: sid,
      agent: this.config.agent,
      source: this.config.agent,
      title: title || state.title || `OpenCode session ${sid.slice(0, 24)}`,
      messages: batch.map((m) => ({ ...m })),
      places: Array.isArray(places) && places.length ? places : state.places,
      include_tool_outputs: this.config.includeToolOutputs,
    };
    if (nextChunkSeq !== undefined) {
      payload.chunk_seq = nextChunkSeq;
    }

    if (this.config.beforeUpload) {
      try {
        const scrubbed = await this.config.beforeUpload(payload);
        if (scrubbed === null || scrubbed === false) {
          return { ok: true, skipped: true, reason: 'skipped_by_scrubber' };
        }
        if (scrubbed && typeof scrubbed === 'object') {
          payload = scrubbed;
        }
      } catch (err) {
        return { ok: false, status: 0, error: `scrubber_error: ${String((err && err.message) || err)}` };
      }
    }

    // Ensure scrubber did not leave an empty payload.
    const hasContent =
      (Array.isArray(payload.messages) && payload.messages.length > 0) ||
      (typeof payload.text === 'string' && payload.text.trim().length > 0) ||
      (payload.data !== undefined && payload.data !== null);
    if (!hasContent) {
      return { ok: true, skipped: true, reason: 'empty_after_scrub' };
    }

    const res = await this.client.ingest(payload, { sync });
    if (res.ok) {
      if (useIncremental) {
        state.sentCount += batch.length;
        state.chunkSeq = nextChunkSeq;
      } else {
        state.sentCount = state.messages.length;
        state.uploadedFull = true;
      }
    }
    return res;
  }

  /** Clear state for a closed session. */
  drop(sessionId) {
    this.sessions.delete(String(sessionId || 'default').trim() || 'default');
  }
}
