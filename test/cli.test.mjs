// The tiny CLI, run as a child process against the fake API.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { CLI, FAKE_KEY, cleanEnv, fakeApi, makeRepo, removeDir, run } from './helpers.mjs';

const cleanup = [];
after(() => cleanup.forEach(removeDir));

let repo;
before(() => {
  repo = makeRepo({ remote: 'git@github.com:Acme/Widget.git', branch: 'feat/login' });
  cleanup.push(repo.parent);
});

function cli(api, args, { key = FAKE_KEY, cwd } = {}) {
  return run(CLI, args, { env: cleanEnv({ CONSTELLA_API_URL: api.url || api, CONSTELLA_API_KEY: key || undefined }), cwd: cwd || repo.dir });
}

describe('constella CLI', () => {
  let api;
  before(async () => {
    api = await fakeApi((req) => ({ status: 200, body: { result: req.url.endsWith('memory_add') ? { id: 'm1', app: 'agents', updated: false } : { sources: [] } } }));
  });
  after(() => api.close());

  test('recall: repo from git, files split, default client "agents"', async () => {
    const res = await cli(api, ['recall', '--query', 'login flow', '--files', 'src/a.ts, src/b.ts']);
    assert.equal(res.code, 0, res.stdout);
    assert.deepEqual(JSON.parse(res.stdout), { sources: [] });
    const req = api.requests.at(-1);
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/platform/v1/me/tools/memory_recall');
    assert.equal(req.headers.authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(req.headers['x-constella-client'], 'agents');
    assert.deepEqual(req.body, { arguments: { repo: 'acme/widget', query: 'login flow', files: ['src/a.ts', 'src/b.ts'] } });
  });

  test('recall: --repo is normalized, --client is sent', async () => {
    await cli(api, ['recall', '--repo', 'https://github.com/Other/Thing.git', '--client', 'my-ci']);
    const req = api.requests.at(-1);
    assert.equal(req.headers['x-constella-client'], 'my-ci');
    assert.deepEqual(req.body.arguments, { repo: 'other/thing' });
  });

  test('add: kind, id, place with path, replaces, to', async () => {
    const res = await cli(api, ['add', '--text', 'We use pnpm.', '--kind', 'decision', '--id', 'pkg-manager', '--path', 'package.json', '--replaces', 'old-1', '--to', 'me']);
    assert.equal(res.code, 0, res.stdout);
    assert.deepEqual(JSON.parse(res.stdout), { id: 'm1', app: 'agents', updated: false });
    const req = api.requests.at(-1);
    assert.equal(req.url, '/platform/v1/me/tools/memory_add');
    assert.deepEqual(req.body, {
      arguments: { text: 'We use pnpm.', to: 'me', kind: 'decision', id: 'pkg-manager', places: [{ repo: 'acme/widget', path: 'package.json' }], replaces: 'old-1' },
    });
  });

  test('add outside git with no --repo: no places', async () => {
    const { tempDir } = await import('./helpers.mjs');
    const loose = tempDir();
    cleanup.push(loose);
    await cli(api, ['add', '--text', 'A fact.'], { cwd: loose });
    assert.deepEqual(api.requests.at(-1).body.arguments, { text: 'A fact.', to: 'me' });
  });

  test('handoff: fills kind, id and place from git', async () => {
    const res = await cli(api, ['handoff', '--text', 'Goal: a\nDone: b\nNext: c\nOpen questions: d\nBranch and key files: e']);
    assert.equal(res.code, 0, res.stdout);
    assert.deepEqual(api.requests.at(-1).body.arguments, {
      text: 'Goal: a\nDone: b\nNext: c\nOpen questions: d\nBranch and key files: e',
      to: 'me',
      kind: 'handoff',
      id: 'handoff:acme-widget@feat-login',
      places: [{ repo: 'acme/widget' }],
    });
  });

  test('where: prints repo, branch and the ready-made handoff id, needs no key', async () => {
    const res = await cli(api, ['where'], { key: null });
    assert.equal(res.code, 0, res.stdout);
    assert.deepEqual(JSON.parse(res.stdout), { repo: 'acme/widget', branch: 'feat/login', handoff_id: 'handoff:acme-widget@feat-login' });
  });

  test('handoff with --repo and --branch builds a valid id', async () => {
    await cli(api, ['handoff', '--text', 'Goal: x', '--repo', 'Acme/Web-App', '--branch', 'feat/login', '--replaces', 'handoff:acme-web-app@feat-login']);
    const args = api.requests.at(-1).body.arguments;
    assert.equal(args.id, 'handoff:acme-web-app@feat-login');
    assert.deepEqual(args.places, [{ repo: 'acme/web-app' }]);
    assert.equal(args.replaces, 'handoff:acme-web-app@feat-login');
  });

  test('no key: exit 2, says where to get one, makes no request', async () => {
    const before = api.requests.length;
    const res = await cli(api, ['recall'], { key: null });
    assert.equal(res.code, 2);
    assert.match(JSON.parse(res.stdout).error, /Settings > Developer/);
    assert.equal(api.requests.length, before);
  });

  test('doctor: every check passes, one line each, the key is never shown', async () => {
    const res = await cli(api, ['doctor', '--client', 'codex']);
    assert.equal(res.code, 0, res.stdout);
    const lines = res.stdout.trim().split('\n');
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^ok\s+node\s+v\d+/);
    assert.match(lines[1], /^ok\s+repo\s+acme\/widget \(branch feat\/login\)$/);
    assert.match(lines[2], /^ok\s+key\s+a key is set \(not shown\)$/);
    assert.match(lines[3], /^ok\s+api\s+http:\/\/127\.0\.0\.1:\d+ answered/);
    assert.ok(!res.stdout.includes(FAKE_KEY) && !res.stderr.includes(FAKE_KEY));
    const req = api.requests.at(-1);
    assert.equal(req.url, '/platform/v1/me/tools/memory_recall');
    assert.equal(req.headers['x-constella-client'], 'codex');
    assert.deepEqual(req.body, { arguments: { limit: 1, repo: 'acme/widget' } });
  });

  test('doctor with no key: key fails, api is skipped, no request, exit 1', async () => {
    const before = api.requests.length;
    const res = await cli(api, ['doctor'], { key: null });
    assert.equal(res.code, 1);
    assert.match(res.stdout, /^FAIL\s+key\s+CONSTELLA_API_KEY is not set/m);
    assert.match(res.stdout, /^skip\s+api\s/m);
    assert.match(res.stdout, /^ok\s+repo\s/m);
    assert.equal(api.requests.length, before);
  });

  test('doctor outside git: repo fails, the key is still checked', async () => {
    const { tempDir } = await import('./helpers.mjs');
    const loose = tempDir();
    cleanup.push(loose);
    const res = await cli(api, ['doctor'], { cwd: loose });
    assert.equal(res.code, 1);
    assert.match(res.stdout, /^FAIL\s+repo\s+this folder is not inside a git repo/m);
    assert.match(res.stdout, /^ok\s+api\s/m);
    assert.deepEqual(api.requests.at(-1).body, { arguments: { limit: 1 } });
  });

  test('doctor with a bad key or a dead server: api fails, exit 1, never the key', async () => {
    const { deadUrl } = await import('./helpers.mjs');
    const bad = await fakeApi(() => ({ status: 401, body: { detail: { code: 'bad_key', message: 'That key is not valid.' } } }));
    try {
      const refused = await cli(bad, ['doctor']);
      assert.equal(refused.code, 1);
      assert.match(refused.stdout, /^FAIL\s+api\s.*did not accept the key \(401\)/m);
      assert.ok(!refused.stdout.includes(FAKE_KEY));
    } finally {
      await bad.close();
    }
    const down = await cli(await deadUrl(), ['doctor']);
    assert.equal(down.code, 1);
    assert.match(down.stdout, /^FAIL\s+api\s.*could not be reached/m);
    assert.ok(!down.stdout.includes(FAKE_KEY));
  });

  test('bad usage: exit 2', async () => {
    assert.equal((await cli(api, ['add'])).code, 2);
    assert.equal((await cli(api, ['nope'])).code, 2);
    assert.equal((await cli(api, ['recall', '--bogus', 'x'])).code, 2);
    const help = await cli(api, ['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /constella recall/);
  });

  test('a server error: exit 1, shows the server message, never the key', async () => {
    const bad = await fakeApi(() => ({ status: 401, body: { detail: { code: 'bad_key', message: 'That key is not valid.' } } }));
    try {
      const res = await cli(bad, ['recall']);
      assert.equal(res.code, 1);
      const out = JSON.parse(res.stdout);
      assert.equal(out.code, 'bad_key');
      assert.equal(out.status, 401);
      assert.ok(!res.stdout.includes(FAKE_KEY) && !res.stderr.includes(FAKE_KEY));
    } finally {
      await bad.close();
    }
  });
});
