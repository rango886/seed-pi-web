// seed-pi-web 后端：HTTP（静态文件 + 文件/历史接口）+ WebSocket（转发 RPC、终端）
import './env.js'; // 必须第一个：把配置文件合并进环境变量
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import express from 'express';
import { WebSocketServer } from 'ws';
import { PiAgent } from './pi-agent.js';
import { modelModules, readModelCatalog } from './models.js';
import { listSessions, recentDirs, sessionRoots, sessionCwds, isInside, samePath, readSessionSnapshot, agentDir } from './sessions.js';
import { createTempDir, cleanupTempDirs, listHas } from './temp-dirs.js';
import { createFavorites, registerFavorites } from './favorites.js';
import { createPrefs, registerPrefs } from './prefs.js';
import { TerminalManager, terminalAvailable } from './terminal.js';
import { gitStatus, gitDiff, gitBranch } from './git.js';
import { registerDownloads } from './downloads.js';
import { archiveKey, createSessionArchive, registerSessionArchive, registerSessionStar } from './session-archive.js';
import { APP, HOME_DIR, STATE_FILE, readState } from './config.js';
import { isLocalRequest, readClipboardFiles, resolveUploadDir, saveUpload, listProjectFiles, warmClipboard } from './attachments.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.SEED_PI_WEB_TOKEN;
const IDLE_MINUTES = Number(process.env.SEED_PI_WEB_IDLE_MINUTES || 30);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

// ---------- 安全：token / Origin 校验（启动时保证 token 已初始化） ----------
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
  const t = req.headers['x-seed-pi-web-token'] || url.searchParams.get('token');
  return !!TOKEN && t === TOKEN;
}

// ---------- pi 进程管理：一个会话文件对应一个 pi 进程 ----------
// 进程按需启动：点开会话只读会话文件给前端看（lazy），真要用了（发消息、换模型……）才起 pi。
// 同一个目录下的几个会话可以同时跑，各写各的 jsonl，互不影响。
// 网页里切会话 = 换一个进程连上，不会让一个正在用的进程去换文件（switch_session）。
// 一个会话同时只有一个窗口能操作（owner），其他打开它的窗口只能看，状态和吐字照样同步。
const agents = new Map(); // id -> PiAgent
const clients = new Set();
const OWNER_GRACE_MS = 10_000; // 操作者断线后，过这么久才放开操作权（刷新页面不会被别人抢走）
const UNSAVED_IDLE_MS = 2 * 60_000; // 一句话都没说的新会话，早点关掉
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

/** 会话文件已经出现在磁盘上了就标上（pi 是用户消息 append 的那一刻建的文件，不用去问 get_state） */
function markSaved(a) {
  if (a.saved || !a.sessionFile || !fs.existsSync(a.sessionFile)) return;
  a.saved = true;
  broadcastAgents(); // 前端看到 saved 变了会重新拉会话列表，侧栏的“新会话”就变成真正的标题
}

/**
 * 进程换到了另一个会话文件（rekey）：操作者跟着走；
 * 只是在看旧会话的窗口留在旧会话上（旧文件没被改，前端退回只看旧文件）
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
  assertNotDeleting(sessionFile);
  const a = new PiAgent({ cwd, sessionFile });
  a.lastUsed = Date.now();
  agents.set(a.id, a);
  a.on('record', (rec) => {
    a.lastUsed = Date.now();
    forward(a, rec);
    // agent_start / message_end 时用户消息已经写进文件了：赶紧把 saved 标上，别让侧栏整个回复期间都显“新会话”
    if (rec.type === 'agent_start' || rec.type === 'message_end') markSaved(a);
    if (rec.type === 'agent_settled') syncAgent(a);
  });
  a.on('info', broadcastAgents);
  a.on('exit', ({ code, stderr }) => {
    agents.delete(a.id);
    clearTimeout(a.releaseTimer);
    // quiet：闲置回收、手动关闭，不是出错。前端退回“只看”状态，要用时再起
    const quiet = !!a.quiet;
    for (const c of watchers(a)) send(c, { t: 'agent_exit', agentId: a.id, code, stderr, restart: !!a.restarting, quiet, saved: a.saved, sessionFile: a.sessionFile, cwd: a.cwd });
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

async function mustBeDir(cwd) {
  const st = await fsp.stat(cwd).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`目录不存在：${cwd}`);
}

/**
 * 不起进程的“只看”视图：消息、模型、用量都从会话文件里读。
 * file 为空 = 还没说过话的新会话，默认模型使用 pi 的选择逻辑
 */
async function lazyView(cwd, file) {
  const [catalog, snap] = await Promise.all([readModelCatalog(cwd), file ? readSessionSnapshot(file) : null]);
  const state = snap?.state || { ...catalog.defaults, isStreaming: false, isCompacting: false };
  const model = catalog.models.find((m) => m.provider === state.model?.provider && m.id === state.model?.id);
  if (model) state.model = model;
  return { lazy: { cwd: snap?.cwd || cwd, file: file || null, messages: snap?.messages || [], state, stats: snap?.stats || null, conversation: snap?.conversation || null, models: catalog.models } };
}

// 正在启动的进程：同一个会话同时被要求启动两次（两个窗口、连点）只起一个
const starting = new Map(); // 会话文件（规范化）-> Promise<PiAgent>
const fileKey = (f) => (process.platform === 'linux' ? path.resolve(f) : path.resolve(f).toLowerCase());
const deleting = new Set();
function assertNotDeleting(file) {
  if (file && deleting.has(fileKey(file))) throw new Error('会话正在删除中');
}

/** 要真正用这个会话了：有进程就用，没有就起一个。file 为空就是开一个新会话 */
async function ensureAgent(cwd, file) {
  assertNotDeleting(file);
  if (file && !fs.existsSync(file)) file = null; // 新会话还没写盘进程就被回收了：当成新会话重新开
  if (!file) {
    await mustBeDir(cwd);
    return createAgent({ cwd });
  }
  const found = findBySession(file);
  if (found) return found;
  const k = fileKey(file);
  if (!starting.has(k)) {
    const p = (async () => {
      const hc = await readHeaderCwd(file);
      return createAgent({ cwd: hc || cwd, sessionFile: file });
    })().finally(() => starting.delete(k));
    starting.set(k, p);
  }
  return starting.get(k);
}

/** 打开某个会话文件：已经有进程就连上，没有就只读文件，先不起进程 */
async function openSession(file) {
  assertNotDeleting(file);
  const found = findBySession(file);
  if (found) return found;
  const cwd = await readHeaderCwd(file);
  if (!cwd) throw new Error('无法读取会话文件');
  // 会话原来的目录已经不存在了（删了、外置盘拔了）：不报错，交给前端只读打开
  const dirOk = (await fsp.stat(cwd).catch(() => null))?.isDirectory();
  if (!dirOk) return { detached: { file, cwd, messages: (await readSessionSnapshot(file)).messages } };
  return lazyView(cwd, file);
}

/** 打开一个目录：优先上次在这个目录用的会话，其次这个目录里最近用过的进程，都没有就开新会话 */
async function openDir(cwd, sessionFile) {
  await mustBeDir(cwd);
  if (sessionFile) {
    assertNotDeleting(sessionFile);
    const a = findBySession(sessionFile);
    if (a && samePath(a.cwd, cwd)) return a;
    if (!a && samePath((await readHeaderCwd(sessionFile)) || '', cwd)) return lazyView(cwd, sessionFile);
  }
  const live = [...agents.values()].filter((a) => a.alive && (!a.sessionFile || !deleting.has(fileKey(a.sessionFile))) && samePath(a.cwd, cwd)).sort((x, y) => y.lastUsed - x.lastUsed);
  return live[0] || lazyView(cwd, null);
}

/** 新会话：先不起进程，第一次要用的时候再起；原来的会话不动（正在跑也接着跑） */
async function createSession(cwd, ws) {
  await mustBeDir(cwd);
  // 当前就是一个已经起了进程、还没说过话的新会话：接着用它
  const cur = agents.get(ws.agentId);
  if (cur && cur.alive && !cur.saved && !cur.running && samePath(cur.cwd, cwd)) return cur;
  return lazyView(cwd, null);
}

/**
 * 让这个连接开始看某个进程，回复里带上快照（写完的消息 + 进行中的事件）。
 * 快照那一刻就开始转发，打开的回复发出去之前来的事件先攒着（ctx.after 里补发）
 */
async function attachWs(ws, a, ctx) {
  assertNotDeleting(a.sessionFile);
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

// 闲置太久的 pi 进程自动关掉，省资源。开着页面看也算闲置：前端会退回“只看”，要用时再起
setInterval(() => {
  const now = Date.now();
  for (const a of agents.values()) {
    if (a.running || a.conversationBusy || a.uiPending.size) a.lastUsed = now;
    else if (now - a.lastUsed > (a.saved ? IDLE_MINUTES * 60_000 : UNSAVED_IDLE_MS)) {
      a.quiet = true;
      a.stop();
    }
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
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (!res.headersSent && !res.destroyed) res.status(400).json({ error: e.message });
});
registerDownloads(app, wrap);
const sessionArchive = createSessionArchive(path.join(HOME_DIR, 'session-archive.json'));
registerSessionArchive(app, wrap, {
  archive: sessionArchive,
  roots: liveRoots,
  changed: (change) => clients.forEach((c) => send(c, { t: 'session_archive', ...change })),
});
// 星标和归档互不影响：一个会话可以既是星标又已归档。
const sessionStars = createSessionArchive(path.join(HOME_DIR, 'session-stars.json'));
registerSessionStar(app, wrap, {
  stars: sessionStars,
  roots: liveRoots,
  changed: (change) => clients.forEach((c) => send(c, { t: 'session_star', ...change })),
});
// 收藏的目录：改了就通知所有标签页，大家看到的是同一份
const favorites = createFavorites(path.join(HOME_DIR, 'favorites.json'));
registerFavorites(app, wrap, {
  favorites,
  changed: (list) => clients.forEach((c) => send(c, { t: 'favorites', list })),
});
// 网页的偏好设置（以前在浏览器 localStorage 里的那些键）
const prefs = createPrefs(path.join(HOME_DIR, 'prefs.json'));
registerPrefs(app, wrap, { prefs });
// 设置里的导入导出：偏好设置、收藏、归档、星标一起备份。导入是整份替换，缺的字段不动
const strList = (v, label) => {
  if (!Array.isArray(v) || !v.every((p) => typeof p === 'string')) throw new Error(`${label}必须是路径数组`);
  return v;
};
app.get(
  '/api/backup',
  wrap(async (req, res) => {
    const [p, fav, archived, starred] = await Promise.all([prefs.read(), favorites.read(), sessionArchive.read(), sessionStars.read()]);
    res.json({ prefs: p, favorites: fav, archived: [...archived], starred: [...starred] });
  }),
);
app.post(
  '/api/backup',
  wrap(async (req, res) => {
    const b = req.body || {};
    const fav = b.favorites === undefined ? null : strList(b.favorites, '收藏');
    const archived = b.archived === undefined ? null : strList(b.archived, '归档');
    const starred = b.starred === undefined ? null : strList(b.starred, '星标');
    if (b.prefs !== undefined) await prefs.replace(b.prefs);
    await Promise.all([fav && favorites.write(fav), archived && sessionArchive.replace(archived), starred && sessionStars.replace(starred)]);
    res.json({ ok: true });
  }),
);
app.get('/api/models', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await readModelCatalog(req.query.cwd ? path.resolve(String(req.query.cwd)) : undefined));
}));
app.get('/api/git/status', wrap(async (req, res) => {
  if (!req.query.cwd) throw new Error('缺少工作目录');
  res.json(await gitStatus(String(req.query.cwd), req.query.fresh === '1'));
}));
app.get('/api/git/branch', wrap(async (req, res) => {
  if (!req.query.cwd) throw new Error('缺少工作目录');
  res.json(await gitBranch(String(req.query.cwd)));
}));
app.get('/api/git/diff', wrap(async (req, res) => {
  if (!req.query.cwd || !req.query.path) throw new Error('缺少工作目录或文件路径');
  res.json(await gitDiff(String(req.query.cwd), String(req.query.path), String(req.query.mode || 'working')));
}));

app.get(
  '/api/sessions',
  wrap(async (req, res) => {
    const roots = await liveRoots();
    // all=1 表示“所有目录”；否则按 cwd 过滤（注意 query 里是字符串，'0' 也是真值）
    const all = req.query.all === '1' || req.query.all === 'true';
    const cwd = all ? null : String(req.query.cwd || '');
    if (!all && !cwd) throw new Error('缺少 cwd 参数');
    const [list, archived, starred] = await Promise.all([listSessions({ cwd, roots }), sessionArchive.read(), sessionStars.read()]);
    res.json(list.map((s) => ({ ...s, archived: archived.has(archiveKey(s.file)), starred: starred.has(archiveKey(s.file)) })));
  }),
);

app.delete(
  '/api/sessions',
  wrap(async (req, res) => {
    const file = String(req.query.file || '');
    if (!isInside(file, await liveRoots()) || !file.endsWith('.jsonl')) throw new Error('不允许删除这个文件');
    const key = fileKey(file);
    assertNotDeleting(file);
    deleting.add(key);
    try {
      // 启动中也先等它完成；锁住这个文件，避免关闭期间又起一个进程。
      await starting.get(key)?.catch(() => {});
      const active = [...agents.values()].filter((a) => a.sessionFile && samePath(a.sessionFile, file));
      await Promise.all(active.map((a) => {
        a.quiet = true;
        return a.stop();
      }));
      await fsp.unlink(file);
      await Promise.all([sessionArchive.set(file, false), sessionStars.set(file, false)]);
      for (const c of clients) {
        if (active.some((a) => a.id === c.agentId)) c.agentId = null;
        send(c, { t: 'session_deleted', file });
      }
      res.json({ ok: true });
    } finally {
      deleting.delete(key);
    }
  }),
);

// “清空最近使用”只记一个时间点：最近目录是从会话文件推出来的，不动会话，只把这个时间点以前的藏起来
const RECENT_FILE = path.join(HOME_DIR, 'recent-dirs.json');
async function recentClearedAt() {
  try {
    return Number(JSON.parse(await fsp.readFile(RECENT_FILE, 'utf8')).clearedAt) || 0;
  } catch {
    return 0;
  }
}
app.get(
  '/api/recent-dirs',
  wrap(async (req, res) => {
    const [rows, clearedAt] = await Promise.all([recentDirs(await liveRoots()), recentClearedAt()]);
    res.json(rows.filter((r) => Date.parse(r.modified) > clearedAt));
  }),
);
app.delete(
  '/api/recent-dirs',
  wrap(async (req, res) => {
    await fsp.mkdir(HOME_DIR, { recursive: true });
    await fsp.writeFile(RECENT_FILE, JSON.stringify({ clearedAt: Date.now() }));
    res.json({ ok: true });
  }),
);

// ---------- 新会话的默认模型 / 思考强度 ----------
// pi 的 RPC 里没有“设置默认”这个命令，只有 set_model / set_thinking_level（改当前会话），
// 所以这里直接改它的全局 settings.json（~/.pi/agent/settings.json），下次 pi 启动时读的就是它
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
app.post(
  '/api/settings/default',
  wrap(async (req, res) => {
    const provider = req.body?.provider;
    const modelId = req.body?.modelId;
    const thinkingLevel = req.body?.thinkingLevel;
    const file = path.join(agentDir(), 'settings.json');
    let s = {};
    try {
      s = JSON.parse(await fsp.readFile(file, 'utf8')) || {};
    } catch {}
    let changed = false;
    if (provider && modelId) {
      s.defaultProvider = String(provider);
      s.defaultModel = String(modelId);
      changed = true;
    }
    if (thinkingLevel) {
      const lv = String(thinkingLevel);
      if (!THINKING_LEVELS.has(lv)) throw new Error(`不认识的思考强度：${lv}`);
      s.defaultThinkingLevel = lv;
      changed = true;
    }
    if (!changed) throw new Error('没说要改什么');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // 和 pi 自己保存时的格式保持一致（2 空格缩进、不补末尾换行），它下次读/写不会看不出差异
    await fsp.writeFile(file, JSON.stringify(s, null, 2), 'utf8');
    res.json({ ok: true, settings: s });
  }),
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

// 临时会话：在设置里的根目录下按文件夹名模板建一个新文件夹，前端拿到路径后在里面开会话。
// 建完顺手清一下以前留下的空文件夹（规则见 temp-dirs.js），不让前端等
app.post(
  '/api/fs/temp-dir',
  wrap(async (req, res) => {
    const dir = await createTempDir({ root: String(req.body?.root || ''), name: String(req.body?.name || '') });
    res.json({ path: dir });
    let cwds = null;
    cleanupTempDirs(async (d) => {
      if ([...agents.values()].some((a) => a.alive && samePath(a.cwd, d))) return true;
      cwds ??= await sessionCwds(await liveRoots());
      return listHas(cwds, d);
    }).catch((e) => console.warn('[temp-dir] 清理失败：', e.message));
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

// 代下载：网页里的链接右键“下载”，跨域地址浏览器不让直接存成文件，由后端取回来再以附件形式转给浏览器
function downloadName(r, u) {
  const cd = r.headers.get('content-disposition') || '';
  const star = /filename\*\s*=\s*(?:UTF-8'[^']*')?([^;]+)/i.exec(cd);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  let name = '';
  try {
    name = star ? decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')) : plain ? plain[1].trim() : decodeURIComponent(new URL(r.url || u).pathname.split('/').pop() || '');
  } catch {}
  name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  return name || new URL(r.url || u).hostname || 'download';
}
app.get(
  '/api/download',
  wrap(async (req, res) => {
    const u = new URL(String(req.query.url || ''));
    if (!/^https?:$/.test(u.protocol)) throw new Error('只支持 http / https 地址');
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const r = await fetch(u, { redirect: 'follow', signal: ac.signal, headers: { 'user-agent': 'Mozilla/5.0 seed-pi-web' } });
    if (!r.ok || !r.body) return res.status(r.status || 502).json({ error: `下载失败：${r.status} ${r.statusText}` });
    const name = downloadName(r, u);
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
    const len = r.headers.get('content-length');
    if (len && !r.headers.get('content-encoding')) res.setHeader('Content-Length', len);
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
  }),
);

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

// 模型回复里只写了文件名（`util.js`）或者不完整的相对路径（`src/util.js`），按原样拼出来找不到时，
// 在项目文件列表里找“路径以它结尾”的文件。列表和 @ 选文件共用一份缓存
app.get(
  '/api/fs/resolve',
  wrap(async (req, res) => {
    const cwd = path.resolve(String(req.query.cwd || ''));
    const rel = String(req.query.rel || '')
      .replace(/\\/g, '/')
      .replace(/^(?:\.{1,2}\/)+/, '') // ./a.js、../x/a.js：开头的相对部分去掉，只按后面那截匹配
      .replace(/^\/+/, '');
    if (!rel || rel.split('/').includes('..')) return res.json({ matches: [] });
    const { files } = await listProjectFiles(cwd);
    // Windows / mac 的文件名默认不分大小写
    const fold = process.platform === 'linux' ? (s) => s : (s) => s.toLowerCase();
    const want = fold(rel);
    const tail = '/' + want;
    const matches = [];
    for (const f of files) {
      const n = fold(f);
      if (n === want || n.endsWith(tail)) {
        matches.push(path.join(cwd, f));
        if (matches.length >= 50) break;
      }
    }
    res.json({ matches });
  }),
);

// 给命令行用：确认端口上跑的是不是本服务
app.get('/api/ping', (req, res) => res.json({ app: APP, pid: process.pid, port: PORT, host: HOST, startedAt: STARTED_AT }));
// 命令行 `seed-pi-web stop`：只接受本机请求，让后端自己把 pi 进程和终端收拾干净再退出
app.post('/api/shutdown', (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: '只能在本机关闭' });
  res.json({ ok: true });
  setTimeout(shutdown, 50);
});

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

  /** 打开的结果：有进程就连上；只看（lazy / detached）就不再看原来的进程 */
  const present = (r, ctx) => {
    if (r instanceof PiAgent) return attachWs(ws, r, ctx);
    leave(ws);
    return r;
  };

  const handlers = {
    // 打开某个目录（上次用的会话 > 这个目录里已有的进程 > 新会话）
    async attach({ cwd, sessionFile }, ctx) {
      return present(await openDir(path.resolve(cwd), sessionFile), ctx);
    },
    // 没有进程的会话只读文件；目录不存在的只读显示（detached）
    async open_session({ file }, ctx) {
      return present(await openSession(file), ctx);
    },
    // 新会话：先不起进程，原来的会话不受影响
    async create_session({ cwd }, ctx) {
      return present(await createSession(path.resolve(cwd), ws), ctx);
    },
    // “只看”的会话要真正用了（发消息、换模型、开始打字……）：起进程并连上
    async ensure_agent({ cwd, file }, ctx) {
      return attachWs(ws, await ensureAgent(path.resolve(cwd), file || null), ctx);
    },
    // 前端已经切走了（比如进程还没起好就点了别的会话）：不再看这个进程
    async leave({ agentId }) {
      if (ws.agentId === agentId) leave(ws);
      return {};
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
      if (!readOnly && a.conversationBusy && !['abort', 'abort_bash', 'abort_retry', 'clear_queue'].includes(cmd.type)) throw new Error('正在处理会话操作，请稍等');
      if (cmd.type === 'get_web_snapshot') return { success: true, data: await a.conversation({ op: 'snapshot', includeMessages: !cmd.metadataOnly }) };
      if (['web_navigate', 'web_label', 'web_edit', 'web_restore_selection'].includes(cmd.type)) {
        if (ws.agentId !== a.id) throw new Error('请先打开这个会话');
        if (a.running) throw new Error('pi 正在运行，先停止或等它结束');
        if (cmd.type === 'web_edit') {
          if (typeof cmd.message !== 'string' || (!cmd.message.trim() && !cmd.images?.length)) throw new Error('消息不能为空');
          if (cmd.images !== undefined && (!Array.isArray(cmd.images) || cmd.images.some((im) => im?.type !== 'image' || typeof im.data !== 'string' || typeof im.mimeType !== 'string'))) throw new Error('图片格式无效');
        }
        a.conversationBusy = true;
        let moved;
        const publish = async () => {
          const snapshot = await a.conversation({ op: 'snapshot' });
          // Send the new prefix before starting generation, so viewers cannot mix
          // old-path history with new-path streaming events.
          for (const c of watchers(a)) send(c, { t: 'branch_changed', agentId: a.id, kind: cmd.type, snapshot });
          return snapshot;
        };
        try {
          moved = await a.conversation({ op: cmd.type === 'web_label' ? 'label' : cmd.type === 'web_restore_selection' ? 'restore-selection' : 'navigate', targetId: cmd.targetId, expectedLeafId: cmd.expectedLeafId, label: cmd.label, requireUser: cmd.type === 'web_edit' });
          await publish();
          if (cmd.type === 'web_edit') {
            if (a.owner !== ws.cid || ws.agentId !== a.id) throw new Error('操作权或当前会话已经改变，已取消重发');
            const accepted = await a.request({ type: 'prompt', message: cmd.message, ...(cmd.images?.length ? { images: cmd.images } : {}) });
            if (!accepted.success) throw new Error(accepted.error || '重新发送失败');
          }
          return { success: true, data: moved };
        } catch (error) {
          if (cmd.type === 'web_edit' && moved) {
            try {
              await a.conversation({ op: 'navigate', targetId: moved.rollbackId || cmd.expectedLeafId, expectedLeafId: moved.leafId });
              await publish();
            } catch { error.message += '；当前位置可能已经改变，修改草稿仍保留'; }
          }
          throw error;
        } finally {
          a.conversationBusy = false;
        }
      }
      // Manual shell/compaction/session replacement must not overlap a branch move.
      const exclusive = ['bash', 'compact', 'fork', 'clone', 'new_session', 'switch_session'].includes(cmd.type);
      if (exclusive) a.conversationBusy = true;
      let res;
      try { res = await a.request(cmd); }
      finally { if (exclusive) a.conversationBusy = false; }
      if (cmd.type === 'get_available_models' && res.success && res.data?.models) {
        const { getSupportedThinkingLevels } = await modelModules;
        res.data.models = res.data.models.map((m) => ({ ...m, thinkingLevels: getSupportedThinkingLevels(m) }));
      }
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
      a.quiet = true;
      await a.stop();
      return {};
    },
    // 进程面板上的“强行关闭”：不看操作权、不等这一轮跑完，直接把这个 pi 进程关掉（会话文件不删）
    async force_stop({ agentId }) {
      const a = agents.get(agentId);
      if (!a) return {};
      a.quiet = true;
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
const STARTED_AT = Date.now();
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `端口 ${PORT} 已被占用` : e.message);
  process.exit(1);
});
// 模块冷加载放在服务启动阶段，后续查询只需读取本地文件。
await modelModules;
server.listen(PORT, HOST, () => {
  // 记下正在运行的服务，`seed-pi-web status/stop` 靠它找到这个进程
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, port: PORT, host: HOST, startedAt: STARTED_AT }, null, 2));
  } catch {}
  const displayHost = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST.includes(':') ? `[${HOST}]` : HOST;
  console.log(`seed-pi-web 已启动：http://${displayHost}:${PORT}/?token=${encodeURIComponent(TOKEN)}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // 只删自己写的状态文件（别把另一个实例的删了）
  if (readState()?.pid === process.pid) fs.rmSync(STATE_FILE, { force: true });
  setTimeout(() => process.exit(0), 5000).unref(); // pi 进程关不掉也别一直等
  terms.closeAll();
  await Promise.all([...agents.values()].map((a) => a.stop().catch(() => {})));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
