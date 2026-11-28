import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import defaultExport, {
  PLUGIN_ID,
  createConstellaPlugin,
  resolveConfig,
  formatStartBlock,
  TranscriptManager,
} from '../opencode/index.mjs';
import { parseJsonc, setUpOpenCode, withOpenCodePlugin } from '../scripts/lib/tools.mjs';
import { writeCredentials } from '../scripts/lib/credentials.mjs';

/** Start a local HTTP server that records requests and delegates responses to `handler`. */
async function startMockServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const entry = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      };
      requests.push(entry);
      const reply = handler(entry);
      res.statusCode = reply.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Build a realistic mock OpenCode v2 `ctx` supporting tools, context hook, tool.hook, and event stream. */
function makeMockV2Context(options = {}) {
  const registeredTools = new Map();
  const sessionHooks = new Map();
  const toolHooks = new Map();
  const eventQueue = [];
  let waitResolve = null;
  let streamClosed = false;

  const ctx = {
    options,
    location: { directory: options.directory || '' },
    tool: {
      async transform(fn) {
        fn({
          add(spec) {
            registeredTools.set(spec.name, spec);
          },
        });
      },
      async hook(name, fn) {
        toolHooks.set(name, fn);
      },
    },
    session: {
      async hook(name, fn) {
        sessionHooks.set(name, fn);
      },
    },
    event: {
      subscribe({ signal }) {
        if (signal) {
          signal.addEventListener('abort', () => {
            streamClosed = true;
            if (waitResolve) {
              const r = waitResolve;
              waitResolve = null;
              r();
            }
          });
        }
        return {
          async *[Symbol.asyncIterator]() {
            while (!streamClosed || eventQueue.length > 0) {
              if (eventQueue.length > 0) {
                yield eventQueue.shift();
                continue;
              }
              if (streamClosed) break;
              await new Promise((resolve) => {
                waitResolve = resolve;
              });
            }
          },
        };
      },
    },
  };

  return {
    ctx,
    tools: registeredTools,
    sessionHooks,
    toolHooks,
    pushEvent(evt) {
      eventQueue.push(evt);
      if (waitResolve) {
        const r = waitResolve;
        waitResolve = null;
        r();
      }
    },
    closeEvents() {
      streamClosed = true;
      if (waitResolve) {
        const r = waitResolve;
        waitResolve = null;
        r();
      }
    },
  };
}

test('OpenCode v2 default export exposes id and setup', () => {
  assert.equal(defaultExport.id, PLUGIN_ID);
  assert.equal(typeof defaultExport.setup, 'function');
});

test('no-repo session start loads once, stays byte-identical across turns (prompt cache), and supports non-code places', async () => {
  const srv = await startMockServer((req) => {
    if (req.url === '/platform/v1/users/user_alice/tools/memory_recall') {
      return {
        body: {
          result: {
            sources: [
              {
                id: 'ho-acme',
                tier: 'handoff',
                kind: 'handoff',
                scope: 'me',
                title: 'Acme Handoff',
                text: 'Goal: finalize shortlist. Next: send panel invites.',
                actor: { person: 'user_alice', agent: 'opencode' },
              },
              {
                id: 'rule-1',
                tier: 'rule',
                kind: 'rule',
                scope: 'Recruiting',
                title: 'UI Architecture Exercise',
                text: 'Always run the 45-min UI architecture exercise.',
              },
              {
                id: 'idx-1',
                tier: 'index',
                kind: 'fact',
                title: 'Comp Band Q4',
                text: 'Senior Frontend band is 180k-210k.',
              },
            ],
          },
        },
      };
    }
    return { status: 404, body: { detail: { code: 'not_found', message: 'unexpected' } } };
  });

  try {
    const { ctx, tools, sessionHooks } = makeMockV2Context({
      apiUrl: srv.baseUrl,
      token: 'cps_secret_alice_token',
      userId: 'user_alice',
      workspaceId: 'ws_recruiting',
      repo: '', // explicitly non-code session
      places: [{ kind: 'role', key: 'senior-frontend' }],
      recallMode: 'hybrid',
      uploadMode: 'end',
    });

    const plugin = createConstellaPlugin();
    const handle = await plugin.setup(ctx);

    // All 4 v2 tools registered
    assert.deepEqual(
      [...tools.keys()].sort(),
      ['constella_fetch', 'constella_recall', 'constella_save', 'constella_upload_session']
    );

    const contextHook = sessionHooks.get('context');
    assert.equal(typeof contextHook, 'function');

    // Turn 1
    const turn1 = {
      sessionId: 'oc_sess_1',
      system: [],
      messages: [{ role: 'user', content: 'Let us review Acme candidates.' }],
    };
    await contextHook(turn1);

    // Turn 2
    const turn2 = {
      sessionId: 'oc_sess_1',
      system: [],
      messages: [
        { role: 'user', content: 'Let us review Acme candidates.' },
        { role: 'assistant', content: 'Sure, checking shortlist.' },
        { role: 'user', content: 'What is our UI exercise rule?' },
      ],
    };
    await contextHook(turn2);

    // Session start recall was called ONLY ONCE (prompt-cache safe & low latency).
    assert.equal(srv.requests.length, 1);
    const req = srv.requests[0];
    assert.equal(req.headers.authorization, 'Bearer cps_secret_alice_token');
    assert.equal(req.headers['x-constella-client'], 'opencode');
    assert.deepEqual(req.body.arguments, {
      mode: 'start',
      scope: 'all',
      places: [{ kind: 'role', key: 'senior-frontend' }],
    });
    assert.equal('repo' in req.body.arguments, false);

    // Exact same static system block injected on Turn 1 and Turn 2.
    assert.equal(turn1.system.length, 1);
    assert.equal(turn2.system.length, 1);
    assert.equal(turn1.system[0].text, turn2.system[0].text);
    assert.match(turn1.system[0].text, /## Last Handoff/);
    assert.match(turn1.system[0].text, /UI Architecture Exercise/);
    assert.match(turn1.system[0].text, /Comp Band Q4/);
    assert.match(turn1.system[0].text, /\[id:idx-1\]/);
    assert.doesNotMatch(turn1.system[0].text, /cps_secret_alice_token/);

    await handle.dispose();
  } finally {
    await srv.close();
  }
});

test('tools: constella_recall, constella_fetch, and constella_save route workspace scope, actor provenance, and places', async () => {
  const srv = await startMockServer((req) => {
    if (req.url.endsWith('/tools/memory_recall')) {
      return { body: { result: { sources: [{ id: 'm-1', title: 'Panel rubric', text: '3 rounds' }] } } };
    }
    if (req.url.endsWith('/tools/notes_read')) {
      return { body: { result: { id: 'm-1', title: 'Panel rubric', content: 'Full 3-round rubric text' } } };
    }
    if (req.url.endsWith('/tools/memory_add')) {
      return { body: { result: { id: 'rule-rubric', ref: 'pt-1', updated: false } } };
    }
    return { status: 404, body: {} };
  });

  try {
    const { ctx, tools } = makeMockV2Context({
      apiUrl: srv.baseUrl,
      token: 'cps_alice',
      userId: 'user_alice',
      workspaceId: 'ws_recruiting',
      repo: '',
    });

    const handle = await createConstellaPlugin().setup(ctx);

    const rRecall = await tools.get('constella_recall').execute(
      { query: 'panel rubric', scope: 'workspace', places: [{ kind: 'role', key: 'senior-frontend' }] },
      { sessionId: 'oc_sess_2' }
    );
    assert.equal(JSON.parse(rRecall.content).ok, true);
    assert.equal(srv.requests[0].body.arguments.scope, 'team:ws_recruiting');

    const rFetch = await tools.get('constella_fetch').execute({ id: 'm-1' }, { sessionId: 'oc_sess_2' });
    assert.equal(JSON.parse(rFetch.content).content, 'Full 3-round rubric text');

    const rSave = await tools.get('constella_save').execute(
      {
        text: 'Always require a live portfolio review.',
        title: 'Portfolio Required',
        kind: 'rule',
        scope: 'workspace',
        places: [{ kind: 'role', key: 'senior-frontend' }],
      },
      { sessionId: 'oc_sess_2' }
    );
    assert.equal(JSON.parse(rSave.content).ok, true);
    const saveArgs = srv.requests[2].body.arguments;
    assert.equal(saveArgs.to, 'team:ws_recruiting');
    assert.equal(saveArgs.agent, 'opencode');
    assert.equal(saveArgs.session_id, 'oc_sess_2');
    assert.deepEqual(saveArgs.places, [{ kind: 'role', key: 'senior-frontend' }]);

    await handle.dispose();
  } finally {
    await srv.close();
  }
});

test('uploadMode="end" (default) ignores session.idle and uploads full scrubbed transcript ONCE on session.deleted', async () => {
  const srv = await startMockServer((req) => {
    if (req.url.startsWith('/platform/v1/users/user_alice/ingest')) {
      return { status: 202, body: { job_id: 'ing_1', status: 'queued', box: 'me' } };
    }
    return { body: { result: { sources: [] } } };
  });

  try {
    const scrubbedCalls = [];
    const { ctx, sessionHooks } = makeMockV2Context({
      apiUrl: srv.baseUrl,
      token: 'cps_alice',
      userId: 'user_alice',
      workspaceId: 'ws_recruiting',
      repo: '',
      recallMode: 'tools',
      uploadMode: 'end',
      beforeUpload: async (payload) => {
        scrubbedCalls.push(payload);
        return {
          ...payload,
          messages: payload.messages.map((m) => ({
            ...m,
            content: m.content.replace(/SECRET-123/g, '[REDACTED]'),
          })),
        };
      },
    });

    const handle = await createConstellaPlugin().setup(ctx);
    const contextHook = sessionHooks.get('context');

    await contextHook({
      sessionId: 'oc_sess_end',
      system: [],
      messages: [
        { role: 'user', content: 'Candidate token SECRET-123 passed screen.' },
        { role: 'assistant', content: 'Logged screen pass.' },
      ],
    });

    // `session.idle` must NOT upload when `uploadMode === "end"`.
    await handle.handleEvent({ type: 'session.idle', sessionId: 'oc_sess_end' });
    assert.equal(srv.requests.length, 0);

    // `session.deleted` uploads the FULL scrubbed transcript ONCE with NO `chunk_seq`.
    await handle.handleEvent({ type: 'session.deleted', sessionId: 'oc_sess_end' });
    assert.equal(scrubbedCalls.length, 1);
    assert.equal(srv.requests.length, 1);
    const ing = srv.requests[0];
    assert.equal(ing.url, '/platform/v1/users/user_alice/ingest?sync=false');
    assert.equal(ing.body.session_id, 'oc_sess_end');
    assert.equal('chunk_seq' in ing.body, false);
    assert.equal(ing.body.agent, 'opencode');
    assert.equal(ing.body.messages.length, 2);
    assert.equal(ing.body.messages[0].content, 'Candidate token [REDACTED] passed screen.');

    await handle.dispose();
  } finally {
    await srv.close();
  }
});

test('uploadMode="incremental" sends ONLY new turns with monotonically increasing chunk_seq on session.idle', async () => {
  const srv = await startMockServer((req) => {
    if (req.url.startsWith('/platform/v1/users/user_alice/ingest')) {
      return { status: 202, body: { job_id: 'ing_inc', status: 'queued', box: 'me' } };
    }
    return { body: { result: { sources: [] } } };
  });

  try {
    const { ctx, sessionHooks } = makeMockV2Context({
      apiUrl: srv.baseUrl,
      token: 'cps_alice',
      userId: 'user_alice',
      repo: '',
      recallMode: 'tools',
      uploadMode: 'incremental',
      minIncrementalMessages: 2,
    });

    const handle = await createConstellaPlugin().setup(ctx);
    const contextHook = sessionHooks.get('context');

    const msgs = [
      { role: 'user', content: 'Turn 1 question' },
      { role: 'assistant', content: 'Turn 1 answer' },
    ];
    await contextHook({ sessionId: 'oc_inc', system: [], messages: msgs });
    await handle.handleEvent({ type: 'session.idle', sessionId: 'oc_inc' });

    // Second idle with NO new messages -> must NOT re-send!
    await handle.handleEvent({ type: 'session.idle', sessionId: 'oc_inc' });

    // Add 2 more turns -> sends ONLY turns 3-4 as chunk_seq=2!
    const msgs2 = [
      ...msgs,
      { role: 'user', content: 'Turn 2 question' },
      { role: 'assistant', content: 'Turn 2 answer' },
    ];
    await contextHook({ sessionId: 'oc_inc', system: [], messages: msgs2 });
    await handle.handleEvent({ type: 'session.idle', sessionId: 'oc_inc' });

    assert.equal(srv.requests.length, 2);
    assert.equal(srv.requests[0].body.chunk_seq, 1);
    assert.deepEqual(
      srv.requests[0].body.messages.map((m) => m.content),
      ['Turn 1 question', 'Turn 1 answer']
    );
    assert.equal(srv.requests[1].body.chunk_seq, 2);
    assert.deepEqual(
      srv.requests[1].body.messages.map((m) => m.content),
      ['Turn 2 question', 'Turn 2 answer']
    );

    await handle.dispose();
  } finally {
    await srv.close();
  }
});

test('recallMode="every_turn" appends compact turn recall and skips IDs already shown at start', async () => {
  const srv = await startMockServer((req) => {
    if (req.body?.arguments?.mode === 'start') {
      return {
        body: {
          result: {
            sources: [{ id: 'rule-1', tier: 'rule', kind: 'rule', title: 'Rule 1', text: 'Always do X.' }],
          },
        },
      };
    }
    return {
      body: {
        result: {
          sources: [
            { id: 'rule-1', kind: 'rule', title: 'Rule 1', text: 'Duplicate of start' },
            { id: 'fact-2', kind: 'fact', title: 'Acme Budget', text: 'Acme budget is 200k.' },
          ],
        },
      },
    };
  });

  try {
    const { ctx, sessionHooks } = makeMockV2Context({
      apiUrl: srv.baseUrl,
      token: 'cps_alice',
      userId: 'user_alice',
      repo: '',
      recallMode: 'every_turn',
    });

    const handle = await createConstellaPlugin().setup(ctx);
    const contextHook = sessionHooks.get('context');

    const evt = {
      sessionId: 'oc_turn',
      system: [],
      messages: [{ role: 'user', content: 'What is Acme budget?' }],
    };
    await contextHook(evt);

    assert.equal(srv.requests.length, 2);
    assert.equal(evt.system.length, 2);
    assert.match(evt.system[0].text, /<constella-memory>/);
    assert.match(evt.system[1].text, /<constella-turn-recall>/);
    assert.match(evt.system[1].text, /Acme budget is 200k/);
    assert.doesNotMatch(evt.system[1].text, /Duplicate of start/);

    await handle.dispose();
  } finally {
    await srv.close();
  }
});

test('beforeUpload returning null skips upload cleanly; server 500 fails open without leaking token', async () => {
  const srv = await startMockServer(() => ({
    status: 500,
    body: { detail: { code: 'boom', message: 'server error' } },
  }));

  try {
    const { ctx, sessionHooks, tools } = makeMockV2Context({
      apiUrl: srv.baseUrl,
      token: 'cps_never_leak_me',
      userId: 'user_alice',
      repo: '',
      recallMode: 'hybrid',
      uploadMode: 'end',
      beforeUpload: async () => null,
    });

    const handle = await createConstellaPlugin().setup(ctx);
    const contextHook = sessionHooks.get('context');

    // Context hook falls back gracefully on 500 and never leaks the token.
    const evt = {
      sessionId: 'oc_err',
      system: [],
      messages: [{ role: 'user', content: 'Sensitive medical info' }],
    };
    await contextHook(evt);
    assert.equal(evt.system.length, 1);
    assert.match(evt.system[0].text, /Constella memory tools are available/);
    assert.doesNotMatch(evt.system[0].text, /cps_never_leak_me/);

    // Explicit upload tool respects `beforeUpload() => null` and makes NO ingest request.
    const beforeCount = srv.requests.length;
    const up = await tools.get('constella_upload_session').execute({}, { sessionId: 'oc_err' });
    const parsed = JSON.parse(up.content);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.skipped, true);
    assert.equal(parsed.reason, 'skipped_by_scrubber');
    assert.equal(srv.requests.length, beforeCount);

    await handle.dispose();
  } finally {
    await srv.close();
  }
});

test('resolveConfig falls back to env vars and TranscriptManager + formatStartBlock stay under caps', () => {
  const cfg = resolveConfig({}, {
    CONSTELLA_SESSION_TOKEN: 'cps_env',
    CONSTELLA_USER_ID: 'u_env',
    CONSTELLA_WORKSPACE_ID: 'ws_env',
    CONSTELLA_RECALL_MODE: 'every_turn',
    CONSTELLA_UPLOAD_MODE: 'incremental',
    CONSTELLA_DEFAULT_PLACES: '[{"kind":"client","key":"acme"}]',
  });
  assert.equal(cfg.token, 'cps_env');
  assert.equal(cfg.userId, 'u_env');
  assert.equal(cfg.workspaceId, 'ws_env');
  assert.equal(cfg.recallMode, 'every_turn');
  assert.equal(cfg.uploadMode, 'incremental');
  assert.deepEqual(cfg.defaultPlaces, [{ kind: 'client', key: 'acme' }]);

  const big = Array.from({ length: 40 }, (_, i) => ({
    id: `m-${i}`,
    kind: 'fact',
    title: `Fact ${i}`,
    text: 'X'.repeat(300),
  }));
  const formatted = formatStartBlock({ sources: big });
  assert.ok(formatted.text.length <= 3600);
  assert.match(formatted.text, /more memories omitted/);

  assert.equal(typeof TranscriptManager, 'function');
});

test('resolveConfig reads ~/.constella/credentials.json in personal mode only and respects same-server guard', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'constella-oc-cred-'));
  try {
    const env = { CONSTELLA_HOME: dir };
    writeCredentials({ api_key: 'csk_saved_personal_key', api_url: 'https://api.constella.app' }, env);

    // Personal mode (no userId, no env token) -> uses saved personal key + api_url.
    const cfg = resolveConfig({}, env);
    assert.equal(cfg.token, 'csk_saved_personal_key');
    assert.equal(cfg.apiUrl, 'https://api.constella.app');

    // Different server -> saved key is NEVER handed out.
    const otherSrv = resolveConfig({ apiUrl: 'http://127.0.0.1:9999' }, env);
    assert.equal(otherSrv.token, '');

    // Platform mode (`userId` set) -> never sends personal `csk_` key to `/users/{uid}`.
    const plat = resolveConfig({ userId: 'user_alice' }, env);
    assert.equal(plat.token, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseJsonc, withOpenCodePlugin, and setUpOpenCode install plugin cleanly without writing secrets', () => {
  const parsed = parseJsonc(`{
    // comment with url https://example.com
    "$schema": "https://opencode.ai/config.json",
    /* block comment */
    "plugins": ["other-plugin",],
  }`);
  assert.equal(parsed.$schema, 'https://opencode.ai/config.json');
  assert.deepEqual(parsed.plugins, ['other-plugin']);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'constella-oc-setup-'));
  try {
    const constellaHome = path.join(dir, 'constella');
    const opencodeHome = path.join(dir, 'opencode');
    fs.mkdirSync(opencodeHome, { recursive: true });
    fs.writeFileSync(
      path.join(opencodeHome, 'opencode.jsonc'),
      `{\n  // keep my existing plugin\n  "plugins": ["opencode-wakatime"]\n}\n`
    );

    const env = { CONSTELLA_HOME: constellaHome, CONSTELLA_OPENCODE_HOME: opencodeHome, PATH: '/usr/bin:/bin' };
    const r1 = setUpOpenCode({ env });
    assert.equal(r1.state, 'ok');

    // Plugin files copied into stable ~/.constella/opencode-plugin folder.
    const installedDir = path.join(constellaHome, 'opencode-plugin');
    assert.equal(fs.existsSync(path.join(installedDir, 'index.mjs')), true);
    assert.equal(fs.existsSync(path.join(installedDir, 'client.mjs')), true);

    // Config preserves existing plugin, adds constella-memory once, and contains ZERO keys.
    const cfg1 = JSON.parse(fs.readFileSync(path.join(opencodeHome, 'opencode.jsonc'), 'utf8'));
    assert.equal(cfg1.plugins.length, 2);
    assert.equal(cfg1.plugins[0], 'opencode-wakatime');
    assert.equal(cfg1.plugins[1].id, 'constella-memory');
    assert.equal(cfg1.plugins[1].source, installedDir);
    assert.equal('token' in (cfg1.plugins[1].options || {}), false);

    // Running setup a second time is idempotent (still 2 plugins, preserves custom user options).
    cfg1.plugins[1].options.recallMode = 'every_turn';
    fs.writeFileSync(path.join(opencodeHome, 'opencode.jsonc'), JSON.stringify(cfg1, null, 2));
    const r2 = setUpOpenCode({ env });
    assert.equal(r2.state, 'ok');
    const cfg2 = JSON.parse(fs.readFileSync(path.join(opencodeHome, 'opencode.jsonc'), 'utf8'));
    assert.equal(cfg2.plugins.length, 2);
    assert.equal(cfg2.plugins[1].options.recallMode, 'every_turn');

    // Helper check
    const dedup = withOpenCodePlugin({ plugins: ['constella-memory', 'foo'] }, '/tmp/p');
    assert.equal(dedup.plugins.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
