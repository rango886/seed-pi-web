import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPrefs } from '../server/prefs.js';

test('prefs patch only touched keys, never store the token, and can be replaced wholesale', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-prefs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state', 'prefs.json');
  const prefs = createPrefs(file);
  assert.deepEqual(await prefs.read(), {});
  await Promise.all([
    prefs.patch({ set: { 'seed-pi-web-a': '1', 'seed-pi-web-token': 'secret', other: 'x', 'seed-pi-web-n': 2 } }),
    prefs.patch({ set: { 'seed-pi-web-b': '2' } }),
  ]);
  await prefs.patch({ set: { 'seed-pi-web-c': '3' }, remove: ['seed-pi-web-a'] });
  assert.deepEqual(await createPrefs(file).read(), { 'seed-pi-web-b': '2', 'seed-pi-web-c': '3' });
  await prefs.replace({ 'seed-pi-web-z': 'z' });
  assert.deepEqual(await createPrefs(file).read(), { 'seed-pi-web-z': 'z' });
  assert.throws(() => prefs.replace([]));
});
