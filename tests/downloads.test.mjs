import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import express from 'express';
import { createDirectoryZip, registerDownloads } from '../server/downloads.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-zip-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const put = async (name, content) => { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), content); };
  return { root, put };
}
// Read the ZIP central directory and inflate each member; also verifies Unicode names and payloads.
function members(b) {
  const end = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0);
  let at = b.readUInt32LE(end + 16);
  const count = b.readUInt16LE(end + 10);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(b.readUInt32LE(at), 0x02014b50);
    const nameLength = b.readUInt16LE(at + 28), extraLength = b.readUInt16LE(at + 30), commentLength = b.readUInt16LE(at + 32);
    const name = b.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const local = b.readUInt32LE(at + 42);
    assert.equal(b.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const data = b.subarray(start, start + b.readUInt32LE(at + 20));
    const value = b.readUInt16LE(at + 10) === 8 ? inflateRawSync(data) : data;
    files.set(name, value.toString('utf8'));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

test('ZIP preserves current files, Unicode paths and empty directories; excludes .git, optionally dependencies', async (t) => {
  const f = await fixture(t);
  await f.put('目录/新 文件.txt', '未提交内容\n');
  await f.put('.git/config', 'secret'); await f.put('nested/.git', 'worktree metadata');
  await f.put('node_modules/module/index.js', 'dependency'); await f.put('.env', 'local config');
  await fs.mkdir(path.join(f.root, 'empty'));
  const zip = await createDirectoryZip(f.root);
  t.after(zip.cleanup);
  const entries = members(await fs.readFile(zip.file));
  const top = path.basename(f.root) + '/';
  assert.equal(entries.get(top + '目录/新 文件.txt'), '未提交内容\n');
  assert.equal(entries.get(top + 'node_modules/module/index.js'), 'dependency');
  assert.equal(entries.get(top + '.env'), 'local config');
  assert.ok(entries.has(top + 'empty/'));
  assert.ok(![...entries.keys()].some((s) => s.includes('/.git')));
  const small = await createDirectoryZip(f.root, { omitDependencies: true });
  t.after(small.cleanup);
  assert.ok(![...members(await fs.readFile(small.file)).keys()].some((s) => s.includes('node_modules')));
});

test('ZIP rejects oversized directories and aborts without producing an archive', async (t) => {
  const f = await fixture(t);
  await f.put('sparse.bin', '');
  await fs.truncate(path.join(f.root, 'sparse.bin'), 1024 * 1024 * 1024 + 1);
  await assert.rejects(() => createDirectoryZip(f.root), /1GB/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => createDirectoryZip(f.root, { signal: controller.signal }), /abort/i);
});

test('ZIP skips symbolic links or Windows junctions, never traverses outside', async (t) => {
  const f = await fixture(t);
  const outside = await fixture(t);
  await outside.put('outside.txt', 'must not be archived');
  try { await fs.symlink(outside.root, path.join(f.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (e.code === 'EPERM') return t.skip('symlink permission unavailable'); throw e; }
  const zip = await createDirectoryZip(f.root);
  t.after(zip.cleanup);
  assert.equal(zip.skippedLinks, 1);
  assert.ok(![...members(await fs.readFile(zip.file)).keys()].some((s) => s.includes('outside')));
});

test('archive HTTP prepare and one-time download work behind authentication', async (t) => {
  const f = await fixture(t); await f.put('file.txt', 'download me');
  const app = express();
  app.use((req, res, next) => req.headers['x-test-token'] === 'test' ? next() : res.sendStatus(403));
  app.use(express.json());
  registerDownloads(app, (fn) => (req, res) => fn(req, res).catch((e) => { if (!res.destroyed) res.status(400).json({ error: e.message }); }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/fs/archive`;
  assert.equal((await fetch(url, { method: 'POST' })).status, 403);
  const headers = { 'x-test-token': 'test', 'content-type': 'application/json' };
  const prepared = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ path: f.root }) });
  assert.equal(prepared.status, 200);
  const d = await prepared.json();
  assert.equal((await fetch(url + '/' + d.id)).status, 403);
  const res = await fetch(url + '/' + d.id, { headers });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-disposition'), /attachment/);
  const entries = members(Buffer.from(await res.arrayBuffer()));
  assert.equal(entries.get(path.basename(f.root) + '/file.txt'), 'download me');
  assert.equal((await fetch(url + '/' + d.id, { headers })).status, 404);
});
