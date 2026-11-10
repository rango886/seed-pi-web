import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// HOME_DIR 在导入 config.js 时就定下来了，所以先设环境变量再动态导入
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-temp-dirs-'));
process.env.SEED_PI_WEB_HOME = home;
const { createTempDir, cleanupTempDirs, resolveTempRoot, tempDirName } = await import('../server/temp-dirs.js');
test.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const old = async (dir) => {
  const t = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  await fs.utimes(dir, t, t);
};

test('placeholders expand and folder names stay a single safe segment', () => {
  assert.equal(resolveTempRoot('{data}/temp'), path.join(home, 'temp'));
  assert.equal(resolveTempRoot(''), path.join(home, 'temp'));
  assert.equal(tempDirName('{date}_{time}', new Date(2025, 0, 2, 3, 4, 5)), '2025-01-02_030405');
  assert.equal(tempDirName('a/b:c?'), 'a_b_c_');
  assert.match(tempDirName('x-{rand}'), /^x-[a-z0-9]{4}$/);
  assert.match(tempDirName('...'), /^\d{4}-\d\d-\d\d_\d{6}$/);
});

test('creates unique folders and only cleans stale, empty, unused ones it created', async () => {
  const root = path.join(home, 'roots');
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => createTempDir({ root, name: 'same' })));
  assert.deepEqual([a, b, c].map((p) => path.basename(p)).sort(), ['same', 'same-1', 'same-2']);

  const fresh = await createTempDir({ root, name: 'fresh' });
  const used = await createTempDir({ root, name: 'used' });
  const full = await createTempDir({ root, name: 'full' });
  const foreign = path.join(root, 'foreign'); // 不是我们建的，永远不碰
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(full, 'x.txt'), 'x');
  for (const d of [a, b, c, used, full, foreign]) await old(d);
  await fs.rm(c, { recursive: true });

  const removed = await cleanupTempDirs(async (d) => d === used);
  assert.deepEqual(removed.sort(), [a, b].sort());
  for (const d of [fresh, used, full, foreign]) assert.ok((await fs.stat(d)).isDirectory());
  const registry = JSON.parse(await fs.readFile(path.join(home, 'temp-dirs.json'), 'utf8'));
  assert.deepEqual(registry.sort(), [fresh, used, full].sort());
});
