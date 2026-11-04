// Run: node --test tests/git.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitStatus, gitDiff, parseStatus } from '../server/git.js';

const exec = promisify(execFile);
async function repo(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-git-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const git = async (...args) => (await exec('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd: root, windowsHide: true })).stdout;
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.invalid');
  const put = async (name, content) => { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), content); };
  const commit = async () => { await git('add', '-A'); await git('commit', '-m', 'fixture'); };
  return { root, git, put, commit, diff: (p, mode) => gitDiff(root, path.join(root, p), mode) };
}
const lines = (d) => d.hunks.flatMap((h) => h.lines);

test('porcelain v2 parser preserves spaces, newlines, renames, conflicts and all codes', () => {
  const d = parseStatus([
    '# branch.oid abc123', '# branch.head feature', '# branch.ab +2 -3',
    '1 MM N... 100644 100644 100644 a b 文件 name.txt',
    '2 R. N... 100644 100644 100644 a b R100 renamed\nfile.txt', 'old name.txt',
    '2 C. N... 100644 100644 100644 a b C100 copy.txt', 'source.txt',
    '1 .T N... 100644 100644 120000 a b type.txt',
    'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
    '? new\n file.txt', '! ignored dir/', '',
  ].join('\0'));
  assert.equal(d.branch, 'feature');
  assert.equal(d.ahead, 2); assert.equal(d.behind, 3);
  assert.equal(d.entries[0].path, '文件 name.txt');
  assert.equal(d.entries[0].x, 'M'); assert.equal(d.entries[0].y, 'M');
  assert.equal(d.entries[1].oldPath, 'old name.txt');
  assert.equal(d.entries[1].path, 'renamed\nfile.txt');
  assert.deepEqual(d.entries.map((e) => e.status), ['M', 'R', 'C', 'T', '!', 'U']);
  assert.equal(d.entries[4].conflict, true);
  assert.deepEqual(d.ignored, ['ignored dir']);
});

test('status and diff separate HEAD, index and disk; include deletion, rename, ignored and untracked', async (t) => {
  const r = await repo(t);
  await r.put('dir/same.txt', 'base\n'); await r.put('delete.txt', 'gone\n');
  await r.put('rename 中文.txt', 'rename content\n'); await r.put('staged-delete.txt', 'old\n');
  await r.put('.gitignore', 'ignored/\n'); await r.commit();
  await r.put('dir/same.txt', 'staged\n'); await r.git('add', '--', 'dir/same.txt');
  await r.put('dir/same.txt', 'working\n');
  await fs.unlink(path.join(r.root, 'delete.txt'));
  await r.git('rm', '--', 'staged-delete.txt');
  await r.git('mv', '--', 'rename 中文.txt', 'renamed 中文.txt');
  await r.put('新 文件 [x].txt', 'brand new\n'); await r.put('ignored/file.txt', 'ignored\n');
  const d = await gitStatus(path.join(r.root, 'dir'), true);
  assert.equal(d.available, true); assert.equal(d.branch, 'main');
  assert.equal(path.resolve(d.root), r.root);
  const e = d.entries.find((e) => e.path === 'dir/same.txt');
  assert.equal(e.x + e.y, 'MM');
  assert.equal(d.entries.find((e) => e.path === 'delete.txt').y, 'D');
  assert.equal(d.entries.find((e) => e.path === 'renamed 中文.txt').oldPath, 'rename 中文.txt');
  assert.ok(d.ignored.includes('ignored'));
  assert.ok(lines(await r.diff('dir/same.txt', 'staged')).includes('+staged'));
  assert.ok(lines(await r.diff('dir/same.txt', 'working')).includes('-staged'));
  assert.ok(lines(await r.diff('dir/same.txt', 'working')).includes('+working'));
  assert.ok(lines(await r.diff('dir/same.txt', 'head')).includes('-base'));
  assert.ok(lines(await r.diff('delete.txt', 'working')).includes('-gone'));
  assert.ok(lines(await r.diff('staged-delete.txt', 'staged')).includes('-old'));
  assert.equal((await r.diff('renamed 中文.txt', 'staged')).hunks.length, 0);
  assert.ok(lines(await r.diff('新 文件 [x].txt', 'working')).includes('+brand new'));
  await assert.rejects(() => gitDiff(r.root, path.join(r.root, '..', 'outside.txt')), /不在当前仓库/);
  await assert.rejects(() => r.diff('.git/config', 'head'), /内部文件/);
  await assert.rejects(() => r.diff('dir/same.txt', 'bad'), /无效/);
  await fs.rm(path.join(r.root, 'dir'), { recursive: true });
  await r.put('dir', 'directory replaced by a file\n');
  assert.ok(lines(await r.diff('dir/same.txt', 'working')).includes('-staged'));
});

test('initial commits, literal dash/bracket names and staged additions work', async (t) => {
  const r = await repo(t);
  await r.put('-[new] 中文.txt', 'new\n');
  assert.ok(lines(await r.diff('-[new] 中文.txt', 'head')).includes('+new'));
  await r.git('add', '--', '-[new] 中文.txt');
  assert.equal((await gitStatus(r.root, true)).oid, '(initial)');
  assert.ok(lines(await r.diff('-[new] 中文.txt', 'staged')).includes('+new'));
  assert.equal((await r.diff('-[new] 中文.txt', 'working')).hunks.length, 0);
});

test('binary, large files, CRLF and pure mode changes do not create misleading text diffs', async (t) => {
  const r = await repo(t);
  await r.put('text.txt', 'line\n'); await r.put('binary.bin', Buffer.from([1, 0, 2])); await r.commit();
  await r.put('text.txt', 'line\r\n');
  assert.equal((await r.diff('text.txt', 'head')).hunks.length, 0);
  await r.put('binary.bin', Buffer.from([1, 0, 3]));
  assert.match((await r.diff('binary.bin')).message, /二进制/);
  await r.put('large.txt', 'a'.repeat(2 * 1024 * 1024 + 1));
  assert.match((await r.diff('large.txt')).message, /2MB/);
  await r.git('update-index', '--chmod=+x', '--', 'text.txt');
  assert.equal((await r.diff('text.txt', 'staged')).hunks.length, 0);
});

test('merge conflict compares ours with disk and is explicitly labelled', async (t) => {
  const r = await repo(t);
  await r.put('conflict.txt', 'base\n'); await r.commit();
  await r.git('checkout', '-b', 'other'); await r.put('conflict.txt', 'theirs\n'); await r.commit();
  await r.git('checkout', 'main'); await r.put('conflict.txt', 'ours\n'); await r.commit();
  await assert.rejects(() => r.git('merge', 'other'));
  const d = await gitStatus(r.root, true);
  assert.equal(d.entries[0].conflict, true);
  const diff = await r.diff('conflict.txt');
  assert.equal(diff.conflict, true); assert.match(diff.oldLabel, /ours/);
  assert.ok(lines(diff).some((s) => s.includes('<<<<<<<')));
  assert.match((await r.diff('conflict.txt', 'staged')).message, /冲突/);
});

test('submodule changes are reported without treating a directory as a text file', async (t) => {
  const parent = await repo(t), child = await repo(t);
  await child.put('child.txt', 'base\n'); await child.commit();
  await parent.git('-c', 'protocol.file.allow=always', 'submodule', 'add', child.root, 'sub');
  await parent.commit();
  await fs.writeFile(path.join(parent.root, 'sub', 'child.txt'), 'changed\n');
  await fs.writeFile(path.join(parent.root, 'sub', 'new.txt'), 'new\n');
  const entry = (await gitStatus(parent.root, true)).entries.find((e) => e.path === 'sub');
  assert.ok(entry.sub.startsWith('S')); assert.equal(entry.status, 'M');
  assert.match((await parent.diff('sub')).message, /子模块/);
});

test('Git diff will not follow a symlink directory outside the repository', async (t) => {
  const r = await repo(t), outside = await repo(t);
  await r.put('a.txt', 'base\n'); await r.commit();
  await outside.put('outside.txt', 'private\n');
  try { await fs.symlink(outside.root, path.join(r.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (e.code === 'EPERM') return t.skip('symlink permission unavailable'); throw e; }
  // A new path has no index blob, but must still not be read through the link.
  await assert.rejects(() => r.diff('link/outside.txt'), /符号链接|not exist|not in the index|invalid object|outside repository|beyond a symbolic link/i);
});

test('worktrees and detached HEAD are discovered, non-repositories degrade gracefully', async (t) => {
  const r = await repo(t);
  await r.put('a.txt', 'a\n'); await r.commit();
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-worktree-test-'));
  t.after(() => fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await r.git('worktree', 'add', '--detach', work, 'HEAD');
  await fs.writeFile(path.join(work, 'a.txt'), 'b\n');
  const d = await gitStatus(work, true);
  assert.match(d.branch, /分离 HEAD/); assert.equal(d.entries[0].status, 'M');
  assert.ok(lines(await gitDiff(work, path.join(work, 'a.txt'))).includes('+b'));
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-plain-test-'));
  t.after(() => fs.rm(plain, { recursive: true, force: true }));
  assert.equal((await gitStatus(plain, true)).available, false);
});
