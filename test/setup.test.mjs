// `constella setup`: the saved key, the browser sign-in (against a fake sign-in server), and what is written
// for each AI tool (with fake `claude` and `codex` programs on PATH). No real network, key, browser or tool.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, test } from 'node:test';

import { CLI, FAKE_KEY, ROOT, cleanEnv, fakeApi, makeRepo, removeDir, run, runHook, tempDir } from './helpers.mjs';
import { apiBase, apiKey } from '../scripts/lib/api.mjs';
import { readCredentials, sameServer, savedFor, writeCredentials } from '../scripts/lib/credentials.mjs';
import { withCodexServer } from '../scripts/lib/tools.mjs';

const HEADERS = path.join(ROOT, 'scripts', 'mcp-headers.mjs');

/** A fake Constella: the sign-in routes, the key route and the "does this key work" route. */
async function fakeConstella({ keyRoute = true } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      calls.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body: data });
      const json = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/mcp/oauth/register') return json(201, { client_id: 'client_1' });
      if (url.pathname === '/mcp/oauth/authorize') {
        // The real page signs the person in; the fake one sends the "browser" straight back.
        const back = new URL(url.searchParams.get('redirect_uri'));
        back.searchParams.set('code', 'one_time_code');
        back.searchParams.set('state', url.searchParams.get('state'));
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (url.pathname === '/mcp/oauth/token') return json(200, { access_token: 'cot_access', refresh_token: 'cor_r', scope: 'constella:mcp constella:mcp:write constella:key' });
      if (url.pathname === '/mcp/oauth/api-key' && keyRoute) {
        return req.headers.authorization === 'Bearer cot_access' ? json(200, { api_key: FAKE_KEY, email: 'me@example.com' }) : json(403, { error: 'insufficient_scope' });
      }
      if (url.pathname === '/mcp/oauth/revoke') return json(200, {});
      if (url.pathname === '/platform/v1/me/tools') return req.headers.authorization === `Bearer ${FAKE_KEY}` ? json(200, { tools: [] }) : json(401, { detail: 'no' });
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not Found');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/** Folders for one test: a Constella home, a fake Cursor home, and a bin folder with fake `claude`/`codex`. */
function sandbox({ tools = [], codexListFails = false } = {}) {
  const dir = tempDir('constella-setup-');
  const home = path.join(dir, 'home');
  const cursor = path.join(dir, 'cursor');
  const codexHome = path.join(dir, 'codex');
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'calls.log');
  fs.mkdirSync(bin, { recursive: true });
  for (const tool of tools) {
    // Each fake logs its arguments, one call per line, and answers like the real tool where setup looks.
    const script = `#!/bin/sh
echo "${tool} $*" >> "${log}"
if [ "${tool}" = "codex" ] && [ "$1" = "mcp" ] && [ "$2" = "list" ]; then
  ${codexListFails ? 'echo "config error" >&2; exit 1' : 'echo "constella   http://x/mcp   -   enabled   Bearer token"; exit 0'}
fi
if [ "${tool}" = "claude" ] && [ "$1" = "mcp" ] && [ "$2" = "get" ]; then echo "No MCP server found"; exit 1; fi
exit 0
`;
    fs.writeFileSync(path.join(bin, tool), script, { mode: 0o755 });
  }
  const env = (extra = {}) =>
    cleanEnv({ PATH: `${bin}:/usr/bin:/bin:${path.dirname(process.execPath)}`, CONSTELLA_HOME: home, CONSTELLA_CURSOR_HOME: cursor, CODEX_HOME: codexHome, ...extra });
  return { dir, home, cursor, codexHome, log, env, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

function stopHelper(home) {
  try {
    const { pid } = JSON.parse(fs.readFileSync(path.join(home, 'signin.json'), 'utf8'));
    if (pid) process.kill(pid);
  } catch {
    /* no helper left */
  }
}

describe('the saved key', () => {
  test('is written for this user only, and read back', () => {
    const box = sandbox();
    try {
      const env = box.env();
      const file = writeCredentials({ api_key: FAKE_KEY, api_url: 'https://api.constella.app/', email: 'me@example.com' }, env);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(box.home).mode & 0o777, 0o700);
      assert.deepEqual({ ...readCredentials(env), saved_at: '' }, { api_key: FAKE_KEY, api_url: 'https://api.constella.app', email: 'me@example.com', saved_at: '' });
    } finally {
      removeDir(box.dir);
    }
  });

  test('is only ever used for the server it was saved for', () => {
    const box = sandbox();
    try {
      const env = box.env();
      writeCredentials({ api_key: FAKE_KEY, api_url: 'https://api.constella.app' }, env);
      assert.equal(apiKey(env), FAKE_KEY);
      assert.equal(apiBase(env), 'https://api.constella.app');
      // The same production server under its other address: fine.
      assert.equal(apiKey({ ...env, CONSTELLA_API_URL: 'https://fastfind.app' }), FAKE_KEY);
      assert.equal(sameServer('https://www.fastfind.app/mcp', 'https://api.constella.app'), true);
      // Another server (a local one, a look-alike): the saved key is not handed out.
      assert.equal(apiKey({ ...env, CONSTELLA_API_URL: 'http://127.0.0.1:8030' }), '');
      assert.equal(savedFor('https://api.constella.app.evil.example', env), null);
      // A key in the environment always wins, and then the saved server is not used either.
      assert.equal(apiKey({ ...env, CONSTELLA_API_KEY: 'csk_other' }), 'csk_other');
      assert.equal(apiBase({ ...env, CONSTELLA_API_KEY: 'csk_other' }), 'https://api.constella.app');
    } finally {
      removeDir(box.dir);
    }
  });

  test('a key saved for a local server makes that server the default', () => {
    const box = sandbox();
    try {
      const env = box.env();
      writeCredentials({ api_key: FAKE_KEY, api_url: 'http://127.0.0.1:8030' }, env);
      assert.equal(apiBase(env), 'http://127.0.0.1:8030');
      assert.equal(apiKey(env), FAKE_KEY);
    } finally {
      removeDir(box.dir);
    }
  });

  test('the hook loads memory with the saved key, with no key in the environment', async () => {
    const box = sandbox();
    const api = await fakeApi(() => ({ status: 200, body: { result: { text: 'Constella memory (repo: acme/web-app)', sources: [] } } }));
    const repo = makeRepo({ remote: 'https://github.com/acme/web-app.git' });
    try {
      const env = box.env();
      writeCredentials({ api_key: FAKE_KEY, api_url: api.url }, env);
      const res = await runHook('start', { session_id: 's1', cwd: repo.dir, hook_event_name: 'SessionStart', source: 'startup' }, env);
      assert.equal(res.code, 0);
      assert.equal(api.requests.length, 1);
      assert.equal(api.requests[0].headers.authorization, `Bearer ${FAKE_KEY}`);
      assert.ok(!res.stdout.includes(FAKE_KEY) && !res.stderr.includes(FAKE_KEY));
    } finally {
      await api.close();
      removeDir(repo.parent);
      removeDir(box.dir);
    }
  });
});

describe("the header helper for Claude Code's MCP server", () => {
  test('prints {} with no key, so Claude Code signs in through the browser', async () => {
    const box = sandbox();
    try {
      const res = await run(HEADERS, [], { env: box.env({ CLAUDE_CODE_MCP_SERVER_URL: 'https://api.constella.app/mcp' }) });
      assert.equal(res.code, 0);
      assert.deepEqual(JSON.parse(res.stdout), {});
    } finally {
      removeDir(box.dir);
    }
  });

  test('prints the saved key for the Constella server, and nothing for any other server', async () => {
    const box = sandbox();
    try {
      const env = box.env();
      writeCredentials({ api_key: FAKE_KEY, api_url: 'https://api.constella.app' }, env);
      const ours = await run(HEADERS, [], { env: { ...env, CLAUDE_CODE_MCP_SERVER_URL: 'https://api.constella.app/mcp' } });
      assert.deepEqual(JSON.parse(ours.stdout), { Authorization: `Bearer ${FAKE_KEY}` });
      const other = await run(HEADERS, [], { env: { ...env, CLAUDE_CODE_MCP_SERVER_URL: 'https://evil.example/mcp' } });
      assert.deepEqual(JSON.parse(other.stdout), {});
    } finally {
      removeDir(box.dir);
    }
  });
});

describe('constella setup', () => {
  test('signs in once in the browser, saves the key, sets Cursor up, and never prints the key', async () => {
    const box = sandbox();
    const constella = await fakeConstella();
    fs.mkdirSync(box.cursor, { recursive: true });
    fs.writeFileSync(path.join(box.cursor, 'mcp.json'), JSON.stringify({ mcpServers: { other: { url: 'https://other.example/mcp' } } }));
    const env = box.env({ CONSTELLA_API_URL: constella.url });
    try {
      // First run: nobody has signed in yet, so it says so and hands over the link.
      const first = await run(CLI, ['setup', '--wait', '1', '--only', 'cursor', '--email', 'me@example.com'], { env });
      assert.equal(first.code, 3, first.stdout + first.stderr);
      assert.match(first.stdout, /^wait\s+sign-in\s+Waiting for you to sign in/m);
      const link = first.stdout.match(/^(http\S+\/mcp\/oauth\/authorize\?\S+)$/m)[1];
      const asked = new URL(link).searchParams;
      assert.equal(asked.get('scope'), 'constella:mcp constella:mcp:write constella:key');
      assert.equal(asked.get('code_challenge_method'), 'S256');
      assert.equal(asked.get('login_hint'), 'me@example.com');
      assert.match(asked.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      assert.equal(fs.existsSync(path.join(box.home, 'credentials.json')), false);

      // A callback with the wrong state is refused and changes nothing.
      const wrong = await fetch(`${asked.get('redirect_uri')}?code=x&state=wrong`);
      assert.equal(wrong.status, 400);

      // The "browser": open the link, get sent back to the helper on this computer.
      const tab = await fetch(link);
      assert.equal(tab.status, 200);
      assert.match(await tab.text(), /You are signed in/);

      // Second run: picks the finished sign-in up and sets the tools up.
      const second = await run(CLI, ['setup', '--wait', '5', '--only', 'cursor'], { env });
      assert.equal(second.code, 0, second.stdout + second.stderr);
      assert.match(second.stdout, /^ok\s+sign-in\s+signed in as me@example\.com/m);
      assert.match(second.stdout, /^ok\s+cursor\s+memory tools added/m);

      assert.equal(readCredentials(env).api_key, FAKE_KEY);
      assert.equal(readCredentials(env).api_url, constella.url);
      assert.equal(fs.existsSync(path.join(box.home, 'signin.json')), false);
      const cursor = JSON.parse(fs.readFileSync(path.join(box.cursor, 'mcp.json'), 'utf8'));
      assert.deepEqual(cursor.mcpServers.other, { url: 'https://other.example/mcp' }); // theirs is kept
      assert.deepEqual(cursor.mcpServers.constella, {
        url: `${constella.url}/mcp`,
        headers: { Authorization: `Bearer ${FAKE_KEY}`, 'X-Constella-Client': 'cursor', 'X-Constella-Tools': 'catalog' },
      });

      // The server saw: the code swapped with its PKCE secret, the key asked for once, the sign-in ended.
      const paths = constella.calls.map((c) => c.path);
      assert.ok(paths.includes('/mcp/oauth/token') && paths.includes('/mcp/oauth/revoke'));
      assert.equal(paths.filter((p) => p === '/mcp/oauth/api-key').length, 1);
      const token = new URLSearchParams(constella.calls.find((c) => c.path === '/mcp/oauth/token').body);
      assert.equal(token.get('code'), 'one_time_code');
      assert.ok(token.get('code_verifier').length >= 43);
      for (const out of [first, second]) assert.ok(!out.stdout.includes(FAKE_KEY) && !out.stderr.includes(FAKE_KEY));
      assert.ok(!constella.calls.some((c) => c.path !== '/platform/v1/me/tools' && `${c.query}${c.body}`.includes(FAKE_KEY)));
    } finally {
      stopHelper(box.home);
      await constella.close();
      removeDir(box.dir);
    }
  });

  test('says plainly when the server cannot hand a key over yet', async () => {
    const box = sandbox();
    const constella = await fakeConstella({ keyRoute: false });
    const env = box.env({ CONSTELLA_API_URL: constella.url });
    try {
      const first = await run(CLI, ['setup', '--wait', '1', '--only', 'cursor'], { env });
      assert.equal(first.code, 3);
      await fetch(first.stdout.match(/^(http\S+\/authorize\?\S+)$/m)[1]);
      const second = await run(CLI, ['setup', '--wait', '5', '--only', 'cursor'], { env });
      assert.equal(second.code, 1);
      assert.match(second.stdout, /^FAIL\s+sign-in\s+This Constella server is too old for one-step setup/m);
      assert.equal(readCredentials(env), null);
    } finally {
      stopHelper(box.home);
      await constella.close();
      removeDir(box.dir);
    }
  });

  test('with CONSTELLA_API_KEY there is no browser step: the key is checked, saved, and the tools set up', async () => {
    const box = sandbox({ tools: ['claude', 'codex'] });
    const constella = await fakeConstella();
    fs.mkdirSync(box.codexHome, { recursive: true });
    const theirs = 'model = "x"\n\n[mcp_servers.other]\nurl = "https://other.example/mcp"\n\n[mcp_servers.constella]\nurl = "https://old.example/mcp"\n\n[mcp_servers.constella.http_headers]\nA = "b"\n\n[projects."/x"]\ntrust_level = "trusted"\n';
    fs.writeFileSync(path.join(box.codexHome, 'config.toml'), theirs, { mode: 0o600 });
    try {
      const res = await run(CLI, ['setup', '--only', 'claude,codex'], { env: box.env({ CONSTELLA_API_URL: constella.url, CONSTELLA_API_KEY: FAKE_KEY }) });
      assert.equal(res.code, 0, res.stdout + res.stderr);
      assert.match(res.stdout, /^ok\s+sign-in\s+signed in, using the key in CONSTELLA_API_KEY/m);
      assert.match(res.stdout, /^ok\s+claude\s+plugin installed; its memory tools, skills and hooks use your saved key/m);
      assert.match(res.stdout, /^ok\s+codex\s+plugin installed; the memory tools use your saved key/m);
      assert.match(res.stdout, /Only you can do this:\n\s+1\. Codex: start Codex, type \/hooks/);
      assert.ok(!res.stdout.includes(FAKE_KEY) && !res.stderr.includes(FAKE_KEY));
      assert.equal(readCredentials(box.env()).api_key, FAKE_KEY);

      const calls = box.calls();
      assert.ok(calls.includes('claude plugin marketplace add Beemo-AI/constella-plugin'));
      assert.ok(calls.includes('claude plugin install constella@constella'));
      assert.ok(calls.includes('codex plugin marketplace add Beemo-AI/constella-plugin'));
      assert.ok(calls.includes('codex plugin add constella@constella'));
      assert.ok(!calls.some((line) => line.includes(FAKE_KEY)), 'the key is never put on a command line');

      const toml = fs.readFileSync(path.join(box.codexHome, 'config.toml'), 'utf8');
      assert.equal(fs.statSync(path.join(box.codexHome, 'config.toml')).mode & 0o777, 0o600);
      assert.ok(toml.startsWith('model = "x"\n\n[mcp_servers.other]\nurl = "https://other.example/mcp"\n'));
      assert.ok(toml.includes('[projects."/x"]\ntrust_level = "trusted"'));
      assert.ok(!toml.includes('old.example') && !toml.includes('A = "b"'));
      assert.equal(toml.match(/\[mcp_servers\.constella\]/g).length, 1);
      assert.ok(toml.includes(`url = "${constella.url}/mcp"`));
      assert.ok(toml.includes(`http_headers = { Authorization = "Bearer ${FAKE_KEY}", "X-Constella-Client" = "codex", "X-Constella-Tools" = "catalog" }`));
    } finally {
      await constella.close();
      removeDir(box.dir);
    }
  });

  test("Codex's settings are put back when Codex cannot read the new entry", async () => {
    const box = sandbox({ tools: ['codex'], codexListFails: true });
    const constella = await fakeConstella();
    fs.mkdirSync(box.codexHome, { recursive: true });
    const theirs = 'model = "x"\n';
    fs.writeFileSync(path.join(box.codexHome, 'config.toml'), theirs);
    try {
      const res = await run(CLI, ['setup', '--only', 'codex'], { env: box.env({ CONSTELLA_API_URL: constella.url, CONSTELLA_API_KEY: FAKE_KEY }) });
      assert.equal(res.code, 1);
      assert.match(res.stdout, /^FAIL\s+codex\s+plugin installed, but Codex did not accept the new server entry/m);
      assert.equal(fs.readFileSync(path.join(box.codexHome, 'config.toml'), 'utf8'), theirs);
    } finally {
      await constella.close();
      removeDir(box.dir);
    }
  });

  test('a key the server refuses is not saved', async () => {
    const box = sandbox();
    const constella = await fakeConstella();
    try {
      const res = await run(CLI, ['setup', '--only', 'cursor'], { env: box.env({ CONSTELLA_API_URL: constella.url, CONSTELLA_API_KEY: 'csk_wrong' }) });
      assert.equal(res.code, 1);
      assert.match(res.stdout, /^FAIL\s+sign-in\s+.*did not accept the key in CONSTELLA_API_KEY/m);
      assert.equal(readCredentials(box.env()), null);
    } finally {
      await constella.close();
      removeDir(box.dir);
    }
  });

  test('logout forgets the saved key', async () => {
    const box = sandbox();
    try {
      writeCredentials({ api_key: FAKE_KEY, api_url: 'https://api.constella.app' }, box.env());
      const res = await run(CLI, ['logout'], { env: box.env() });
      assert.equal(res.code, 0);
      assert.equal(readCredentials(box.env()), null);
    } finally {
      removeDir(box.dir);
    }
  });
});

describe("Codex's config.toml", () => {
  const block = '[mcp_servers.constella]\nurl = "https://api.constella.app/mcp"';

  test('our table is added once, and running again changes nothing', () => {
    const once = withCodexServer('model = "x"\n\n[features]\nhooks = true\n', block);
    assert.ok(once.startsWith('model = "x"\n\n[features]\nhooks = true\n\n# Added by `constella setup`'));
    assert.ok(once.endsWith(`${block}\n`));
    assert.equal(withCodexServer(once, block), once);
  });

  test('an empty file, and look-alike tables, are handled', () => {
    assert.ok(withCodexServer('', block).startsWith('# Added by `constella setup`'));
    const text = '[mcp_servers.constella-canvas]\nurl = "http://127.0.0.1:1/mcp"\n\n[mcp_servers."constella"]\nurl = "old"\n\n[[hooks.x]]\nk = 1\n';
    const out = withCodexServer(text, block);
    assert.ok(out.includes('[mcp_servers.constella-canvas]\nurl = "http://127.0.0.1:1/mcp"'));
    assert.ok(out.includes('[[hooks.x]]\nk = 1'));
    assert.ok(!out.includes('url = "old"'));
  });
});
