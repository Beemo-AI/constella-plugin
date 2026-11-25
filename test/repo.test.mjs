import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { detectRepo, folderOf, normalizeRepo, relativeToRepo } from '../scripts/lib/repo.mjs';
import { makeRepo, removeDir, tempDir } from './helpers.mjs';

const cleanup = [];
after(() => cleanup.forEach(removeDir));

// detectRepo runs git in a child process; keep the user's global git settings out of it.
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';

describe('normalizeRepo', () => {
  const cases = [
    ['https://github.com/Acme/Widget.git', 'acme/widget'],
    ['https://github.com/Acme/Widget', 'acme/widget'],
    ['https://github.com/Acme/Widget/', 'acme/widget'],
    ['git@github.com:Acme/Widget.git', 'acme/widget'],
    ['ssh://git@github.com:22/Acme/Widget.git', 'acme/widget'],
    ['ssh://git@github.com/Acme/Widget', 'acme/widget'],
    ['https://user:ghp_TOKEN123@github.com/Acme/Widget.git', 'acme/widget'],
    ['https://oauth2:glpat-abc@gitlab.com/Group/Sub/Proj.git', 'group/sub/proj'],
    ['git://example.com/acme/widget.git', 'acme/widget'],
    ['Acme/Widget', 'acme/widget'],
    ['acme/widget.git', 'acme/widget'],
    ['/srv/git/Widget.git', 'widget'],
    ['file:///srv/git/widget', 'widget'],
    ['../widget', 'widget'],
    ['Widget', 'widget'],
    ['  ', ''],
    ['', ''],
    [undefined, ''],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      assert.equal(normalizeRepo(input), expected);
    });
  }

  test('a login or token in the URL never survives', () => {
    for (const url of ['https://me:s3cr3t@github.com/a/b.git', 'https://s3cr3t@github.com/a/b']) {
      assert.ok(!normalizeRepo(url).includes('s3cr3t'));
    }
  });
});

describe('detectRepo', () => {
  test('an https remote', async () => {
    const repo = makeRepo({ remote: 'https://github.com/Acme/Widget.git', branch: 'feat/x' });
    cleanup.push(repo.parent);
    const info = await detectRepo(repo.dir);
    assert.equal(info.repo, 'acme/widget');
    assert.equal(info.branch, 'feat/x');
    assert.equal(info.top, repo.dir);
  });

  test('an ssh remote, from a sub-folder', async () => {
    const repo = makeRepo({ remote: 'git@github.com:Acme/Gadget.git' });
    cleanup.push(repo.parent);
    const sub = path.join(repo.dir, 'src', 'api');
    fs.mkdirSync(sub, { recursive: true });
    const info = await detectRepo(sub);
    assert.equal(info.repo, 'acme/gadget');
    assert.equal(info.branch, 'main');
    assert.equal(info.top, repo.dir);
  });

  test('a repo with no remote uses the top folder name', async () => {
    const repo = makeRepo({ name: 'My-Tool' });
    cleanup.push(repo.parent);
    fs.mkdirSync(path.join(repo.dir, 'lib'));
    const info = await detectRepo(path.join(repo.dir, 'lib'));
    assert.equal(info.repo, 'my-tool');
    assert.equal(info.branch, 'main');
  });

  test('outside git uses the folder name and no branch', async () => {
    const dir = path.join(tempDir(), 'Loose-Folder');
    cleanup.push(path.dirname(dir));
    fs.mkdirSync(dir);
    const info = await detectRepo(dir);
    assert.equal(info.top, '');
    assert.equal(info.repo, 'loose-folder');
    assert.equal(info.branch, '');
  });

  test('a folder that does not exist does not throw', async () => {
    const info = await detectRepo('/no/such/folder/anywhere');
    assert.equal(info.top, '');
    assert.equal(info.repo, 'anywhere');
  });
});

describe('relativeToRepo', () => {
  test('inside, outside, the top itself and .git', () => {
    const repo = makeRepo();
    cleanup.push(repo.parent);
    assert.equal(relativeToRepo(repo.dir, path.join(repo.dir, 'src', 'a.ts')), 'src/a.ts');
    assert.equal(relativeToRepo(repo.dir, 'src/b.ts', repo.dir), 'src/b.ts');
    assert.equal(relativeToRepo(repo.dir, path.join(repo.parent, 'other.ts')), null);
    assert.equal(relativeToRepo(repo.dir, '/etc/hosts'), null);
    assert.equal(relativeToRepo(repo.dir, repo.dir), null);
    assert.equal(relativeToRepo(repo.dir, path.join(repo.dir, '.git', 'config')), null);
    assert.equal(relativeToRepo('', 'a.ts'), null);
  });

  test('folderOf', () => {
    assert.equal(folderOf('src/api/users.ts'), 'src/api');
    assert.equal(folderOf('README.md'), '.');
  });
});
