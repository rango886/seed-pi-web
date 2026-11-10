import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanFavorites, createFavorites } from '../server/favorites.js';
import { archiveKey, createSessionArchive } from '../server/session-archive.js';

async function tmp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-favorites-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('favorites persist in order and dedupe paths', async (t) => {
  const root = await tmp(t);
  const file = path.join(root, 'state', 'favorites.json');
  const fav = createFavorites(file);
  assert.deepEqual(await fav.read(), []);
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  await Promise.all([fav.write([a]), fav.write([b, a, a + path.sep, '', 3])]);
  assert.deepEqual(await createFavorites(file).read(), [b, a]);
  assert.throws(() => cleanFavorites('nope'));
});

test('archive / star marks can be replaced wholesale for backup import', async (t) => {
  const root = await tmp(t);
  const file = path.join(root, 'archive.json');
  const marks = createSessionArchive(file);
  const x = path.join(root, 'x.jsonl'), y = path.join(root, 'y.jsonl');
  await marks.set(x, true);
  await marks.replace([y]);
  assert.deepEqual([...(await createSessionArchive(file).read())], [archiveKey(y)]);
});
