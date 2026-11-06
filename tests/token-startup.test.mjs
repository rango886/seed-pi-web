import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const configUrl = new URL('../server/config.js', import.meta.url).href;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-web-token-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, SEED_PI_WEB_HOME: dir, SEED_PI_WEB_TOKEN: '', HOST: '127.0.0.1', PI_CODING_AGENT_DIR: path.join(dir, 'pi') };
  const file = path.join(dir, 'config.json');
  const read = async () => JSON.parse(await fs.readFile(file, 'utf8'));
  const run = async (code, overrides = {}) => JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', `import * as c from ${JSON.stringify(configUrl)}; ${code}`], { cwd: root, env: { ...env, ...overrides }, windowsHide: true })).stdout);
  const cli = async (...args) => (await exec(process.execPath, ['bin/seed-pi-web.js', ...args], { cwd: root, env, windowsHide: true, timeout: 25000 })).stdout;
  return { dir, env, file, read, run, cli };
}

async function freePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitUntil(fn) {
  for (let i = 0; i < 150; i++) {
    const result = await fn();
    if (result) return result;
    await delay(50);
  }
  throw new Error('startup timed out');
}

function websocketStatus(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('error', reject);
    ws.once('open', () => { ws.close(); resolve(101); });
    ws.once('unexpected-response', (req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
  });
}

async function checkAuth(url, token) {
  const headers = { 'x-seed-pi-web-token': token };
  assert.equal((await fetch(url + '/api/ping')).status, 403, 'loopback still requires a token');
  assert.equal((await fetch(url + '/api/ping?token=wrong')).status, 403);
  assert.equal((await fetch(url + '/api/ping', { headers })).status, 200);
  assert.equal((await fetch(url + '/api/ping?token=' + encodeURIComponent(token))).status, 200);
  assert.equal((await fetch(url + '/api/ping', { headers: { ...headers, origin: 'http://evil.invalid' } })).status, 403);
  const wsUrl = url.replace(/^http/, 'ws') + '/ws';
  assert.equal(await websocketStatus(wsUrl), 403);
  assert.equal(await websocketStatus(wsUrl + '?token=wrong'), 403);
  assert.equal(await websocketStatus(wsUrl + '?token=' + encodeURIComponent(token)), 101);
}

test('startup initializes a persistent random token without changing other configuration; reads stay side-effect free', async t => {
  const f = await fixture(t);
  assert.equal(await f.run('console.log(JSON.stringify(c.loadConfig({}).token))'), '');
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  await fs.writeFile(f.file, JSON.stringify({ port: 9123, idleMinutes: 17, custom: 'keep', token: '' }));
  const first = await f.run('console.log(JSON.stringify(c.ensureToken(c.loadConfig({}))))');
  assert.match(first.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(first.port, 9123);
  assert.deepEqual(await f.read(), { port: 9123, idleMinutes: 17, custom: 'keep', token: first.token });
  const next = await f.run('const cfg = c.ensureToken(c.loadConfig({})); console.log(JSON.stringify(c.applyToEnv(cfg, {})))');
  assert.equal(next.SEED_PI_WEB_TOKEN, first.token, 'a separate process reuses the saved token');
  assert.equal(next.PORT, '9123');
  await f.cli('token', 'clear');
  const second = await f.run('console.log(JSON.stringify(c.ensureToken(c.loadConfig({})).token))');
  assert.match(second, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(second, first.token);
  assert.equal((await f.read()).custom, 'keep');
});

test('configured, environment and command-line tokens are preserved and do not overwrite saved settings', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, JSON.stringify({ token: 'saved-token', port: 9123 }));
  const original = await fs.readFile(f.file, 'utf8');
  assert.equal(await f.run('console.log(JSON.stringify(c.ensureToken(c.loadConfig({})).token))'), 'saved-token');
  assert.equal(await f.run('console.log(JSON.stringify(c.ensureToken(c.loadConfig()).token))', { SEED_PI_WEB_TOKEN: 'environment-token' }), 'environment-token');
  assert.equal(await f.run('console.log(JSON.stringify(c.ensureToken({ ...c.loadConfig(), token: "cli-token" }).token))'), 'cli-token');
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
  await fs.rm(f.file);
  assert.equal(await f.run('console.log(JSON.stringify(c.ensureToken(c.loadConfig()).token))', { SEED_PI_WEB_TOKEN: 'environment-token' }), 'environment-token');
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});

test('background CLI initializes one token and reuses it for startup probes, status and restart', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  f.env.PORT = String(await freePort());
  const url = `http://127.0.0.1:${f.env.PORT}`;
  try {
    const output = await f.cli('start');
    const { token } = await f.read();
    assert.match(token, /^[A-Za-z0-9_-]{32}$/);
    assert.ok(output.includes(url + '/?token=' + token));
    await checkAuth(url, token);
    assert.equal((await f.cli('token')).trim(), token);
    assert.ok((await f.cli('status')).includes(url + '/?token=' + token));
    assert.match(await f.cli('start'), /已经在运行了/);
    assert.equal((await f.read()).token, token);
    assert.ok((await f.cli('restart')).includes(url + '/?token=' + token));
    assert.equal((await f.read()).token, token);
  } finally {
    await f.cli('stop');
  }
});

test('direct and foreground startup both initialize tokens before serving; explicit tokens remain unchanged', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  f.env.PORT = String(await freePort());
  const url = `http://127.0.0.1:${f.env.PORT}`;
  let saved;
  for (const [args, explicit] of [
    [['server/index.js'], null],
    [['bin/seed-pi-web.js', 'start', '-f'], null],
    [['bin/seed-pi-web.js', 'start', '-f', '--token', 'manual token +/#'], 'manual token +/#'],
  ]) {
    let output = '';
    const child = spawn(process.execPath, args, { cwd: root, env: f.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', b => { output += b; });
    child.stderr.on('data', b => { output += b; });
    let token;
    const close = async () => {
      if (child.exitCode !== null) return;
      await fetch(url + '/api/shutdown', { method: 'POST', headers: { 'x-seed-pi-web-token': token || '' } }).catch(() => {});
      await waitUntil(() => child.exitCode !== null).catch(() => child.kill());
    };
    try {
      await waitUntil(async () => {
        if (child.exitCode !== null) throw new Error(output);
        try {
          saved ||= (await f.read()).token;
          token = explicit || saved;
          return output.includes('已启动') && (await fetch(url + '/api/ping', { headers: { 'x-seed-pi-web-token': token } })).ok;
        } catch { return false; }
      });
      assert.match(saved, /^[A-Za-z0-9_-]{32}$/);
      assert.ok(output.includes(url + '/?token=' + encodeURIComponent(token)));
      assert.equal((await f.read()).token, saved, 'foreground/manual overrides do not rotate the saved token');
      await checkAuth(url, token);
    } finally {
      await close();
    }
  }
});
