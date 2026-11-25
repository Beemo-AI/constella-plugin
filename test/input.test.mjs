import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { detectHost, editedFiles, patchPaths, pickMode } from '../scripts/lib/input.mjs';

const PATCH = [
  '*** Begin Patch',
  '*** Update File: src/api/users.ts',
  '@@',
  '-a',
  '+b',
  '*** Add File: src/api/new.ts',
  '+x',
  '*** Update File: src/old.ts',
  '*** Move to: src/lib/moved.ts',
  '*** Delete File: docs/gone.md',
  '*** End Patch',
].join('\n');

describe('input', () => {
  test('patchPaths reads every file an apply_patch touches', () => {
    assert.deepEqual(patchPaths(PATCH), ['src/api/users.ts', 'src/api/new.ts', 'src/old.ts', 'docs/gone.md', 'src/lib/moved.ts']);
  });

  test('editedFiles for Claude Code tools', () => {
    assert.deepEqual(editedFiles({ tool_name: 'Edit', tool_input: { file_path: '/r/a.ts' } }), ['/r/a.ts']);
    assert.deepEqual(editedFiles({ tool_name: 'Write', tool_input: { file_path: '/r/b.ts', content: 'x' } }), ['/r/b.ts']);
    assert.deepEqual(editedFiles({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/r/n.ipynb' } }), ['/r/n.ipynb']);
    assert.deepEqual(editedFiles({ tool_name: 'Edit', tool_input: {} }), []);
    assert.deepEqual(editedFiles({}), []);
  });

  test('editedFiles for Codex apply_patch', () => {
    assert.deepEqual(editedFiles({ tool_name: 'apply_patch', tool_input: { command: PATCH } }).slice(0, 2), ['src/api/users.ts', 'src/api/new.ts']);
  });

  test('detectHost', () => {
    assert.equal(detectHost([], {}, { session_id: 's' }), 'claude-code');
    assert.equal(detectHost(['--client', 'codex'], {}, {}), 'codex');
    assert.equal(detectHost([], { CONSTELLA_CLIENT: 'cursor' }, {}), 'cursor');
    assert.equal(detectHost([], {}, { turn_id: 't1' }), 'codex');
    assert.equal(detectHost([], {}, { tool_name: 'apply_patch' }), 'codex');
    assert.equal(detectHost([], {}, { transcript_path: '/Users/x/.codex/sessions/a.jsonl' }), 'codex');
    assert.equal(detectHost([], { PLUGIN_ROOT: '/p' }, {}), 'codex');
    assert.equal(detectHost([], { PLUGIN_ROOT: '/p', CLAUDE_PROJECT_DIR: '/r' }, {}), 'claude-code');
    assert.equal(detectHost([], {}, { transcript_path: '/Users/x/.claude/projects/a.jsonl' }), 'claude-code');
  });

  test('pickMode from args, else from the event name', () => {
    assert.equal(pickMode(['start'], null), 'start');
    assert.equal(pickMode(['--client', 'codex', 'file'], null), 'file');
    assert.equal(pickMode([], { hook_event_name: 'PreCompact' }), 'compact');
    assert.equal(pickMode([], { hook_event_name: 'SessionStart' }), 'start');
    assert.equal(pickMode([], { hook_event_name: 'Stop' }), '');
  });
});
