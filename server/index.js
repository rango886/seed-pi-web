// pi-web 后端：HTTP（静态文件 + 文件/历史接口）+ WebSocket（转发 RPC、终端）
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { PiAgent } from './pi-agent.js';
import { listSessions, recentDirs, sessionRoots, isInside, samePath, readSessionMessages } from './sessions.js';
import { TerminalManager, terminalAvailable } from './terminal.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.PI_WEB_TOKEN || '';
const IDLE_MINUTES = Number(process.env.PI_WEB_IDLE_MINUTES || 30);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

// ---------- 安全：token / Host / Origin 校验 ----------
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
function checkRequest(req) {
  const url = new URL(req.url, 'http://x');
  const host = req.headers.host || '';
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== host) return false; // 拒绝跨站请求
    } catch {
      return false;
    }
  }
  if (TOKEN) {
    const t = req.headers['x-pi-web-token'] || url.searchParams.get('token');
    return t === TOKEN;
  }
  // 没设 token 时只接受本机 Host，防 DNS rebinding
  const hostname = host.replace(/:\d+$/, '');
  return LOCAL_HOSTS.has(hostname) || hostname === HOST;
}

// ---------- pi 进程管理 ----------
const agents = new Map();
const clients = new Set();

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const agentList = () => [...agents.values()].map((a) => a.info());
const broadcastAgents = () => clients.forEach((c) => send(c, { t: 'agents', list: agentList() }));

async function readHeaderCwd(file) {
  try {
    const fh = await fsp.open(file, 'r');
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0);
    await fh.close();
    const first = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0];
    return JSON.parse(first).cwd || null;
  } catch {
    return null;
  }
}

async function syncAgent(a) {
  try {
    await a.refreshState();
    if (a.sessionFile) {
      const cwd = await readHeaderCwd(a.sessionFile);
      if (cwd) a.cwd = cwd;
    }
  } catch {}
  broadcastAgents();
}

async function createAgent({ cwd, sessionFile }) {
  const st = await fsp.stat(cwd).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`目录不存在：${cwd}`);
  const a = new PiAgent({ cwd, sessionFile });
  a.lastUsed = Date.now();
  agents.set(a.id, a);
  a.on('record', (rec) => {
    for (const c of clients) if (c.agentId === a.id) send(c, { t: 'rec', agentId: a.id, rec });
    if (rec.type === 'agent_settled') syncAgent(a);
  });
  a.on('info', broadcastAgents);
  a.on('exit', ({ code, stderr }) => {
    agents.delete(a.id);
    for (const c of clients) if (c.agentId === a.id) send(c, { t: 'agent_exit', agentId: a.id, code, stderr });
    broadcastAgents();
  });
  a.start();
  try {
    await a.refreshState();
  } catch (e) {
    throw new Error(`pi 启动失败：${e.message}\n${a.stderrTail}`);
  }
  broadcastAgents();
  return a;
}

const findAgentByCwd = (cwd) => [...agents.values()].find((a) => a.alive && samePath(a.cwd, cwd));

async function getOrCreateAgent(cwd, sessionFile) {
  const found = findAgentByCwd(cwd);
  if (found) return found;
  // 恢复上次的会话（比如后端重启过），文件不在了就开新会话
  const ok = sessionFile && samePath((await readHeaderCwd(sessionFile)) || '', cwd);
  return createAgent({ cwd, sessionFile: ok ? sessionFile : undefined });
}

async function openSession(file) {
  const cwd = await readHeaderCwd(file);
  if (!cwd) throw new Error('无法读取会话文件');
  // 会话原来的目录已经不存在了（删了、外置盘拔了）：不报错，交给前端只读打开
  const dirOk = (await fsp.stat(cwd).catch(() => null))?.isDirectory();
  if (!dirOk) return { detached: { file, cwd } };
  const a = findAgentByCwd(cwd);
  if (!a) return createAgent({ cwd, sessionFile: file });
  if (a.sessionFile && samePath(a.sessionFile, file)) return a;
  if (a.running) throw new Error('这个目录的 pi 正在运行，请先停止或等它结束');
  const res = await a.request({ type: 'switch_session', sessionPath: file });
  if (!res.success) throw new Error(res.error || '切换失败');
  if (res.data?.cancelled) throw new Error('扩展取消了切换');
  await syncAgent(a);
  return a;
}

const SESSION_CHANGING = new Set(['new_session', 'switch_session', 'fork', 'clone', 'set_session_name']);

// 闲置太久且没人看的 pi 进程自动关掉，省资源
setInterval(() => {
  const now = Date.now();
  for (const a of agents.values()) {
    const watched = [...clients].some((c) => c.agentId === a.id);
    if (watched || a.running) a.lastUsed = now;
    else if (now - a.lastUsed > IDLE_MINUTES * 60_000) a.stop();
  }
}, 60_000).unref();

// ---------- 终端 ----------
const terms = new TerminalManager();
terms.on('data', (id, data) => clients.forEach((c) => c.terms.has(id) && send(c, { t: 'term_data', id, data })));
terms.on('exit', (id, code) => clients.forEach((c) => send(c, { t: 'term_exit', id, code })));
terms.on('change', () => clients.forEach((c) => send(c, { t: 'terms', list: terms.list() })));

// ---------- HTTP ----------
const app = express();
app.use('/api', (req, res, next) => (checkRequest(req) ? next() : res.status(403).json({ error: 'forbidden' })));
app.use(express.json({ limit: '5mb' }));

const liveRoots = () => sessionRoots([...agents.values()].map((a) => a.sessionFile && path.dirname(path.dirname(a.sessionFile))));
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(400).json({ error: e.message }));

app.get(
  '/api/sessions',
  wrap(async (req, res) => {
    const roots = await liveRoots();
    // all=1 表示“所有目录”；否则按 cwd 过滤（注意 query 里是字符串，'0' 也是真值）
    const all = req.query.all === '1' || req.query.all === 'true';
    const cwd = all ? null : String(req.query.cwd || '');
    if (!all && !cwd) throw new Error('缺少 cwd 参数');
    res.json(await listSessions({ cwd, roots }));
  }),
);

app.delete(
  '/api/sessions',
  wrap(async (req, res) => {
    const file = String(req.query.file || '');
    if (!isInside(file, await liveRoots()) || !file.endsWith('.jsonl')) throw new Error('不允许删除这个文件');
    if ([...agents.values()].some((a) => a.sessionFile && samePath(a.sessionFile, file))) throw new Error('会话正在使用中');
    await fsp.unlink(file);
    res.json({ ok: true });
  }),
);

app.get(
  '/api/recent-dirs',
  wrap(async (req, res) => res.json(await recentDirs(await liveRoots()))),
);

app.get(
  '/api/fs/list',
  wrap(async (req, res) => {
    const dir = path.resolve(String(req.query.path || os.homedir()));
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    const entries = [];
    for (const e of ents) {
      const isDir = e.isDirectory() || (e.isSymbolicLink() && (await fsp.stat(path.join(dir, e.name)).catch(() => null))?.isDirectory());
      if (req.query.dirsOnly && !isDir) continue;
      entries.push({ name: e.name, dir: !!isDir });
    }
    entries.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
    const parent = path.dirname(dir);
    res.json({ path: dir, parent: parent !== dir ? parent : null, sep: path.sep, entries });
  }),
);

app.get(
  '/api/fs/roots',
  wrap(async (req, res) => {
    const roots = [];
    if (process.platform === 'win32') {
      // 逐个盘符试一下，存在的就当根目录（A/B 也试，插了软盘、映射盘也能看到）
      for (const L of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        const p = `${L}:\\`;
        if ((await fsp.stat(p).catch(() => null))?.isDirectory()) roots.push({ name: `${L}:`, path: p });
      }
    } else {
      roots.push({ name: '/', path: '/' });
    }
    res.json(roots);
  }),
);

const TEXT_LIMIT = 2 * 1024 * 1024;
app.get(
  '/api/fs/read',
  wrap(async (req, res) => {
    const file = path.resolve(String(req.query.path || ''));
    const st = await fsp.stat(file);
    if (st.isDirectory()) throw new Error('这是一个目录');
    const fh = await fsp.open(file, 'r');
    const len = Math.min(st.size, TEXT_LIMIT);
    const { buffer } = await fh.read(Buffer.alloc(len), 0, len, 0);
    await fh.close();
    const binary = buffer.subarray(0, 8000).includes(0);
    res.json({
      path: file,
      size: st.size,
      mtime: st.mtimeMs,
      binary,
      truncated: st.size > TEXT_LIMIT,
      text: binary ? '' : buffer.toString('utf8'),
    });
  }),
);

app.get('/api/fs/raw', (req, res) => {
  const file = path.resolve(String(req.query.path || ''));
  res.sendFile(file, { dotfiles: 'allow' }, (err) => err && !res.headersSent && res.status(404).end());
});

app.get('/api/info', (req, res) =>
  res.json({ home: os.homedir(), sep: path.sep, platform: process.platform, terminal: terminalAvailable(), cwd: process.cwd() }),
);

if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^(?!\/api|\/ws).*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')));
} else {
  app.get('/', (req, res) => res.send('前端还没构建：先运行 npm run build，或者用 npm run dev 开发模式。'));
}

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 50 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws') || !checkRequest(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', (ws) => {
  ws.agentId = null;
  ws.terms = new Set();
  clients.add(ws);
  send(ws, { t: 'agents', list: agentList() });
  send(ws, { t: 'terms', list: terms.list() });

  const attach = (a) => {
    ws.agentId = a.id;
    a.lastUsed = Date.now();
    return { agent: a.info(), uiPending: [...a.uiPending.values()], uiState: [...a.uiState.values()] };
  };

  const handlers = {
    // 打开某个目录（没有 pi 进程就启动一个）
    async attach({ cwd, sessionFile }) {
      return attach(await getOrCreateAgent(path.resolve(cwd), sessionFile));
    },
    async open_session({ file }) {
      const r = await openSession(file);
      // 目录不存在：把消息读出来给前端只读显示，不启动 pi
      if (r.detached) return { detached: { ...r.detached, messages: await readSessionMessages(file) } };
      return attach(r);
    },
    // 原样转发 RPC 命令：pi 新增的命令前端直接就能用，后端不用改
    async rpc({ agentId, cmd }) {
      const a = agents.get(agentId);
      if (!a) throw new Error('pi 进程不存在，可能已退出');
      a.lastUsed = Date.now();
      const res = await a.request(cmd);
      if (SESSION_CHANGING.has(cmd.type) && res.success) await syncAgent(a);
      return res;
    },
    async ui_response({ agentId, msg }) {
      agents.get(agentId)?.respondUi(msg);
      return {};
    },
    // 重启 pi（相当于 /reload：重新加载扩展、技能、设置），保留当前会话
    async restart({ agentId }) {
      const a = agents.get(agentId);
      if (!a) throw new Error('pi 进程不存在');
      const { cwd, sessionFile } = a;
      await a.stop();
      return attach(await createAgent({ cwd, sessionFile }));
    },
    async stop({ agentId }) {
      await agents.get(agentId)?.stop();
      return {};
    },
    async term_open({ cwd, cols, rows, command, title }) {
      const t = terms.open({ cwd: path.resolve(cwd), cols, rows, command, title });
      ws.terms.add(t.id);
      return { term: t.info() };
    },
    async term_attach({ id }) {
      const t = terms.get(id);
      if (!t) throw new Error('终端不存在');
      ws.terms.add(id);
      return { buffer: t.buffer };
    },
    async term_close({ id }) {
      terms.close(id);
      return {};
    },
  };

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // 高频消息不需要回复
    if (msg.t === 'term_in') return terms.get(msg.id)?.write(msg.data);
    if (msg.t === 'term_resize') return terms.get(msg.id)?.resize(msg.cols, msg.rows);
    const h = handlers[msg.t];
    if (!h) return send(ws, { t: 'reply', rid: msg.rid, error: `未知消息 ${msg.t}` });
    try {
      send(ws, { t: 'reply', rid: msg.rid, data: await h(msg) });
    } catch (e) {
      send(ws, { t: 'reply', rid: msg.rid, error: e.message });
    }
  });
  ws.on('close', () => clients.delete(ws));
});

server.listen(PORT, HOST, () => {
  console.log(`pi-web 已启动：http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${TOKEN ? `/?token=${TOKEN}` : ''}`);
  if (!TOKEN && !LOCAL_HOSTS.has(HOST)) console.warn('警告：监听了非本机地址但没设置 PI_WEB_TOKEN，非 localhost 访问会被拒绝。');
});

async function shutdown() {
  terms.closeAll();
  await Promise.all([...agents.values()].map((a) => a.stop()));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
