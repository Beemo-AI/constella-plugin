// The hook run end to end as a child process, the way Claude Code and Codex run it,
// against a fake Constella API on 127.0.0.1.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  FAKE_KEY,
  cleanEnv,
  contextOf,
  deadUrl,
  fakeApi,
  makeRepo,
  recallAnswer,
  removeDir,
  runHook,
  tempDir,
} from './helpers.mjs';

const cleanup = [];
after(() => cleanup.forEach(removeDir));

let repo;
before(() => {
  repo = makeRepo({ remote: 'git@github.com:Acme/Widget.git', branch: 'feat/login' });
  cleanup.push(repo.parent);
  fs.mkdirSync(path.join(repo.dir, 'src', 'api'), { recursive: true });
  fs.mkdirSync(path.join(repo.dir, 'src', 'ui'), { recursive: true });
});

let sessionCounter = 0;
/** A Claude Code shaped input for an event. */
function ccInput(event, extra = {}) {
  sessionCounter += 1;
  return {
    session_id: `sess-${process.pid}-${sessionCounter}`,
    transcript_path: '/Users/me/.claude/projects/x/sess.jsonl',
    cwd: repo.dir,
    hook_event_name: event,
    permission_mode: 'default',
    ...extra,
  };
}

/** Environment for one run: a fresh data folder, the fake API, and the key unless `key: null`. */
function envFor(api, { key = FAKE_KEY, data, debug = false, extra = {} } = {}) {
  const dataDir = data || tempDir('constella-data-');
  if (!data) cleanup.push(dataDir);
  return cleanEnv({
    CONSTELLA_API_URL: api,
    CLAUDE_PLUGIN_OPTION_API_KEY: key || undefined,
    CLAUDE_PLUGIN_DATA: dataDir,
    CLAUDE_PLUGIN_ROOT: '/fake/plugin/root',
    CLAUDE_PROJECT_DIR: repo.dir,
    CONSTELLA_DEBUG: debug ? '1' : undefined,
    ...extra,
  });
}

const NOW = Date.now();
const SOURCES = [
  { id: 'h1', tier: 'handoff', title: 'handoff', text: 'Goal: login\nDone: form\nNext: tests\nOpen questions: none\nBranch and key files: feat/login', saved_by: 'codex', updated_at_ms: NOW - 3600e3 },
  { id: 'r1', tier: 'rule', title: 'Migrations only', text: 'Table changes go through Alembic.', updated_at_ms: NOW - 7200e3 },
  { id: 'f1', tier: 'file', title: 'API errors', text: 'Errors under src/api return {detail}.', updated_at_ms: NOW - 60e3 },
  { id: 'n1', tier: 'repo', title: 'pnpm', text: 'We use pnpm for workspaces.', updated_at_ms: NOW - 86400e3 },
];

function assertQuiet(res) {
  assert.equal(res.code, 0, `exit code ${res.code}, stderr: ${res.stderr}`);
  assert.equal(res.stderr, '', 'nothing on stderr');
}

describe('start (SessionStart)', () => {
  test('renders handoff, rules, file and repo items in order, under 3,500 characters', async () => {
    const api = await fakeApi(() => recallAnswer(SOURCES));
    try {
      const res = await runHook('start', ccInput('SessionStart', { source: 'startup' }), envFor(api.url));
      assertQuiet(res);
      const out = JSON.parse(res.stdout);
      assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
      const text = out.hookSpecificOutput.additionalContext;
      assert.ok(text.startsWith('Constella memory (repo: acme/widget, branch: feat/login)'));
      const order = ['Last handoff (codex', 'Rules:', '[r1]', 'Decisions and notes', '[f1]', '[n1]', 'How to use:'];
      const positions = order.map((s) => text.indexOf(s));
      assert.ok(positions.every((p) => p >= 0), `all parts present: ${positions}`);
      assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'in order');
      assert.ok(text.length <= 3500);
      assert.ok(text.includes('id="handoff:acme-widget@feat-login"'), 'the ready-made handoff id');
      assert.ok(!text.includes('Context was just compacted'));

      assert.equal(api.requests.length, 1);
      const req = api.requests[0];
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/platform/v1/me/tools/memory_recall');
      assert.equal(req.headers.authorization, `Bearer ${FAKE_KEY}`);
      assert.equal(req.headers['x-constella-client'], 'claude-code');
      assert.equal(req.headers['content-type'], 'application/json');
      assert.deepEqual(req.body, { arguments: { repo: 'acme/widget', limit: 12, scope: 'all' } });
    } finally {
      await api.close();
    }
  });

  test('no key: prints the fallback, makes no request', async () => {
    const api = await fakeApi(() => recallAnswer(SOURCES));
    try {
      const res = await runHook('start', ccInput('SessionStart', { source: 'startup' }), envFor(api.url, { key: null }));
      assertQuiet(res);
      const text = contextOf(res.stdout);
      assert.ok(text.includes('Constella memory is connected for this repo (repo: acme/widget, branch: feat/login)'));
      assert.ok(text.includes('memory_recall(repo="acme/widget", files=['));
      assert.ok(text.includes('id="handoff:acme-widget@feat-login"'));
      assert.equal(text.split('\n').length, 3);
      assert.equal(api.requests.length, 0);
    } finally {
      await api.close();
    }
  });

  test('CONSTELLA_API_KEY works when the plugin option is not set', async () => {
    const api = await fakeApi(() => recallAnswer(SOURCES));
    try {
      const env = envFor(api.url, { key: null, extra: { CONSTELLA_API_KEY: 'csk_env_key_42' } });
      const res = await runHook('start', ccInput('SessionStart', { source: 'startup' }), env);
      assertQuiet(res);
      assert.equal(api.requests[0].headers.authorization, 'Bearer csk_env_key_42');
    } finally {
      await api.close();
    }
  });

  for (const [name, answer] of [
    ['a 500 answer', { status: 500, body: { detail: { code: 'boom', message: 'x' } } }],
    ['a 401 answer', { status: 401, body: { detail: { code: 'bad_key', message: 'no' } } }],
    ['bad JSON', { status: 200, raw: '{not json' }],
    ['JSON with no sources', { status: 200, body: { result: { nothing: true } } }],
    ['a JSON array', { status: 200, raw: '[1,2]' }],
  ]) {
    test(`${name}: prints the fallback, exit 0, nothing on stderr`, async () => {
      const api = await fakeApi(() => answer);
      try {
        const res = await runHook('start', ccInput('SessionStart', { source: 'startup' }), envFor(api.url));
        assertQuiet(res);
        assert.ok(contextOf(res.stdout).startsWith('Constella memory is connected for this repo'));
      } finally {
        await api.close();
      }
    });
  }

  test('server down: prints the fallback', async () => {
    const res = await runHook('start', ccInput('SessionStart', { source: 'startup' }), envFor(await deadUrl()));
    assertQuiet(res);
    assert.ok(contextOf(res.stdout).startsWith('Constella memory is connected for this repo'));
  });

  test('slow server: gives up inside the 3 s budget and prints the fallback', async () => {
    const api = await fakeApi(() => ({ ...recallAnswer(SOURCES), delayMs: 6000 }));
    try {
      const res = await runHook('start', ccInput('SessionStart', { source: 'startup' }), envFor(api.url));
      assertQuiet(res);
      assert.ok(res.ms < 3600, `took ${res.ms} ms`);
      assert.ok(contextOf(res.stdout).startsWith('Constella memory is connected for this repo'));
    } finally {
      await api.close();
    }
  });

  test('source "compact" adds the save-a-handoff line (with data and in the fallback)', async () => {
    const api = await fakeApi(() => recallAnswer(SOURCES));
    try {
      const withData = await runHook('start', ccInput('SessionStart', { source: 'compact' }), envFor(api.url));
      assertQuiet(withData);
      assert.ok(contextOf(withData.stdout).includes('Context was just compacted. If a handoff for this work is not saved yet, save one now'));
      assert.ok(contextOf(withData.stdout).includes('id="handoff:acme-widget@feat-login"'));
      const noKey = await runHook('start', ccInput('SessionStart', { source: 'compact' }), envFor(api.url, { key: null }));
      assert.ok(contextOf(noKey.stdout).includes('Context was just compacted.'));
    } finally {
      await api.close();
    }
  });

  test('outside git: uses the folder name, still exits 0', async () => {
    const loose = path.join(tempDir(), 'Scratch-Folder');
    cleanup.push(path.dirname(loose));
    fs.mkdirSync(loose);
    const api = await fakeApi(() => recallAnswer([]));
    try {
      const res = await runHook('start', { ...ccInput('SessionStart', { source: 'startup' }), cwd: loose }, envFor(api.url));
      assertQuiet(res);
      assert.equal(api.requests[0].body.arguments.repo, 'scratch-folder');
      assert.ok(contextOf(res.stdout).includes('No saved handoff, rules or decisions for this repo yet.'));
    } finally {
      await api.close();
    }
  });

  test('empty or broken stdin still exits 0 with the fallback', async () => {
    const api = await fakeApi(() => recallAnswer([]));
    try {
      const { run, HOOK } = await import('./helpers.mjs');
      const res = await run(HOOK, ['start'], { input: 'not json at all', env: envFor(api.url, { key: null }), cwd: repo.dir });
      assertQuiet(res);
      assert.ok(contextOf(res.stdout).startsWith('Constella memory is connected'));
    } finally {
      await api.close();
    }
  });
});

describe('file (PreToolUse)', () => {
  const fileSources = [
    { id: 'f1', tier: 'file', title: 'API errors', text: 'Errors under src/api return {detail}.' },
    { id: 'f2', tier: 'file', title: 'Auth', text: 'Tokens refresh in src/api/auth.ts only.' },
    { id: 'r9', tier: 'rule', title: 'Not a file item', text: 'Should not show.' },
    { id: 'n9', tier: 'repo', title: 'Repo item', text: 'Should not show either.' },
  ];

  test('asks once per folder per session and prints only unseen file items', async () => {
    const api = await fakeApi(() => recallAnswer(fileSources));
    const data = tempDir('constella-data-');
    cleanup.push(data);
    try {
      const env = envFor(api.url, { data });
      const base = ccInput('PreToolUse');
      const edit = (file) => ({ ...base, tool_name: 'Edit', tool_input: { file_path: path.join(repo.dir, file), old_string: 'a', new_string: 'b' }, tool_use_id: 't' });

      const first = await runHook('file', edit('src/api/users.ts'), env);
      assertQuiet(first);
      const out = JSON.parse(first.stdout);
      assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
      assert.deepEqual(Object.keys(out.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
      assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
      const text = out.hookSpecificOutput.additionalContext;
      assert.ok(text.includes('[f1]') && text.includes('[f2]'));
      assert.ok(!text.includes('[r9]') && !text.includes('[n9]'));
      assert.ok(text.length <= 1500);
      assert.equal(api.requests.length, 1);
      assert.deepEqual(api.requests[0].body, { arguments: { repo: 'acme/widget', files: ['src/api/users.ts'], limit: 6 } });

      const sameFolder = await runHook('file', edit('src/api/other.ts'), env);
      assertQuiet(sameFolder);
      assert.equal(sameFolder.stdout, '');
      assert.equal(api.requests.length, 1, 'no second call for the same folder');

      const otherFolder = await runHook('file', edit('src/ui/button.tsx'), env);
      assertQuiet(otherFolder);
      assert.equal(api.requests.length, 2, 'a new folder is asked');
      assert.equal(otherFolder.stdout, '', 'f1 and f2 were already shown, so nothing new');
    } finally {
      await api.close();
    }
  });

  test('items shown at session start are not repeated before an edit', async () => {
    const api = await fakeApi((req) => (req.body.arguments.files ? recallAnswer([{ id: 'f1', tier: 'file', text: 'seen' }, { id: 'f3', tier: 'file', text: 'new one' }]) : recallAnswer(SOURCES)));
    const data = tempDir('constella-data-');
    cleanup.push(data);
    try {
      const env = envFor(api.url, { data });
      const session = ccInput('SessionStart', { source: 'startup' });
      await runHook('start', session, env);
      const res = await runHook('file', { ...session, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(repo.dir, 'src/api/x.ts'), content: '' } }, env);
      assertQuiet(res);
      const text = contextOf(res.stdout);
      assert.ok(text.includes('[f3]'));
      assert.ok(!text.includes('[f1]'));
    } finally {
      await api.close();
    }
  });

  test('a file outside the repo: nothing, no request', async () => {
    const api = await fakeApi(() => recallAnswer(fileSources));
    try {
      const res = await runHook('file', { ...ccInput('PreToolUse'), tool_name: 'Write', tool_input: { file_path: '/tmp/elsewhere/notes.md', content: '' } }, envFor(api.url));
      assertQuiet(res);
      assert.equal(res.stdout, '');
      assert.equal(api.requests.length, 0);
    } finally {
      await api.close();
    }
  });

  test('no key: nothing, no request', async () => {
    const api = await fakeApi(() => recallAnswer(fileSources));
    try {
      const res = await runHook('file', { ...ccInput('PreToolUse'), tool_name: 'Edit', tool_input: { file_path: path.join(repo.dir, 'src/a.ts') } }, envFor(api.url, { key: null }));
      assertQuiet(res);
      assert.equal(res.stdout, '');
      assert.equal(api.requests.length, 0);
    } finally {
      await api.close();
    }
  });

  test('server error, down or slow: nothing, exit 0, inside the 1.5 s budget', async () => {
    const slow = await fakeApi(() => ({ ...recallAnswer(fileSources), delayMs: 5000 }));
    const broken = await fakeApi(() => ({ status: 503, raw: 'oops' }));
    try {
      for (const url of [slow.url, broken.url, await deadUrl()]) {
        const res = await runHook('file', { ...ccInput('PreToolUse'), tool_name: 'Edit', tool_input: { file_path: path.join(repo.dir, 'src/a.ts') } }, envFor(url));
        assertQuiet(res);
        assert.equal(res.stdout, '');
        assert.ok(res.ms < 2100, `took ${res.ms} ms`);
      }
    } finally {
      await slow.close();
      await broken.close();
    }
  });

  test('never prints a permission decision', async () => {
    const api = await fakeApi(() => recallAnswer(fileSources));
    try {
      const res = await runHook('file', { ...ccInput('PreToolUse'), tool_name: 'Edit', tool_input: { file_path: path.join(repo.dir, 'src/b.ts') } }, envFor(api.url));
      assert.ok(!/permissionDecision|"decision"|"continue"/.test(res.stdout));
    } finally {
      await api.close();
    }
  });
});

describe('compact (PreCompact)', () => {
  test('Claude Code: plain text instructions for the summary', async () => {
    const res = await runHook('compact', ccInput('PreCompact', { trigger: 'auto' }), envFor(await deadUrl()));
    assertQuiet(res);
    assert.ok(res.stdout.includes('keep: the decisions made and why, what is done, what is next, the open questions'));
    assert.throws(() => JSON.parse(res.stdout));
  });
});

describe('the key never leaks', () => {
  test('not in stdout, stderr or the debug log, even with CONSTELLA_DEBUG=1 and errors', async () => {
    const api = await fakeApi((req) => (req.body.arguments.files ? { status: 500, raw: `echo ${FAKE_KEY}` } : recallAnswer(SOURCES)));
    const data = tempDir('constella-data-');
    cleanup.push(data);
    try {
      const env = envFor(api.url, { data, debug: true });
      const session = ccInput('SessionStart', { source: 'startup' });
      const outputs = [];
      outputs.push(await runHook('start', session, env));
      outputs.push(await runHook('file', { ...session, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(repo.dir, 'src/a.ts') } }, env));
      outputs.push(await runHook('compact', { ...session, hook_event_name: 'PreCompact' }, env));
      outputs.push(await runHook('start', session, { ...env, CONSTELLA_API_URL: await deadUrl() }));
      for (const res of outputs) {
        assertQuiet(res);
        assert.ok(!res.stdout.includes(FAKE_KEY));
        assert.ok(!res.stdout.includes('SECRET'));
      }
      const log = fs.readFileSync(path.join(data, 'debug.log'), 'utf8');
      assert.ok(log.split('\n').filter(Boolean).length >= 4, 'debug lines were written');
      assert.ok(!log.includes(FAKE_KEY));
      assert.ok(!log.includes('SECRET'));
      for (const name of fs.readdirSync(path.join(data, 'sessions'))) {
        assert.ok(!fs.readFileSync(path.join(data, 'sessions', name), 'utf8').includes(FAKE_KEY));
      }
    } finally {
      await api.close();
    }
  });

  test('no debug log unless CONSTELLA_DEBUG=1', async () => {
    const data = tempDir('constella-data-');
    cleanup.push(data);
    await runHook('start', ccInput('SessionStart', { source: 'startup' }), envFor(await deadUrl(), { data }));
    assert.equal(fs.existsSync(path.join(data, 'debug.log')), false);
  });
});
