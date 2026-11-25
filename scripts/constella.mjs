#!/usr/bin/env node
// A tiny Constella memory command for shells and cloud agents (no npm packages, Node 18+).
// It needs one secret, CONSTELLA_API_KEY, and talks HTTPS to the Constella API. It prints JSON.
//
//   constella where                                   repo, branch and the ready-made handoff id (no key needed)
//   constella doctor                                  setup check: one ok / FAIL / skip line each for node, repo, key, api
//   constella recall  [--repo r] [--query q] [--files a,b] [--limit n]
//   constella add     --text "..." [--kind k] [--id i] [--repo r] [--path p] [--replaces id] [--to me] [--title t]
//   constella handoff --text "..." [--repo r] [--branch b] [--replaces id] [--to me]
//   common: [--client name]  (default "agents"; sent as X-Constella-Client)
//
// With no --repo, the repo is read from git in the current folder (origin remote, else folder name).
// Exit codes: 0 ok, 1 the call failed (or a doctor check failed), 2 wrong usage or no key. The key is never printed.

import { apiBase, apiKey, callTool, saveTo } from './lib/api.mjs';
import { handoffId } from './lib/format.mjs';
import { detectRepo, normalizeRepo } from './lib/repo.mjs';

process.emitWarning = () => {};

const USAGE = `Constella memory from the command line.

  constella where   (prints this folder's repo, branch and handoff id; needs no key)
  constella doctor  (checks the setup: node, repo, key, api; plain lines, not JSON; exit 1 if one fails)
  constella recall  [--repo owner/name] [--query "..."] [--files a.ts,b.ts] [--limit 8]
  constella add     --text "..." [--kind rule|decision|lesson|fact|todo|question] [--id slug]
                    [--repo owner/name] [--path src/x.ts] [--replaces <id>] [--to me] [--title "..."]
  constella handoff --text "Goal: ... Done: ... Next: ... Open questions: ... Branch and key files: ..."
                    [--repo owner/name] [--branch name] [--replaces <id>] [--to me]

Options for all: --client <name> (default "agents"), --help.
Ids may only use letters, digits and . _ : @ - (at most 128 characters).
Needs CONSTELLA_API_KEY (from the Constella desktop app: Settings > Developer).
CONSTELLA_API_URL changes the server (default https://api.constella.app).
`;

const FLAGS = new Set(['repo', 'branch', 'query', 'files', 'limit', 'text', 'kind', 'id', 'path', 'replaces', 'to', 'title', 'client']);

/** Split argv into a command and --flag values. Unknown flags are an error, so typos are not silently dropped. */
function parseArgs(argv) {
  const out = { command: '', flags: {}, help: false, error: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = arg.slice(2, eq > 0 ? eq : undefined);
      if (!FLAGS.has(name)) {
        out.error = `unknown option --${name}`;
        return out;
      }
      if (eq > 0) {
        out.flags[name] = arg.slice(eq + 1);
      } else if (i + 1 < argv.length) {
        out.flags[name] = argv[(i += 1)];
      } else {
        out.error = `--${name} needs a value`;
        return out;
      }
    } else if (!out.command) {
      out.command = arg;
    } else {
      out.error = `unexpected argument "${arg}"`;
      return out;
    }
  }
  return out;
}

/** "a.ts, b.ts" -> ["a.ts", "b.ts"]. */
function list(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The repo to use (--repo, normalized, else the git repo of this folder), the branch, and the handoff id. */
async function repoInfo(flags) {
  const found = await detectRepo(process.cwd(), 2000);
  const repo = flags.repo ? normalizeRepo(flags.repo) : found.top ? found.repo : '';
  const branch = flags.branch || found.branch || '';
  return { repo, branch, handoff_id: repo ? handoffId(repo, branch) : '' };
}

/**
 * Turn a parsed command into the tool name and arguments to send.
 * Returns { name, args } or { error }.
 */
async function buildCall(parsed, env = process.env) {
  const { command, flags } = parsed;
  const to = flags.to || saveTo(env);
  if (command === 'recall') {
    const { repo } = await repoInfo(flags);
    const args = {};
    if (repo) args.repo = repo;
    if (flags.query) args.query = flags.query;
    if (flags.files) args.files = list(flags.files);
    if (flags.limit) args.limit = Math.max(1, Math.min(50, Number(flags.limit) || 8));
    return { name: 'memory_recall', args };
  }
  if (command === 'add' || command === 'handoff') {
    if (!flags.text || !flags.text.trim()) return { error: '--text is required' };
    const info = await repoInfo(flags);
    const args = { text: flags.text, to };
    if (command === 'handoff') {
      if (!info.repo) return { error: 'no repo found here; pass --repo owner/name' };
      args.kind = 'handoff';
      args.id = info.handoff_id;
      args.places = [{ repo: info.repo }];
    } else {
      if (flags.kind) args.kind = flags.kind;
      if (flags.id) args.id = flags.id;
      if (flags.title) args.title = flags.title;
      if (info.repo) args.places = [flags.path ? { repo: info.repo, path: flags.path } : { repo: info.repo }];
      else if (flags.path) return { error: '--path needs a repo; pass --repo owner/name' };
    }
    if (flags.replaces) args.replaces = flags.replaces;
    return { name: 'memory_add', args };
  }
  return { error: command ? `unknown command "${command}"` : 'no command given' };
}

/**
 * The setup check: one line per check, "ok", "FAIL" or "skip", then what was found and how to fix it.
 * It makes one small recall to prove the key works. The key itself is never printed.
 * Returns the exit code: 0 when nothing failed, 1 otherwise.
 */
async function doctor(flags, env = process.env) {
  const lines = [];
  const say = (state, name, text) => lines.push(`${state.padEnd(5)} ${name.padEnd(5)} ${text}`);

  const major = Number(process.versions.node.split('.')[0]);
  say(major >= 18 ? 'ok' : 'FAIL', 'node', major >= 18 ? `v${process.versions.node}` : `v${process.versions.node} is too old; Node 18 or newer is needed`);

  const found = await detectRepo(process.cwd(), 2000);
  const repo = flags.repo ? normalizeRepo(flags.repo) : found.top ? found.repo : '';
  if (repo) say('ok', 'repo', `${repo}${found.branch ? ` (branch ${found.branch})` : ''}`);
  else say('FAIL', 'repo', 'this folder is not inside a git repo; run this inside your project, or pass --repo owner/name');

  const key = apiKey(env);
  const base = apiBase(env);
  if (!key) {
    say('FAIL', 'key', 'CONSTELLA_API_KEY is not set here; make a key in the Constella desktop app (Settings > Developer) and export it in your shell profile');
    say('skip', 'api', `${base} was not called, because there is no key`);
  } else {
    say('ok', 'key', 'a key is set (not shown)');
    const args = { limit: 1 };
    if (repo) args.repo = repo;
    const res = await callTool({ base, key, client: flags.client || 'agents', name: 'memory_recall', args, timeoutMs: 10000 });
    if (res.ok) say('ok', 'api', `${base} answered; the key works`);
    else if (res.status === 401 || res.status === 403) say('FAIL', 'api', `${base} did not accept the key (${res.status}); make a new one in Settings > Developer`);
    else if (res.status) say('FAIL', 'api', `${base} answered ${res.status}${res.message ? `: ${res.message}` : ''}`);
    else say('FAIL', 'api', `${base} could not be reached (${res.error || 'network error'}); a sandbox with no network also causes this`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  return lines.some((line) => line.startsWith('FAIL')) ? 1 : 0;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help || (!parsed.command && !parsed.error)) {
    process.stdout.write(USAGE);
    return parsed.help ? 0 : 2;
  }
  if (parsed.error) {
    print({ ok: false, error: parsed.error });
    return 2;
  }
  if (parsed.command === 'where') {
    print(await repoInfo(parsed.flags));
    return 0;
  }
  if (parsed.command === 'doctor') return doctor(parsed.flags);
  const key = apiKey();
  if (!key) {
    print({ ok: false, error: 'CONSTELLA_API_KEY is not set. Make a key in the Constella desktop app: Settings > Developer.' });
    return 2;
  }
  const call = await buildCall(parsed);
  if (call.error) {
    print({ ok: false, error: call.error });
    return 2;
  }
  const res = await callTool({
    base: apiBase(),
    key,
    client: parsed.flags.client || 'agents',
    name: call.name,
    args: call.args,
    timeoutMs: 30000,
  });
  if (res.ok) {
    print(res.result ?? null);
    return 0;
  }
  print({ ok: false, status: res.status, code: res.code, error: res.message || res.error || 'request failed' });
  return 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    print({ ok: false, error: 'unexpected error' });
    process.exitCode = 1;
  },
);
