// Constella Memory plugin for OpenCode v2 (`@opencode/plugin`).
//
// Design:
// - Session start (`ctx.session.hook("context")`): loads rules, handoff, pinned memories, and a
//   compact memory index ONCE per session via `memory_recall(mode="start")`. Works both in git
//   repos and in non-code workspaces (recruiting, ops, support) with zero repo required. The start
//   block is cached verbatim across turns to preserve provider prompt caching.
// - Mid-session recall:
//     * `hybrid` (default): static start block + explicit `constella_recall` / `constella_fetch` tools.
//     * `tools`: tools + short reminder only (no automatic session-start call).
//     * `every_turn`: static start block + automatic per-turn search on the latest user message.
// - Explicit saving: `constella_save` stamps `agent`, `session_id`, and code or non-code `places`.
//   Defaults to private (`scope="me"`); shared workspace saves require explicit `scope="workspace"`.
// - Transcript ingest: `uploadMode="end"` (default) uploads the full scrubbed transcript ONCE at
//   session end into the member's PRIVATE box (`/platform/v1/users/{uid}/ingest`). Opt into
//   `uploadMode="incremental"` for multi-hour sessions (`chunk_seq: 1, 2, ...` on `session.idle`).
//   Pass `beforeUpload(payload)` to run a custom PII/secret scrubber before anything leaves OpenCode.

import { execFileSync } from 'node:child_process';
import { createClient, resolveConfig } from './client.mjs';
import { formatFallbackBlock, formatStartBlock, formatTurnRecallBlock } from './format.mjs';
import { TranscriptManager, latestUserPrompt } from './transcript.mjs';

export const PLUGIN_ID = 'constella-memory';

/** Detect `owner/repo` ONLY when `cwd` is genuinely inside a git repository (returns '' outside git). */
export function detectGitRepo(cwd) {
  if (!cwd) return '';
  try {
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 800,
    }).trim();
    if (inside !== 'true') return '';
  } catch {
    return '';
  }

  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 800,
    }).trim();
    const cleaned = normalizeGitRemote(remote);
    if (cleaned) return cleaned;
  } catch {
    // No origin remote: use top-level git directory basename.
  }

  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 800,
    }).trim();
    const base = top.split(/[\\/]/).filter(Boolean).pop() || '';
    return base.toLowerCase();
  } catch {
    return '';
  }
}

/** Strip credentials/protocol from a git remote URL into `owner/repo`. */
export function normalizeGitRemote(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  let body = value
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^@/]*@/i, '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^@\s]+@/, '');
  body = body.replace(/^[^/:]+(?::\d+)?[:/]/, '');
  body = body.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  return body.toLowerCase();
}

/** Resolve the `to` box for `memory_add` from a user-friendly `scope` argument. */
export function resolveSaveTarget(scope, config) {
  const s = String(scope || 'me').trim().toLowerCase();
  if (!s || s === 'me' || s === 'personal') return 'me';
  if (s === 'workspace' || s === 'team') {
    return config.workspaceId ? `team:${config.workspaceId}` : 'team';
  }
  if (s.startsWith('team:')) return s;
  return `team:${s}`;
}

/** Resolve the `scope` parameter for `memory_recall`. */
export function resolveRecallScope(scope, config) {
  const s = String(scope || 'all').trim().toLowerCase();
  if (s === 'all' || s === 'me' || s === 'personal') return s === 'personal' ? 'me' : s;
  if (s === 'workspace' || s === 'team') {
    return config.workspaceId ? `team:${config.workspaceId}` : 'team';
  }
  if (s.startsWith('team:')) return s;
  return `team:${s}`;
}

/** Push a text block onto OpenCode v2's `event.system` array cleanly. */
function pushSystemText(event, text) {
  if (!event || !text) return;
  if (!Array.isArray(event.system)) {
    event.system = [];
  }
  if (event.system.length > 0 && typeof event.system[0] === 'string') {
    event.system.push(text);
  } else {
    event.system.push({ type: 'text', text });
  }
}

/** Extract sessionId from an OpenCode v2 hook or event payload. */
function sessionIdFrom(obj, fallback = 'default') {
  const raw =
    obj?.sessionId ??
    obj?.sessionID ??
    obj?.session_id ??
    obj?.session?.id ??
    obj?.properties?.sessionID ??
    obj?.properties?.sessionId ??
    obj?.properties?.info?.id ??
    fallback;
  const cleaned = String(raw || '').trim();
  return cleaned || fallback;
}

/**
 * Core OpenCode v2 `setup(ctx)` implementation.
 * Can be used directly via `createConstellaPlugin(options)` or through `opencode/index.mjs`.
 */
export async function setupConstellaPlugin(ctx, overrideOptions = {}) {
  const mergedOptions = {
    ...(ctx && typeof ctx.options === 'object' ? ctx.options : {}),
    ...(overrideOptions && typeof overrideOptions === 'object' ? overrideOptions : {}),
  };
  const config = resolveConfig(mergedOptions, mergedOptions.env || process.env);
  const client = createClient(config);
  const transcripts = new TranscriptManager(client, config);

  const cwd = mergedOptions.directory || ctx?.location?.directory || ctx?.directory || '';
  const detectedRepo = mergedOptions.repo !== undefined ? String(mergedOptions.repo || '').trim() : detectGitRepo(cwd);

  /** @type {Map<string, { text: string, shownIds: Set<string>, lastPrompt: string, pendingFileNotes: string[], seenFolders: Set<string> }>} */
  const sessionState = new Map();

  function getSession(sessionId) {
    const sid = String(sessionId || 'default').trim() || 'default';
    let st = sessionState.get(sid);
    if (!st) {
      st = {
        text: '',
        shownIds: new Set(),
        lastPrompt: '',
        pendingFileNotes: [],
        seenFolders: new Set(),
      };
      sessionState.set(sid, st);
    }
    return st;
  }

  async function ensureStartBlock(sessionId) {
    const st = getSession(sessionId);
    if (st.text) return st;

    if (config.recallMode === 'tools' || !config.token) {
      st.text = formatFallbackBlock({ workspaceId: config.workspaceId });
      return st;
    }

    const recallArgs = {
      mode: 'start',
      scope: config.workspaceId ? 'all' : 'all',
    };
    if (detectedRepo) {
      recallArgs.repo = detectedRepo;
    }
    if (config.defaultPlaces.length) {
      recallArgs.places = config.defaultPlaces;
    }

    const res = await client.callTool('memory_recall', recallArgs, { timeoutMs: config.startTimeoutMs });
    if (!res.ok || !res.result || typeof res.result !== 'object') {
      st.text = formatFallbackBlock({ workspaceId: config.workspaceId });
      return st;
    }

    const formatted = formatStartBlock(res.result, {
      workspaceId: config.workspaceId,
      repo: detectedRepo,
      recallMode: config.recallMode,
    });
    st.text = formatted.text;
    st.shownIds = formatted.shownIds;
    return st;
  }

  // -------------------------------------------------------------------------
  // 1. Register Constella memory tools via OpenCode v2 `ctx.tool.transform`
  // -------------------------------------------------------------------------
  if (ctx?.tool && typeof ctx.tool.transform === 'function') {
    await ctx.tool.transform((tools) => {
      tools.add({
        name: 'constella_recall',
        description:
          'Search Constella memory across personal and authorized workspace boxes (decisions, rules, preferences, lessons, people, clients, roles, handoffs).',
        input: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to search for.' },
            scope: {
              type: 'string',
              enum: ['all', 'me', 'workspace'],
              description: 'Where to search: "all" (default: personal + workspaces), "me" (personal only), or "workspace" (shared team box).',
            },
            places: {
              type: 'array',
              description: 'Optional code places ({repo, path}) or non-code places ({kind, key} e.g. role, client, task, topic).',
              items: { type: 'object' },
            },
            kinds: {
              type: 'array',
              description: 'Optional filter by memory kind (rule, decision, preference, lesson, fact, handoff).',
              items: { type: 'string' },
            },
            limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max memories to return (default 8).' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        async execute(input, toolCtx) {
          const args = {
            query: String(input?.query || '').trim(),
            scope: resolveRecallScope(input?.scope || 'all', config),
          };
          if (detectedRepo) args.repo = detectedRepo;
          if (Array.isArray(input?.places) && input.places.length) args.places = input.places;
          else if (config.defaultPlaces.length) args.places = config.defaultPlaces;
          if (Array.isArray(input?.kinds) && input.kinds.length) args.kinds = input.kinds;
          if (Number.isInteger(input?.limit)) args.limit = input.limit;

          const res = await client.callTool('memory_recall', args);
          if (!res.ok) {
            return {
              content: JSON.stringify({
                ok: false,
                error: res.message || res.code || res.error || `HTTP ${res.status}`,
              }),
            };
          }
          const sid = sessionIdFrom(toolCtx);
          const st = getSession(sid);
          for (const src of res.result?.sources || []) {
            if (src && src.id) st.shownIds.add(String(src.id));
          }
          return { content: JSON.stringify({ ok: true, ...res.result }, null, 2) };
        },
      });

      tools.add({
        name: 'constella_fetch',
        description: 'Fetch the full text of a specific Constella memory or note by id (from a recall index or search hit).',
        input: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The memory or note id returned by constella_recall.' },
          },
          required: ['id'],
          additionalProperties: false,
        },
        async execute(input) {
          const res = await client.callTool('notes_read', { id: String(input?.id || '').trim() });
          if (!res.ok) {
            return {
              content: JSON.stringify({
                ok: false,
                error: res.message || res.code || res.error || `HTTP ${res.status}`,
              }),
            };
          }
          return { content: JSON.stringify({ ok: true, ...res.result }, null, 2) };
        },
      });

      tools.add({
        name: 'constella_save',
        description:
          'Save a durable memory (rule, decision, preference, lesson, fact, or handoff). Defaults to private ("me"); pass scope="workspace" ONLY for knowledge meant to be shared with the whole workspace.',
        input: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The clear, self-contained memory to save.' },
            title: { type: 'string', description: 'Short descriptive title.' },
            kind: {
              type: 'string',
              enum: ['rule', 'decision', 'preference', 'lesson', 'fact', 'handoff'],
              description: 'Memory kind (default: fact).',
            },
            scope: {
              type: 'string',
              enum: ['me', 'workspace'],
              description: '"me" (private, default) or "workspace" (shared with the active workspace).',
            },
            places: {
              type: 'array',
              description: 'Optional code places ({repo, path, function_name}) or non-code places ({kind, key} such as role, client, task, topic).',
              items: { type: 'object' },
            },
            tags: { type: 'array', items: { type: 'string' } },
            id: { type: 'string', description: 'Optional stable memory id for idempotent updates.' },
            replaces: { type: 'string', description: 'Optional id of an older memory this supersedes.' },
            both_hold: { type: 'string', description: 'Optional id of a related memory that remains true alongside this one.' },
          },
          required: ['text'],
          additionalProperties: false,
        },
        async execute(input, toolCtx) {
          const sid = sessionIdFrom(toolCtx);
          const args = {
            text: String(input?.text || '').trim(),
            to: resolveSaveTarget(input?.scope || 'me', config),
            agent: config.agent,
            session_id: sid,
          };
          if (input?.title) args.title = String(input.title);
          if (input?.kind) args.kind = String(input.kind);
          if (Array.isArray(input?.tags) && input.tags.length) args.tags = input.tags;
          if (input?.id) args.id = String(input.id);
          if (input?.replaces) args.replaces = String(input.replaces);
          if (input?.both_hold) args.both_hold = String(input.both_hold);

          if (Array.isArray(input?.places) && input.places.length) {
            args.places = input.places;
          } else if (config.defaultPlaces.length) {
            args.places = config.defaultPlaces;
          } else if (detectedRepo) {
            args.places = [{ repo: detectedRepo }];
          }

          const res = await client.callTool('memory_add', args);
          if (!res.ok) {
            return {
              content: JSON.stringify({
                ok: false,
                error: res.message || res.code || res.error || `HTTP ${res.status}`,
              }),
            };
          }
          return { content: JSON.stringify({ ok: true, ...res.result }, null, 2) };
        },
      });

      tools.add({
        name: 'constella_upload_session',
        description:
          'Scrub and upload the current session transcript into the member\'s PRIVATE Constella box for Brain memory extraction. Raw transcripts are never shared to the workspace.',
        input: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Optional title for the session transcript.' },
            sync: { type: 'boolean', description: 'Wait for Brain extraction counts before returning (default false).' },
            places: {
              type: 'array',
              description: 'Optional non-code or code places to tag extracted cards with.',
              items: { type: 'object' },
            },
          },
          additionalProperties: false,
        },
        async execute(input, toolCtx) {
          const sid = sessionIdFrom(toolCtx);
          const res = await transcripts.flush(sid, {
            mode: 'full',
            sync: Boolean(input?.sync),
            force: true,
            title: input?.title,
            places: input?.places,
          });
          if (!res.ok) {
            return {
              content: JSON.stringify({
                ok: false,
                error: res.message || res.code || res.error || `HTTP ${res.status}`,
              }),
            };
          }
          if (res.skipped) {
            return { content: JSON.stringify({ ok: true, skipped: true, reason: res.reason }) };
          }
          return { content: JSON.stringify({ ok: true, ...res.result }, null, 2) };
        },
      });
    });
  }

  // -------------------------------------------------------------------------
  // 2. Context hook: static session-start injection + optional per-turn recall
  // -------------------------------------------------------------------------
  if (ctx?.session && typeof ctx.session.hook === 'function') {
    await ctx.session.hook('context', async (event) => {
      const sid = sessionIdFrom(event);
      if (Array.isArray(event?.messages)) {
        transcripts.recordSnapshot(sid, event.messages);
      }

      // Always push the cached, byte-identical session-start block (prompt-cache friendly).
      const st = await ensureStartBlock(sid);
      pushSystemText(event, st.text);

      // Flush any file-edit recall notes queued before an edit in a coding repo.
      if (st.pendingFileNotes.length) {
        for (const note of st.pendingFileNotes.splice(0, st.pendingFileNotes.length)) {
          pushSystemText(event, note);
        }
      }

      // Optional forced per-turn semantic recall when `recallMode === "every_turn"`.
      if (config.recallMode === 'every_turn' && config.token && Array.isArray(event?.messages)) {
        const prompt = latestUserPrompt(event.messages);
        if (prompt && prompt !== st.lastPrompt && prompt.length >= 6) {
          st.lastPrompt = prompt;
          const args = {
            query: prompt.slice(0, 600),
            scope: 'all',
            limit: 5,
          };
          if (detectedRepo) args.repo = detectedRepo;
          if (config.defaultPlaces.length) args.places = config.defaultPlaces;

          const res = await client.callTool('memory_recall', args, { timeoutMs: config.startTimeoutMs });
          if (res.ok && res.result) {
            const turnBlock = formatTurnRecallBlock(res.result, {
              skipIds: st.shownIds,
              label: 'Memories relevant to this turn',
            });
            if (turnBlock.text) {
              for (const id of turnBlock.addedIds) st.shownIds.add(id);
              pushSystemText(event, turnBlock.text);
            }
          }
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // 3. Optional file-edit recall hook (coding repos only, non-blocking)
  // -------------------------------------------------------------------------
  if (config.fileRecall && detectedRepo && config.token && ctx?.tool && typeof ctx.tool.hook === 'function') {
    await ctx.tool.hook('execute.before', async (event) => {
      const toolName = String(event?.tool || '').toLowerCase();
      if (!['edit', 'write', 'patch', 'apply_patch', 'multiedit'].includes(toolName)) return;
      const rawPath = String(event?.args?.filePath || event?.args?.path || event?.args?.file_path || '').trim();
      if (!rawPath) return;

      const sid = sessionIdFrom(event);
      const st = getSession(sid);
      const folder = rawPath.includes('/') ? rawPath.slice(0, rawPath.lastIndexOf('/')) : '.';
      if (st.seenFolders.has(folder)) return;
      st.seenFolders.add(folder);

      const res = await client.callTool(
        'memory_recall',
        { repo: detectedRepo, files: [rawPath], scope: 'all', limit: 5 },
        { timeoutMs: 1500 }
      );
      if (res.ok && res.result) {
        const block = formatTurnRecallBlock(res.result, {
          skipIds: st.shownIds,
          label: `Memories for ${folder}`,
        });
        if (block.text) {
          for (const id of block.addedIds) st.shownIds.add(id);
          st.pendingFileNotes.push(block.text);
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // 4. Event subscription: session-end full upload OR incremental on idle
  // -------------------------------------------------------------------------
  const controller = new AbortController();
  if (ctx?.signal && typeof ctx.signal.addEventListener === 'function') {
    ctx.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  async function handleEvent(event) {
    const type = String(event?.type || '').trim();
    if (!type) return;
    const sid = sessionIdFrom(event);

    // If the event itself carries messages (or a single message), buffer them.
    if (Array.isArray(event?.messages)) {
      transcripts.recordSnapshot(sid, event.messages);
    } else if (Array.isArray(event?.properties?.messages)) {
      transcripts.recordSnapshot(sid, event.properties.messages);
    } else if (event?.message || event?.properties?.message) {
      transcripts.appendMessages(sid, [event.message || event.properties.message]);
    }

    if (type === 'session.idle') {
      if (config.uploadMode === 'incremental' && config.userId && config.token) {
        await transcripts.flush(sid, { mode: 'incremental' });
      }
      return;
    }

    if (type === 'session.deleted' || type === 'session.closed' || type === 'session.ended') {
      if (config.userId && config.token) {
        if (config.uploadMode === 'end') {
          await transcripts.flush(sid, { mode: 'full' });
        } else if (config.uploadMode === 'incremental') {
          await transcripts.flush(sid, { mode: 'incremental', force: true });
        }
      }
      sessionState.delete(sid);
      transcripts.drop(sid);
    }
  }

  let eventLoopPromise = null;
  if (ctx?.event && typeof ctx.event.subscribe === 'function') {
    const stream = ctx.event.subscribe({ signal: controller.signal });
    eventLoopPromise = (async () => {
      try {
        for await (const event of stream) {
          if (controller.signal.aborted) break;
          await handleEvent(event);
        }
      } catch {
        // Subscription aborted or ended during OpenCode shutdown; fail silently.
      }
    })();
  }

  return {
    config,
    client,
    transcripts,
    handleEvent,
    async dispose() {
      controller.abort();
      if (eventLoopPromise) {
        await eventLoopPromise.catch(() => {});
      }
    },
  };
}

/**
 * Factory returning an OpenCode v2 plugin definition (`{ id, setup }`).
 * Wrap with `Plugin.define(createConstellaPlugin({ ... }))` in custom `.opencode/plugins/*.ts` files.
 */
export function createConstellaPlugin(options = {}) {
  return {
    id: PLUGIN_ID,
    async setup(ctx) {
      return setupConstellaPlugin(ctx, options);
    },
  };
}
