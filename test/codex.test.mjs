// The hook with Codex-shaped input: Codex sends `turn_id` and `model`, keeps transcripts under ~/.codex,
// sets PLUGIN_ROOT / PLUGIN_DATA for plugin hooks, and edits files through `apply_patch`.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { FAKE_KEY, cleanEnv, contextOf, fakeApi, makeRepo, recallAnswer, removeDir, runHook, tempDir } from './helpers.mjs';

const cleanup = [];
after(() => cleanup.forEach(removeDir));

let repo;
before(() => {
  repo = makeRepo({ remote: 'https://github.com/Acme/Widget.git', branch: 'main' });
  cleanup.push(repo.parent);
  fs.mkdirSync(path.join(repo.dir, 'src', 'api'), { recursive: true });
});

/** Environment like Codex gives a plugin hook (PLUGIN_ROOT/PLUGIN_DATA plus the CLAUDE_* copies). */
function codexEnv(api, { key = FAKE_KEY } = {}) {
  const data = tempDir('constella-codex-data-');
  cleanup.push(data);
  return cleanEnv({
    CONSTELLA_API_URL: api,
    CONSTELLA_API_KEY: key || undefined,
    PLUGIN_ROOT: '/fake/codex/plugin',
    PLUGIN_DATA: data,
    CLAUDE_PLUGIN_ROOT: '/fake/codex/plugin',
    CLAUDE_PLUGIN_DATA: data,
  });
}

function codexInput(event, extra = {}) {
  return {
    session_id: `codex-${Math.random().toString(36).slice(2)}`,
    transcript_path: '/Users/me/.codex/sessions/2026/11/24/rollout.jsonl',
    cwd: repo.dir,
    hook_event_name: event,
    model: 'gpt-5.5-codex',
    ...extra,
  };
}

const PATCH = ['*** Begin Patch', '*** Update File: src/api/users.ts', '@@', '-a', '+b', '*** End Patch'].join('\n');

describe('Codex', () => {
  test('SessionStart sends X-Constella-Client: codex and prints JSON additionalContext', async () => {
    const api = await fakeApi(() => recallAnswer([{ id: 'r1', tier: 'rule', text: 'Use pnpm.' }]));
    try {
      const res = await runHook('start', codexInput('SessionStart', { source: 'startup' }), codexEnv(api.url));
      assert.equal(res.code, 0);
      assert.equal(res.stderr, '');
      const out = JSON.parse(res.stdout);
      assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.ok(out.hookSpecificOutput.additionalContext.includes('[r1]'));
      assert.equal(api.requests[0].headers['x-constella-client'], 'codex');
      assert.deepEqual(api.requests[0].body.arguments, { repo: 'acme/widget', limit: 12, scope: 'all' });
    } finally {
      await api.close();
    }
  });

  test('PreToolUse on apply_patch reads the file from the patch', async () => {
    const api = await fakeApi(() => recallAnswer([{ id: 'f1', tier: 'file', text: 'Errors under src/api return {detail}.' }]));
    try {
      const input = codexInput('PreToolUse', {
        turn_id: 'turn-1',
        tool_name: 'apply_patch',
        tool_use_id: 'call-1',
        tool_input: { command: PATCH },
      });
      const res = await runHook('file', input, codexEnv(api.url));
      assert.equal(res.code, 0);
      assert.equal(res.stderr, '');
      const out = JSON.parse(res.stdout);
      assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
      assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.ok(contextOf(res.stdout).includes('[f1]'));
      assert.equal(api.requests[0].headers['x-constella-client'], 'codex');
      assert.deepEqual(api.requests[0].body.arguments, { repo: 'acme/widget', files: ['src/api/users.ts'], limit: 6 });
    } finally {
      await api.close();
    }
  });

  test('a patch that only touches files outside the repo: nothing', async () => {
    const api = await fakeApi(() => recallAnswer([{ id: 'f1', tier: 'file', text: 'x' }]));
    try {
      const patch = ['*** Begin Patch', '*** Update File: ../../outside.txt', '*** End Patch'].join('\n');
      const input = codexInput('PreToolUse', { turn_id: 't', tool_name: 'apply_patch', tool_input: { command: patch } });
      const res = await runHook('file', input, codexEnv(api.url));
      assert.equal(res.code, 0);
      assert.equal(res.stdout, '');
      assert.equal(api.requests.length, 0);
    } finally {
      await api.close();
    }
  });

  test('PreCompact prints nothing (Codex ignores PreCompact text)', async () => {
    const res = await runHook('compact', codexInput('PreCompact', { turn_id: 't' }), codexEnv('http://127.0.0.1:9'));
    assert.equal(res.code, 0);
    assert.equal(res.stdout, '');
    assert.equal(res.stderr, '');
  });

  test('SessionStart after compaction (source "compact") asks for a handoff', async () => {
    const res = await runHook('start', codexInput('SessionStart', { source: 'compact' }), codexEnv('http://127.0.0.1:9', { key: null }));
    assert.equal(res.code, 0);
    assert.ok(contextOf(res.stdout).includes('Context was just compacted.'));
  });
});
