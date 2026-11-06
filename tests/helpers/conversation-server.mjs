// Isolated real-pi / fake-model fixture. No external model calls or user session files.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

export async function connectClient(url, cid) {
  const ws = new WebSocket(url.replace(/^http/, 'ws') + '/ws?cid=' + cid);
  const records = [], pending = new Map();
  let seq = 0;
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    records.push(m);
    if (m.t === 'reply' && pending.has(m.rid)) {
      const p = pending.get(m.rid);
      pending.delete(m.rid);
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.data);
    }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return {
    ws, records,
    call: (t, args = {}) => new Promise((resolve, reject) => {
      const rid = ++seq;
      pending.set(rid, { resolve, reject });
      ws.send(JSON.stringify({ t, rid, ...args }));
    }),
  };
}
export async function waitUntil(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await new Promise(r => setTimeout(r, 30)); }
  throw new Error('fixture wait timed out');
}

export async function startConversationServer({ seed = false, modelDelay = 80 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-web-conversation-'));
  const piHome = path.join(dir, 'pi');
  const requests = [];
  const model = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    requests.push(body);
    const content = body.messages?.findLast(m => m.role === 'user')?.content;
    const text = typeof content === 'string' ? content : (content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = data => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'local', ...data }) + '\n\n');
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: `测试回复：${text}` }, finish_reason: null }] });
    // Slow enough to exercise multi-window ordering, fast enough for test suites.
    await new Promise(r => setTimeout(r, modelDelay));
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r => model.listen(0, '127.0.0.1', r));
  await fs.mkdir(piHome, { recursive: true });
  await fs.writeFile(path.join(piHome, 'models.json'), JSON.stringify({ providers: { 'seed-test': { api: 'openai-completions', apiKey: 'test-only', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, models: [{ id: 'local', name: 'Local test model', reasoning: true, input: ['text', 'image'], contextWindow: 32000, maxTokens: 4096, cost: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1 }, compat: { supportsReasoningEffort: true } }] } } }));
  await fs.writeFile(path.join(piHome, 'settings.json'), JSON.stringify({ defaultProvider: 'seed-test', defaultModel: 'local', defaultThinkingLevel: 'low', defaultProjectTrust: 'no', retry: { enabled: false } }));
  const probe = net.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  const url = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), SEED_PI_WEB_HOME: path.join(dir, 'web'), PI_CODING_AGENT_DIR: piHome, SEED_PI_WEB_TOKEN: '', SEED_PI_WEB_PI_ARGS: JSON.stringify(['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-mcp']) },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.on('data', b => output += b);
  child.stderr.on('data', b => output += b);
  const close = async () => {
    await fetch(url + '/api/shutdown', { method: 'POST' }).catch(() => {});
    if (child.exitCode == null) await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => { const timer = setTimeout(r, 5000); timer.unref(); })]);
    if (child.exitCode == null) child.kill();
    await new Promise(r => model.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  };
  try {
    await waitUntil(async () => { try { return (await fetch(url + '/api/ping')).ok; } catch { return false; } });
    if (seed) {
      const client = await connectClient(url, 'fixture-seed');
      const r = await client.call('ensure_agent', { cwd: dir });
      const rpc = cmd => client.call('rpc', { agentId: r.agent.id, cmd });
      for (const message of ['给登录页加功能', '使用密码登录']) {
        await rpc({ type: 'prompt', message });
        await waitUntil(() => client.records.filter(m => m.t === 'rec' && m.rec.type === 'agent_settled').length >= (message === '给登录页加功能' ? 1 : 2));
      }
      const snapshot = (await rpc({ type: 'get_web_snapshot' })).data;
      await rpc({ type: 'web_edit', targetId: snapshot.nodes[1].id, expectedLeafId: snapshot.leafId, message: '改成扫码登录' });
      await waitUntil(() => client.records.filter(m => m.t === 'rec' && m.rec.type === 'agent_settled').length >= 3);
      await client.call('leave', { agentId: r.agent.id });
      client.ws.close();
    }
    return { dir, url, requests, close, output: () => output };
  } catch (error) { await close(); throw new Error(error.message + '\n' + output); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await startConversationServer({ seed: true });
  console.log(JSON.stringify({ url: fixture.url + '/?cwd=' + encodeURIComponent(fixture.dir), dir: fixture.dir }));
  const stop = async () => { await fixture.close(); process.exit(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
