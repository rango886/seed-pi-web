import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { modelModules, readModelCatalog } from '../server/models.js';

test('local pi catalog includes OAuth and custom models, computes levels, and rereads changed files', async (t) => {
  try { await modelModules; }
  catch (e) { t.skip(`pi SDK is not installed: ${e.message}`); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-models-'));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    await fs.rm(root, { recursive: true, force: true });
  });
  const put = (name, data) => fs.writeFile(path.join(root, name), JSON.stringify(data));
  await put('auth.json', { anthropic: { type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 3600000 } });
  const config = (id, reasoning) => ({ providers: { 'seed-test': {
    api: 'openai-completions', baseUrl: 'http://localhost:1/v1', apiKey: 'test-only',
    models: [{ id, reasoning, thinkingLevelMap: { minimal: null, xhigh: null, max: 'max' } }],
  } } });
  await put('models.json', config('first', true));
  await put('settings.json', { defaultProvider: 'seed-test', defaultModel: 'first', defaultThinkingLevel: 'high' });
  const first = await readModelCatalog(root);
  assert.ok(first.models.some((m) => m.provider === 'anthropic'), 'OAuth models do not require an API key in models.json');
  assert.deepEqual(first.models.find((m) => m.provider === 'seed-test').thinkingLevels, ['off', 'low', 'medium', 'high', 'max']);
  assert.equal(first.defaults.model.id, 'first');
  assert.equal(first.defaults.thinkingLevel, 'high');

  await put('models.json', config('second', false));
  await put('settings.json', { defaultProvider: 'seed-test', defaultModel: 'second', defaultThinkingLevel: 'high' });
  const second = await readModelCatalog(root);
  assert.ok(!second.models.some((m) => m.provider === 'seed-test' && m.id === 'first'));
  assert.deepEqual(second.models.find((m) => m.provider === 'seed-test').thinkingLevels, ['off']);
  assert.equal(second.defaults.model.id, 'second');
  assert.equal(second.defaults.thinkingLevel, 'off');

  await fs.mkdir(path.join(root, '.pi'));
  await fs.writeFile(path.join(root, '.pi/settings.json'), JSON.stringify({ defaultProvider: 'anthropic', defaultModel: first.models.find((m) => m.provider === 'anthropic').id }));
  assert.equal((await readModelCatalog(root)).defaults.model.provider, 'anthropic', 'project defaults override global defaults');
});
