// Which git repo and branch a folder is in, and where a file sits inside it.
// Every function here is safe: on any problem it returns an empty value, never throws.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Run one git command in `cwd`. Returns its trimmed stdout, or '' on any error or timeout. */
function git(cwd, args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        ['-C', cwd, ...args],
        {
          timeout: timeoutMs,
          windowsHide: true,
          encoding: 'utf8',
          // Never let git prompt for anything, and never take repo locks.
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        },
        (err, stdout) => resolve(err ? '' : String(stdout || '').trim()),
      );
    } catch {
      resolve('');
    }
  });
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;

/**
 * Turn a git remote (or an `owner/name`, or a folder name) into a short lowercase repo name.
 *   https://github.com/Acme/Widget.git      -> acme/widget
 *   git@github.com:Acme/Widget.git          -> acme/widget
 *   ssh://git@github.com:22/Acme/Widget.git -> acme/widget
 *   https://user:token@host/Acme/Widget     -> acme/widget   (any login in the URL is dropped)
 *   /srv/git/widget.git or file:///x/widget -> widget        (a local path keeps only its folder name)
 *   Widget                                  -> widget
 * Empty in, empty out. It matches what the server stores, so a repo name never differs between tools.
 */
export function normalizeRepo(value) {
  let s = String(value ?? '').trim();
  if (!s) return '';
  let localPath = false;
  if (SCHEME.test(s)) {
    let pathname = '';
    try {
      const url = new URL(s);
      pathname = url.pathname;
      localPath = url.protocol === 'file:';
    } catch {
      pathname = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
    }
    s = pathname;
  } else if (WINDOWS_DRIVE.test(s) || s.startsWith('/') || s.startsWith('.') || s.startsWith('~')) {
    localPath = true;
  } else {
    // scp-like form: [user@]host:owner/name
    const scp = s.match(/^(?:[^@\s/]+@)?[^:\s/]+:(?!\/\/)(.+)$/);
    if (scp) s = scp[1];
  }
  s = s.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (localPath) s = s.split('/').filter(Boolean).pop() || '';
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep as is */
  }
  return s.toLowerCase();
}

/**
 * Find the repo for a folder.
 * Returns { top, repo, branch }:
 *   top    the git top-level folder ('' when not in git)
 *   repo   normalized `origin` remote; else the top-level folder name; else the folder name of `cwd`
 *   branch the current branch ('' when unknown, 'HEAD' when detached)
 * Runs three quick git commands at the same time; each gives up after `timeoutMs`.
 */
export async function detectRepo(cwd, timeoutMs = 800) {
  const dir = cwd || process.cwd();
  const [top, remote, revBranch] = await Promise.all([
    git(dir, ['rev-parse', '--show-toplevel'], timeoutMs),
    git(dir, ['remote', 'get-url', 'origin'], timeoutMs),
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], timeoutMs),
  ]);
  // A brand-new repo with no commit yet has no HEAD to parse; its branch name is still known.
  const branch = revBranch || (top ? await git(dir, ['symbolic-ref', '--short', '-q', 'HEAD'], timeoutMs) : '');
  const repo = normalizeRepo(remote) || normalizeRepo(path.basename(top || '')) || normalizeRepo(path.basename(path.resolve(dir)));
  return { top, repo, branch: top ? branch : '' };
}

/** Real path of `p`, or of its nearest folder that exists (a file being created does not exist yet). */
function realpathNearest(p) {
  let current = p;
  const tail = [];
  for (let i = 0; i < 64; i += 1) {
    try {
      const real = fs.realpathSync(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p;
      tail.push(path.basename(current));
      current = parent;
    }
  }
  return p;
}

/**
 * The repo-relative path of `filePath` with forward slashes, e.g. "src/api/users.ts".
 * Returns null when the file is outside the repo `top`, is the top folder itself, or sits in `.git/`.
 */
export function relativeToRepo(top, filePath, cwd) {
  if (!top || !filePath || typeof filePath !== 'string') return null;
  try {
    const abs = path.resolve(cwd || top, filePath);
    const rel = path.relative(realpathNearest(top), realpathNearest(abs));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const posix = rel.split(path.sep).join('/');
    if (posix === '.git' || posix.startsWith('.git/')) return null;
    return posix;
  } catch {
    return null;
  }
}

/** The folder of a repo-relative path: "src/api/users.ts" -> "src/api", "README.md" -> ".". */
export function folderOf(relPath) {
  const dir = path.posix.dirname(relPath);
  return dir || '.';
}
