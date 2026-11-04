import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { archiveKey, createSessionArchive, registerSessionArchive } from '../server/session-archive.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-session-archive-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { root, file: path.join(root, 'state', 'archive.json') };
}

test('archive persists across restarts, serializes concurrent updates, and leaves session files unchanged', async (t) => {
  const { root, file } = await fixture(t);
  const first = path.join(root, 'sessions', 'first.jsonl');
  const second = path.join(root, 'sessions', 'second.jsonl');
  await fs.mkdir(path.dirname(first));
  const contents = '{"type":"session","cwd":"/repo"}\n';
  await fs.writeFile(first, contents);
  const before = await fs.stat(first);
  const archive = createSessionArchive(file);
  assert.equal((await archive.read()).size, 0);
  await Promise.all([archive.set(first, true), archive.set(second, true), archive.set(first, false), archive.set(first, true)]);
  assert.deepEqual([...(await createSessionArchive(file).read())].sort(), [archiveKey(first), archiveKey(second)].sort());
  assert.equal(await fs.readFile(first, 'utf8'), contents);
  assert.equal((await fs.stat(first)).mtimeMs, before.mtimeMs);
  const snapshot = await archive.read();
  snapshot.clear();
  assert.equal((await archive.read()).size, 2, 'callers cannot mutate saved state');
  await archive.set(first, false);
  assert.deepEqual([...(await createSessionArchive(file).read())], [archiveKey(second)]);
  await assert.rejects(fs.stat(file + '.tmp'), { code: 'ENOENT' });
});

test('failed writes do not change memory or disk, and the write queue recovers', async (t) => {
  const { root, file } = await fixture(t);
  const a = path.join(root, 'a.jsonl'), b = path.join(root, 'b.jsonl');
  const archive = createSessionArchive(file);
  await archive.set(a, true);
  const previous = await fs.readFile(file, 'utf8');
  await fs.mkdir(file + '.tmp');
  await assert.rejects(archive.set(b, true));
  assert.equal((await archive.read()).has(archiveKey(b)), false);
  assert.equal(await fs.readFile(file, 'utf8'), previous);
  await fs.rm(file + '.tmp', { recursive: true });
  await archive.set(b, true);
  assert.equal((await archive.read()).has(archiveKey(b)), true);
});

test('invalid archive metadata fails visibly rather than silently overwriting records', async (t) => {
  const { root, file } = await fixture(t);
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file, '{broken');
  const archive = createSessionArchive(file);
  await assert.rejects(archive.read());
  await assert.rejects(archive.set(path.join(root, 'a.jsonl'), true));
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});

test('archive HTTP validates requests, handles restore, and notifies other clients after saving', async (t) => {
  const { root, file } = await fixture(t);
  const sessions = path.join(root, 'sessions');
  await fs.mkdir(sessions);
  const session = path.join(sessions, 'chat.jsonl');
  await fs.writeFile(session, 'session content');
  const archive = createSessionArchive(file);
  const changes = [];
  const app = express();
  app.use((req, res, next) => req.headers['x-test-token'] === 'test' ? next() : res.sendStatus(403));
  app.use(express.json());
  registerSessionArchive(app, (fn) => (req, res) => fn(req, res).catch((e) => res.status(400).json({ error: e.message })), {
    archive, roots: async () => [sessions], changed: (change) => changes.push(change),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/sessions/archive`;
  const post = (body, auth = true) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { 'x-test-token': 'test' } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post({ file: session, archived: true }, false)).status, 403);
  for (const body of [
    { file: session, archived: 'false' }, { file: session }, {},
    { file: path.join(root, 'outside.jsonl'), archived: true },
    { file: path.join(sessions, '..', 'escape.jsonl'), archived: true },
    { file: path.join(sessions, 'missing.jsonl'), archived: true },
    { file: path.join(sessions, 'not-session.txt'), archived: true },
    { file: 'relative.jsonl', archived: true },
  ]) assert.equal((await post(body)).status, 400);
  assert.equal(changes.length, 0);
  const result = await post({ file: session, archived: true });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).archived, true);
  assert.equal((await createSessionArchive(file).read()).has(archiveKey(session)), true);
  assert.deepEqual(changes, [{ file: session, archived: true }]);
  assert.equal((await post({ file: session, archived: false })).status, 200);
  assert.equal((await archive.read()).size, 0);
  assert.equal(changes[1].archived, false);
  assert.equal(await fs.readFile(session, 'utf8'), 'session content');
});
