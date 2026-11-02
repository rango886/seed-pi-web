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
import { isLocalRequest, readClipboardFiles, resolveUploadDir, saveUpload, listProjectFiles, warmClipboard } from './attachments.js';

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

// ---------- pi 进程管理：一个会话文件对应一个 pi 进程 ----------
// 同一个目录下的几个会话可以同时跑，各写各的 jsonl，互不影响。
// 网页里切会话 = 换一个进程连上，不会让一个正在用的进程去换文件（switch_session）。
// 一个会话同时只有一个窗口能操作（owner），其他打开它的窗口只能看，状态和吐字照样同步。
const agents = new Map(); // id -> PiAgent
const clients = new Set();
const OWNER_GRACE_MS = 10_000; // 操作者断线后，过这么久才放开操作权（刷新页面不会被别人抢走）
const UNSAVED_IDLE_MS = 2 * 60_000; // 一句话都没说、也没人看的新会话，早点关掉
const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const agentList = () => [...agents.values()].map((a) => a.info());
const broadcastAgents = () => clients.forEach((c) => send(c, { t: 'agents', list: agentList() }));
const watchers = (a) => [...clients].filter((c) => c.agentId === a.id);
const findBySession = (file) => (file ? [...agents.values()].find((a) => a.alive && a.sessionFile && samePath(a.sessionFile, file)) : null);
// 只读的命令谁都能发；其余的（发消息、停止、换模型、压缩……）只有操作者能发
const isReadOnly = (cmd) => /^get_/.test(cmd?.type || '') || cmd?.type === 'export_html';
// 扩展弹窗、改输入框内容只发给操作者
const ownerOnlyRec = (rec) => rec.type === 'extension_ui_request' && (DIALOG_METHODS.has(rec.method) || rec.method === 'set_editor_text');

function forward(a, rec) {
  const msg = { t: 'rec', agentId: a.id, rec };
  for (const c of watchers(a)) {
    if (ownerOnlyRec(rec) && c.cid !== a.owner) continue;
    // 正在打开这个会话：先攒着，等打开的回复发出去以后再补发，保证顺序
    if (c.attachBuf) c.attachBuf.push(msg);
    else send(c, msg);
  }
}

// ---- 操作权 ----
/** 没人在用就拿过来；已经是自己的也算成功 */
function claim(a, ws) {
  if (a.owner && a.owner !== ws.cid) return false;
  clearTimeout(a.releaseTimer);
  a.releaseTimer = null;
  if (a.owner !== ws.cid) {
    a.owner = ws.cid;
    broadcastAgents();
  }
  return true;
}
const sameTabWatching = (a, cid, except) => [...clients].some((c) => c !== except && c.cid === cid && c.agentId === a.id);
function release(a) {
  clearTimeout(a.releaseTimer);
  a.releaseTimer = null;
  if (!a.owner) return;
  a.owner = null;
  broadcastAgents();
}
/** 这个连接不再看它的进程了（切到别的会话） */
function leave(ws) {
  const a = agents.get(ws.agentId);
  ws.agentId = null;
  if (a && a.owner === ws.cid && !sameTabWatching(a, ws.cid, ws)) release(a);
}

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

/** 问一下 pi 现在的状态；会话文件换了（fork/clone/扩展自己切了会话）就改登记 */
async function syncAgent(a) {
  const before = a.sessionFile;
  try {
    await a.refreshState();
    if (a.sessionFile) {
      a.saved = fs.existsSync(a.sessionFile);
      const cwd = a.saved && (await readHeaderCwd(a.sessionFile));
      if (cwd) a.cwd = cwd;
    }
  } catch {}
  if (before && a.sessionFile && !samePath(before, a.sessionFile)) onMoved(a, before);
  broadcastAgents();
}

/**
 * 进程换到了另一个会话文件（rekey）：操作者跟着走；
 * 只是在看旧会话的窗口留在旧会话上（旧文件没被改，前端会给它重新起一个进程）
 */
function onMoved(a, from) {
  const dup = [...agents.values()].some((x) => x !== a && x.alive && x.sessionFile && samePath(x.sessionFile, a.sessionFile));
  for (const c of watchers(a)) {
    if (c.cid === a.owner) {
      if (dup) send(c, { t: 'notice', kind: 'warning', text: '这个会话在另一个 pi 进程里也开着，两边同时写会冲突，建议关掉一个' });
      continue;
    }
    c.agentId = null;
    send(c, { t: 'session_moved', agentId: a.id, from, to: a.sessionFile, cwd: a.cwd });
  }
}

async function createAgent({ cwd, sessionFile }) {
  const st = await fsp.stat(cwd).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`目录不存在：${cwd}`);
  const a = new PiAgent({ cwd, sessionFile });
  a.lastUsed = Date.now();
  agents.set(a.id, a);
  a.on('record', (rec) => {
    forward(a, rec);
    if (rec.type === 'agent_settled') syncAgent(a);
  });
  a.on('info', broadcastAgents);
  a.on('exit', ({ code, stderr }) => {
    agents.delete(a.id);
    clearTimeout(a.releaseTimer);
    for (const c of watchers(a)) send(c, { t: 'agent_exit', agentId: a.id, code, stderr, restart: !!a.restarting, sessionFile: a.sessionFile, cwd: a.cwd });
    broadcastAgents();
  });
  a.start();
  try {
    await a.refreshState();
  } catch (e) {
    throw new Error(`pi 启动失败：${e.message}\n${a.stderrTail}`);
  }
  a.saved = !!a.sessionFile && fs.existsSync(a.sessionFile);
  broadcastAgents();
  return a;
}

/** 打开某个会话文件：已经有进程就连上，没有就起一个 */
async function openSession(file) {
  const found = findBySession(file);
  if (found) return found;
  const cwd = await readHeaderCwd(file);
  if (!cwd) throw new Error('无法读取会话文件');
  // 会话原来的目录已经不存在了（删了、外置盘拔了）：不报错，交给前端只读打开
  const dirOk = (await fsp.stat(cwd).catch(() => null))?.isDirectory();
  if (!dirOk) return { detached: { file, cwd } };
  return createAgent({ cwd, sessionFile: file });
}

/** 打开一个目录：优先上次在这个目录用的会话，其次这个目录里最近用过的进程，都没有就开新会话 */
async function openDir(cwd, sessionFile) {
  if (sessionFile) {
    const a = findBySession(sessionFile);
    if (a && samePath(a.cwd, cwd)) return a;
    if (!a && samePath((await readHeaderCwd(sessionFile)) || '', cwd)) return createAgent({ cwd, sessionFile });
  }
  const live = [...agents.values()].filter((a) => a.alive && samePath(a.cwd, cwd)).sort((x, y) => y.lastUsed - x.lastUsed);
  return live[0] || createAgent({ cwd });
}

/** 新会话 = 新进程，原来的会话不动（正在跑也接着跑） */
async function createSession(cwd, ws) {
  // 已经有一个还没说过话、也没人在用的新会话：直接用它，免得点几次「新会话」就多几个空进程
  const cur = agents.get(ws.agentId);
  const reusable = (a) => a.alive && !a.saved && !a.running && samePath(a.cwd, cwd) && (a === cur || (!a.owner && !watchers(a).length));
  const idle = [...agents.values()].find(reusable);
  return idle || createAgent({ cwd });
}

/**
 * 让这个连接开始看某个进程，回复里带上快照（写完的消息 + 进行中的事件）。
 * 快照那一刻就开始转发，打开的回复发出去之前来的事件先攒着（ctx.after 里补发）
 */
async function attachWs(ws, a, ctx) {
  if (ws.agentId && ws.agentId !== a.id) leave(ws);
  else ws.agentId = null; // 重新连同一个进程：快照之前先别转发，免得重复
  claim(a, ws);
  a.lastUsed = Date.now();
  const buf = [];
  ws.attachBuf = buf;
  let snap;
  try {
    snap = await a.snapshot(() => (ws.agentId = a.id));
  } catch (e) {
    if (ws.attachBuf === buf) ws.attachBuf = null;
    throw e;
  }
  ctx.after = () => {
    if (ws.attachBuf !== buf) return;
    ws.attachBuf = null;
    for (const m of buf) send(ws, m);
  };
  const owner = a.owner === ws.cid;
  return { agent: a.info(), owner, uiPending: owner ? [...a.uiPending.values()] : [], uiState: [...a.uiState.values()], ...snap };
}

const SESSION_CHANGING = new Set(['new_session', 'switch_session', 'fork', 'clone', 'set_session_name']);

// 闲置太久且没人看的 pi 进程自动关掉，省资源
setInterval(() => {
  const now = Date.now();
  for (const a of agents.values()) {
    if (watchers(a).length || a.running || a.uiPending.size) a.lastUsed = now;
    else if (now - a.lastUsed > (a.saved ? IDLE_MINUTES * 60_000 : UNSAVED_IDLE_MS)) a.stop();
  }
}, 30_000).unref();

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

// 路径存不存在：地址栏打字时会反复问，只 stat 一下，不读目录
app.get(
  '/api/fs/stat',
  wrap(async (req, res) => {
    const p = path.resolve(String(req.query.path || ''));
    const st = await fsp.stat(p).catch(() => null);
    res.json({ path: p, exists: !!st, dir: !!st?.isDirectory() });
  }),
);

// 新建目录：地址栏里输入了还不存在的路径，按输入的内容建出来（父目录一起建）
app.post(
  '/api/fs/mkdir',
  wrap(async (req, res) => {
    const raw = String(req.body?.path || '');
    if (!raw) throw new Error('路径是空的');
    const p = path.resolve(raw);
    if (p === path.parse(p).root) throw new Error('不能把磁盘根目录当新目录');
    const st = await fsp.stat(p).catch(() => null);
    if (st) {
      if (!st.isDirectory()) throw new Error('这个路径上已经有一个同名文件');
      return res.json({ path: p, created: false });
    }
    await fsp.mkdir(p, { recursive: true });
    res.json({ path: p, created: true });
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

const TEXT_LIMIT = 2 * 1024 * 1024;app.get(
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

// ---------- 附件：上传 / 读剪贴板里复制的文件 / @ 补全用的文件列表 ----------
// 上传：请求体就是文件内容本身（不走 base64 / JSON），边收边写盘
app.post(
  '/api/upload',
  wrap(async (req, res) => {
    const dir = resolveUploadDir(String(req.query.dir || ''), { cwd: String(req.query.cwd || ''), session: String(req.query.session || '') });
    const maxMB = Number(req.query.maxMB) || 0;
    res.json(await saveUpload(req, { dir, name: String(req.query.name || ''), maxBytes: maxMB > 0 ? maxMB * 1024 * 1024 : 0 }));
  }),
);

// 剪贴板里复制的文件（资源管理器 Ctrl+C）：只有网页和后端在同一台机器上才有意义，也只对本机开放
app.get(
  '/api/clipboard/files',
  wrap(async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: '只有本机打开的网页才能读剪贴板' });
    res.json({ files: await readClipboardFiles() });
  }),
);

app.get(
  '/api/fs/files',
  wrap(async (req, res) => {
    const cwd = path.resolve(String(req.query.cwd || ''));
    res.json(await listProjectFiles(cwd, req.query.fresh === '1'));
  }),
);

app.get('/api/info', (req, res) => {
  const local = isLocalRequest(req);
  if (local) warmClipboard();
  res.json({ home: os.homedir(), sep: path.sep, platform: process.platform, terminal: terminalAvailable(), cwd: process.cwd(), local });
});

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
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  ws.agentId = null;
  ws.attachBuf = null;
  // 每个浏览器标签页一个 id（存在 sessionStorage，刷新不变），用来认“谁是操作者”
  ws.cid = new URL(req.url, 'http://x').searchParams.get('cid') || `c${Math.random().toString(36).slice(2)}`;
  ws.terms = new Set();
  clients.add(ws);
  send(ws, { t: 'agents', list: agentList() });
  send(ws, { t: 'terms', list: terms.list() });

  const getAgent = (agentId) => {
    const a = agents.get(agentId);
    if (!a) throw new Error('pi 进程不存在，可能已退出');
    return a;
  };
  const mustOwn = (a) => {
    if (!claim(a, ws)) throw new Error('其他窗口正在使用这个会话，点「接管」以后才能操作');
  };

  const handlers = {
    // 打开某个目录（上次用的会话 > 这个目录里已有的进程 > 新会话）
    async attach({ cwd, sessionFile }, ctx) {
      return attachWs(ws, await openDir(path.resolve(cwd), sessionFile), ctx);
    },
    async open_session({ file }, ctx) {
      const r = await openSession(file);
      // 目录不存在：把消息读出来给前端只读显示，不启动 pi
      if (r.detached) {
        leave(ws);
        return { detached: { ...r.detached, messages: await readSessionMessages(file) } };
      }
      return attachWs(ws, r, ctx);
    },
    // 新会话：起一个新进程，原来的会话不受影响
    async create_session({ cwd }, ctx) {
      return attachWs(ws, await createSession(path.resolve(cwd), ws), ctx);
    },
    // 把操作权拿过来（比如另一台电脑上忘了关的窗口）
    async take_over({ agentId }) {
      const a = getAgent(agentId);
      release(a);
      claim(a, ws);
      return { uiPending: [...a.uiPending.values()] };
    },
    // 原样转发 RPC 命令：pi 新增的命令前端直接就能用，后端不用改
    async rpc({ agentId, cmd }) {
      const a = getAgent(agentId);
      const readOnly = isReadOnly(cmd);
      if (!readOnly) mustOwn(a);
      a.lastUsed = Date.now();
      const res = await a.request(cmd);
      if (SESSION_CHANGING.has(cmd.type) && res.success) await syncAgent(a);
      // 操作者改了模型、思考强度之类：让旁观的窗口也刷新一下状态
      if (!readOnly && res.success) for (const c of watchers(a)) if (c !== ws) send(c, { t: 'state_changed', agentId: a.id, cmd: cmd.type });
      return res;
    },
    async ui_response({ agentId, msg }) {
      const a = agents.get(agentId);
      if (a && a.owner === ws.cid) a.respondUi(msg);
      return {};
    },
    // 重启 pi（相当于 /reload：重新加载扩展、技能、设置），保留当前会话
    async restart({ agentId }, ctx) {
      const a = getAgent(agentId);
      mustOwn(a);
      const { cwd, sessionFile } = a;
      a.restarting = true;
      await a.stop();
      return attachWs(ws, await createAgent({ cwd, sessionFile }), ctx);
    },
    async stop({ agentId }) {
      const a = agents.get(agentId);
      if (!a) return {};
      mustOwn(a);
      await a.stop();
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
    const ctx = { after: null };
    try {
      send(ws, { t: 'reply', rid: msg.rid, data: await h(msg, ctx) });
    } catch (e) {
      send(ws, { t: 'reply', rid: msg.rid, error: e.message });
    }
    ctx.after?.();
  });
  ws.on('close', () => {
    clients.delete(ws);
    const a = agents.get(ws.agentId);
    // 操作者断线：等一会儿再放开操作权，刷新页面回来还是它的
    if (a && a.owner === ws.cid && !sameTabWatching(a, ws.cid, ws)) {
      clearTimeout(a.releaseTimer);
      a.releaseTimer = setTimeout(() => {
        if (a.owner === ws.cid && !sameTabWatching(a, ws.cid)) release(a);
      }, OWNER_GRACE_MS);
    }
  });
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
