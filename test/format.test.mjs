import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FILE_CAP, START_CAP, ageText, clip, fallbackBlock, fileBlock, handoffId, startBlock } from '../scripts/lib/format.mjs';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const HOUR = 3600 * 1000;

function sample() {
  return [
    { id: 'n1', tier: 'repo', title: 'Use pnpm', text: 'We use pnpm, not npm, because of workspaces.', updated_at_ms: NOW - 5 * HOUR },
    { id: 'r1', tier: 'rule', title: 'No startup DDL', text: 'Table changes go through migrations.', updated_at_ms: NOW - 2 * HOUR },
    { id: 'h1', tier: 'handoff', title: 'handoff', text: 'Goal: ship login\nDone: form\nNext: tests', saved_by: 'codex', updated_at_ms: NOW - 3 * HOUR },
    { id: 'f1', tier: 'file', title: 'API errors', text: 'Errors in src/api return {detail}.', updated_at_ms: NOW - HOUR },
  ];
}

describe('helpers', () => {
  test('ageText', () => {
    assert.equal(ageText(NOW - 30 * 1000, NOW), 'just now');
    assert.equal(ageText(NOW - 12 * 60 * 1000, NOW), '12 min ago');
    assert.equal(ageText(NOW - 3 * HOUR, NOW), '3 h ago');
    assert.equal(ageText(NOW - 5 * 24 * HOUR, NOW), '5 days ago');
    assert.equal(ageText(0, NOW), '');
    assert.equal(ageText(undefined, NOW), '');
  });

  test('clip cuts to the limit and flattens lines', () => {
    assert.equal(clip('a\n\nb   c', 50), 'a b c');
    const long = clip('x'.repeat(500), 220);
    assert.equal(long.length, 220);
    assert.ok(long.endsWith('…'));
  });
});

describe('handoffId', () => {
  test('only letters, digits and . _ : @ - survive; repo is lowercased', () => {
    assert.equal(handoffId('Acme/Web-App', 'feat/login'), 'handoff:acme-web-app@feat-login');
    assert.equal(handoffId('acme/widget', 'main'), 'handoff:acme-widget@main');
    assert.equal(handoffId('group/sub/proj', 'Fix Bug#12'), 'handoff:group-sub-proj@Fix-Bug-12');
    assert.equal(handoffId('a/b', ''), 'handoff:a-b@none');
    assert.equal(handoffId('a/b', 'HEAD'), 'handoff:a-b@detached');
  });

  test('always matches the server rule and is at most 128 characters', () => {
    const id = handoffId('owner/'.repeat(30), 'branch/'.repeat(30));
    assert.ok(id.length <= 128);
    assert.match(id, /^[A-Za-z0-9._:@-]{1,128}$/);
    assert.match(handoffId('ö/ü', 'ç'), /^[A-Za-z0-9._:@-]+$/);
  });
});

describe('startBlock', () => {
  test('each rule and note names the tool that saved it, when the server says', () => {
    const sources = [
      { id: 'd1', tier: 'file', title: 'Keychain', text: 'Tokens live in the keychain.', saved_by: 'codex' },
      { id: 'd2', tier: 'repo', title: 'Tabs', text: 'Indent with tabs.' },
    ];
    const text = startBlock({ repo: 'acme/widget', branch: 'main', sources, saveTo: 'me', now: NOW });
    assert.ok(text.includes('[d1] (saved by codex)'));
    assert.ok(text.includes('[d2]\n') || text.includes('[d2]'));
    assert.ok(!text.includes('[d2] (saved by'));
  });

  test('order is handoff, rules, then file and repo notes, with the how-to footer', () => {
    const text = startBlock({ repo: 'acme/widget', branch: 'main', sources: sample(), saveTo: 'me', now: NOW });
    const at = (s) => text.indexOf(s);
    assert.ok(text.startsWith('Constella memory (repo: acme/widget, branch: main)'));
    assert.ok(at('Last handoff (codex, 3 h ago, id h1):') > 0);
    assert.ok(at('Last handoff') < at('Rules:'));
    assert.ok(at('Rules:') < at('Decisions and notes for this repo:'));
    assert.ok(at('[r1]') > at('Rules:'));
    assert.ok(at('[f1]') > at('Decisions and notes') && at('[f1]') < at('[n1]'));
    assert.ok(text.includes('Goal: ship login\nDone: form\nNext: tests'));
    assert.ok(text.includes('memory_recall(repo="acme/widget"'));
    assert.ok(text.includes('to="me"'));
    assert.ok(text.includes('id="handoff:acme-widget@main"'));
    assert.ok(text.length <= START_CAP);
  });

  test('never goes over the cap, and says how many were left out', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `id-${i}`,
      tier: i % 3 === 0 ? 'rule' : 'repo',
      title: `Title ${i}`,
      text: 'word '.repeat(200),
    }));
    many.unshift({ id: 'h', tier: 'handoff', text: 'Goal: '.padEnd(5000, 'g') });
    const text = startBlock({ repo: 'acme/widget', branch: 'main', sources: many, now: NOW });
    assert.ok(text.length <= START_CAP, `length ${text.length}`);
    assert.match(text, /\(\d+ more not shown here;/);
    // The handoff is cut at 900 characters.
    const handoffLine = text.split('\n').find((l) => l.startsWith('Last handoff'));
    assert.ok(handoffLine.length < 1000);
  });

  test('cuts each item at 220 characters of text', () => {
    const text = startBlock({ repo: 'a/b', branch: 'main', sources: [{ id: 'x', tier: 'rule', text: 'y'.repeat(1000) }], now: NOW });
    const line = text.split('\n').find((l) => l.includes('[x]'));
    assert.ok(line.length < 240, `length ${line.length}`);
  });

  test('empty recall says so', () => {
    const text = startBlock({ repo: 'a/b', branch: 'dev', sources: [], now: NOW });
    assert.ok(text.includes('No saved handoff, rules or decisions for this repo yet.'));
  });

  test('skips broken items and repeated ids', () => {
    const text = startBlock({ repo: 'a/b', branch: 'dev', sources: [null, 7, { text: 'no id' }, { id: 'k', tier: 'rule', text: 'one' }, { id: 'k', tier: 'rule', text: 'two' }], now: NOW });
    assert.ok(text.includes('one'));
    assert.ok(!text.includes('two'));
    assert.ok(!text.includes('no id'));
  });

  test('compact adds the save-a-handoff line', () => {
    const text = startBlock({ repo: 'a/b', branch: 'dev', sources: sample(), compact: true, now: NOW });
    assert.ok(text.includes('Context was just compacted.'));
  });

  test('names cannot break out of the quotes', () => {
    const text = startBlock({ repo: 'a/b"); evil("', branch: 'x`y', sources: [], now: NOW });
    assert.ok(!text.includes('"); evil'));
    assert.ok(text.includes('id="handoff:a-b----evil--@x-y"'));
    assert.ok(!text.includes('`'));
  });
});

describe('fallbackBlock and fileBlock', () => {
  test('fallback is three lines, four after a compaction', () => {
    assert.equal(fallbackBlock({ repo: 'a/b', branch: 'main' }).split('\n').length, 3);
    assert.equal(fallbackBlock({ repo: 'a/b', branch: 'main', compact: true }).split('\n').length, 4);
    assert.ok(fallbackBlock({ repo: 'a/b', branch: 'main' }).includes('memory_recall(repo="a/b", files=['));
  });

  test('file block stays under its cap', () => {
    const sources = Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, tier: 'file', text: 'z'.repeat(400) }));
    const text = fileBlock({ files: ['src/a.ts'], repo: 'a/b', sources, now: NOW });
    assert.ok(text.length <= FILE_CAP);
    assert.ok(text.startsWith('Constella memory pinned to src/a.ts or its folders'));
    assert.match(text, /more: memory_recall/);
  });
});
