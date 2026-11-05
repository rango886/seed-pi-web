// 读取 pi 的会话文件（JSONL），给历史面板用。
// 只依赖文档里的会话文件格式：第一行是 header，后面是 entry。
//
// 性能要点（会话文件加起来可能上 GB）：
// 1. 先只读每个文件的第一行（header）拿到 cwd，按目录过滤，只深入扫描需要的文件
// 2. 深入扫描时按字节流式读，只看每行开头几百字节判断类型，不对大行做 JSON.parse
// 3. 会话文件只会往后追加：记住扫到的字节位置，下次只读新增部分
// 4. 扫描结果存到磁盘缓存，后端重启后不用重新扫一遍
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { branchOf, conversationOf, selectionOf, usageOf } from './conversation.js';

export function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
}

/** 可能存放会话的根目录（环境变量 > settings.json > 默认） */
export async function sessionRoots(extra = []) {
  const roots = new Set();
  if (process.env.PI_CODING_AGENT_SESSION_DIR) roots.add(path.resolve(process.env.PI_CODING_AGENT_SESSION_DIR));
  try {
    const s = JSON.parse(await fs.readFile(path.join(agentDir(), 'settings.json'), 'utf8'));
    if (typeof s.sessionDir === 'string' && path.isAbsolute(s.sessionDir.replace(/^~/, os.homedir()))) {
      roots.add(path.resolve(s.sessionDir.replace(/^~/, os.homedir())));
    }
  } catch {}
  roots.add(path.join(agentDir(), 'sessions'));
  for (const r of extra) if (r) roots.add(path.resolve(r));
  return [...roots];
}

// ---------- 缓存：file -> { size, mtimeMs, head, body } ----------
// head: { id, cwd, created, parentSession }（header 不会变）
// body: { offset, name, firstUser, messages }（offset = 已扫描到的字节位置，总在换行符之后）
const CACHE_FILE = path.join(os.tmpdir(), 'seed-pi-web-sessions-cache-v2.json'); // v2：标题里去掉了 <attachments> 块
const cache = new Map();
try {
  const saved = JSON.parse(fsSync.readFileSync(CACHE_FILE, 'utf8'));
  for (const [k, v] of Object.entries(saved)) cache.set(k, v);
} catch {}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await fs.writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(cache)));
    } catch {}
  }, 2000);
  saveTimer.unref?.();
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c.type === 'text').map((c) => c.text).join(' ');
  return '';
}

// 网页发消息时拼的附件路径块：当会话标题时去掉，只剩附件的话就列文件名
function titleOf(text) {
  const names = [];
  const rest = text.replace(/<attachments>([\s\S]*?)<\/attachments>/g, (_, body) => {
    for (const m of body.matchAll(/^\[\d+\]\s+\w+:\s+(.+)$/gm)) names.push(m[1].trim().split(/[\\/]/).filter(Boolean).pop());
    return ' ';
  });
  const t = rest.replace(/\s+/g, ' ').trim();
  return t || (names.length ? `[附件] ${names.join(', ')}` : '');
}

/** 限制并发：同时打开太多大文件会把内存和磁盘都挤爆 */
async function mapLimit(items, limit, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function readHead(file) {
  const fh = await fs.open(file, 'r');
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0);
    const buf = buffer.subarray(0, bytesRead);
    const nl = buf.indexOf(10);
    const e = JSON.parse(buf.subarray(0, nl < 0 ? buf.length : nl).toString('utf8'));
    if (e.type !== 'session') return null;
    return { id: e.id, cwd: e.cwd || '', created: e.timestamp, parentSession: e.parentSession || null };
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

const TYPE_RE = /^\{"type":"([^"]+)"/;
const ROLE_RE = /"message":\{"role":"([^"]+)"/;

/** 处理一行（Buffer）。只看开头判断类型，需要内容时才完整解析 */
function scanLine(line, body) {
  if (line.length < 2) return;
  const head = line.subarray(0, 600).toString('utf8');
  let type = TYPE_RE.exec(head)?.[1];
  let parsed = null;
  const parse = () => {
    if (parsed === null) {
      try {
        parsed = JSON.parse(line.toString('utf8'));
      } catch {
        parsed = false;
      }
    }
    return parsed;
  };
  if (!type) type = parse()?.type; // 字段顺序和预期不一样：老老实实解析
  if (type === 'session_info') {
    const e = parse();
    if (e) body.name = e.name || null;
  } else if (type === 'message') {
    let role = ROLE_RE.exec(head)?.[1];
    if (!role) role = parse()?.message?.role;
    if (role === 'user' || role === 'assistant') body.messages++;
    if (role === 'user' && !body.firstUser) {
      const e = parse();
      if (e) body.firstUser = titleOf(textOf(e.message?.content)).slice(0, 200);
    }
  }
}

const CHUNK = 4 * 1024 * 1024;
/** 从 body.offset 开始往后扫，扫到最后一个完整的行为止 */
async function scanBody(file, size, prev) {
  const body = prev ? { ...prev } : { offset: 0, name: null, firstUser: '', messages: 0 };
  const fh = await fs.open(file, 'r');
  try {
    let pos = body.offset;
    let parts = []; // 跨块的未完整行
    const buf = Buffer.alloc(CHUNK);
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos);
      if (!bytesRead) break;
      const chunk = buf.subarray(0, bytesRead);
      let start = 0;
      let nl;
      while ((nl = chunk.indexOf(10, start)) !== -1) {
        const piece = chunk.subarray(start, nl);
        const line = parts.length ? Buffer.concat([...parts, piece]) : piece;
        parts = [];
        scanLine(line, body);
        start = nl + 1;
        body.offset = pos + start;
      }
      if (start < bytesRead) parts.push(Buffer.from(chunk.subarray(start))); // 复制一份，buf 会被复用
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
  return body;
}

/** 拿到文件的缓存记录，必要时更新 head；deep=true 时连 body 一起更新 */
const inflight = new Map();
async function getEntry(file, deep) {
  const key = `${file}|${deep ? 1 : 0}`;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const st = await fs.stat(file);
    let e = cache.get(file);
    if (e && st.size < (e.body?.offset ?? e.size)) e = null; // 文件变小了：被重写过，从头来
    if (!e || !e.head) {
      const head = await readHead(file);
      if (!head) return null;
      e = { size: st.size, mtimeMs: st.mtimeMs, head, body: null };
      cache.set(file, e);
      scheduleSave();
    }
    if (e.size !== st.size || e.mtimeMs !== st.mtimeMs) {
      e.size = st.size;
      e.mtimeMs = st.mtimeMs;
      scheduleSave();
    }
    if (deep && (!e.body || e.body.offset < st.size)) {
      e.body = await scanBody(file, st.size, e.body);
      scheduleSave();
    }
    return e;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function toInfo(file, e) {
  const b = e.body || { name: null, firstUser: '', messages: 0 };
  return {
    file,
    id: e.head.id,
    cwd: e.head.cwd,
    created: e.head.created,
    modified: new Date(e.mtimeMs).toISOString(),
    name: b.name,
    title: b.name || b.firstUser || '(空会话)',
    messages: b.messages,
    parentSession: e.head.parentSession,
  };
}

async function walk(dir, depth, out) {
  let ents;
  try {
    ents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    ents.map(async (ent) => {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory() && depth > 0) await walk(p, depth - 1, out);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(p);
    }),
  );
}

async function allFiles(roots) {
  const files = [];
  for (const r of roots) await walk(r, 1, files);
  const uniq = [...new Set(files)];
  // 已经不存在的文件从缓存里清掉
  const set = new Set(uniq);
  for (const k of cache.keys()) if (!set.has(k) && roots.some((r) => k.startsWith(r))) cache.delete(k);
  return uniq;
}

export const samePath = (a, b) => {
  const n = (p) => path.resolve(p || '').replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** 读会话文件里的消息（目录已消失时，网页只能只读展示） */
/**
 * 不起 pi 进程，直接从会话文件里读出“打开这个会话时 pi 会给的东西”：
 * 当前分支上的消息、模型、思考强度、会话名、用量统计。
 * 规则照着 pi 的 session-manager 来：最后一条 entry 就是当前位置（leaf），顺着 parentId 往回走就是当前分支；
 * 分支上有压缩的话，压缩之前只留 firstKeptEntryId 开始的那些
 */
export async function readSessionSnapshot(file) {
  const raw = await fs.readFile(file, 'utf8');
  let head = null;
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'session') head ??= e;
    else if (e.id) entries.push(e);
  }
  const branch = branchOf(entries);
  const { model, thinkingLevel } = selectionOf(branch);
  const conversation = conversationOf(entries);

  // 压缩：只留最后一次压缩的摘要 + firstKeptEntryId 起保留下来的 + 压缩之后的
  let picked = branch;
  const ci = branch.findLastIndex((e) => e.type === 'compaction');
  if (ci >= 0) {
    const c = branch[ci];
    const keepFrom = branch.findIndex((e) => e.id === c.firstKeptEntryId);
    const kept = keepFrom >= 0 && keepFrom < ci ? branch.slice(keepFrom, ci).filter((e) => !(e.type === 'message' && e.message?.role === 'system')) : [];
    picked = [c, ...kept, ...branch.slice(ci + 1)];
  }
  const ts = (t) => new Date(t).getTime();
  const messages = [];
  for (const e of picked) {
    if (e.type === 'message' && e.message) {
      const m = e.message;
      messages.push({ ...m, ...(m.content == null && m.role !== 'system' ? { content: [] } : {}), _entryId: e.id });
    } else if (e.type === 'custom_message') {
      messages.push({ role: 'custom', customType: e.customType, content: e.content ?? [], display: e.display, details: e.details, timestamp: ts(e.timestamp) });
    } else if (e.type === 'branch_summary' && e.summary) {
      messages.push({ role: 'branchSummary', summary: e.summary, fromId: e.fromId, timestamp: ts(e.timestamp) });
    } else if (e.type === 'compaction') {
      messages.push({ role: 'compactionSummary', summary: e.summary, tokensBefore: e.tokensBefore, timestamp: ts(e.timestamp) });
    }
  }

  // Actual spend includes every entry once, not the sum of leaf-path totals.
  const totals = usageOf(entries);
  const sessionName = entries.findLast((e) => e.type === 'session_info')?.name || null;
  return {
    cwd: head?.cwd || null,
    messages,
    state: { model, thinkingLevel, sessionName, sessionFile: file, sessionId: head?.id || null, isStreaming: false, isCompacting: false },
    conversation,
    stats: { sessionFile: file, sessionId: head?.id || null, ...totals, branchStats: conversation.branchStats, leafId: conversation.leafId },
  };
}

/** 还没有会话文件的新会话：从 pi 的设置里猜启动时会用哪个模型（全局设置 < 项目里的 .pi/settings.json） */
export async function defaultState(cwd) {
  const s = {};
  for (const f of [path.join(agentDir(), 'settings.json'), path.join(cwd, '.pi', 'settings.json')]) {
    try {
      Object.assign(s, JSON.parse(await fs.readFile(f, 'utf8')));
    } catch {}
  }
  return {
    model: s.defaultProvider && s.defaultModel ? { provider: s.defaultProvider, id: s.defaultModel } : null,
    thinkingLevel: s.defaultThinkingLevel || 'medium',
    sessionName: null,
    sessionFile: null,
    sessionId: null,
    isStreaming: false,
    isCompacting: false,
  };
}

export async function listSessions({ cwd, roots }) {
  const files = await allFiles(roots);
  // 第一步：只读 header，按目录过滤
  const heads = [];
  await mapLimit(files, 32, async (f) => {
    try {
      const e = await getEntry(f, false);
      if (e && (!cwd || samePath(e.head.cwd, cwd))) heads.push(f);
    } catch {}
  });
  // 第二步：只扫描需要的文件（大多命中缓存，只读新增的部分）
  const list = [];
  await mapLimit(heads, 4, async (f) => {
    try {
      const e = await getEntry(f, true);
      if (e) list.push(toInfo(f, e));
    } catch {}
  });
  list.sort((a, b) => (a.modified < b.modified ? 1 : -1));
  return list;
}

/** 最近用过的目录：只需要 header 和修改时间，不用扫描内容 */
export async function recentDirs(roots) {
  const files = await allFiles(roots);
  const all = [];
  await mapLimit(files, 32, async (f) => {
    try {
      const e = await getEntry(f, false);
      if (e?.head.cwd) all.push(e);
    } catch {}
  });
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const seen = new Map();
  for (const e of all) {
    const cwd = e.head.cwd;
    const key = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
    if (!seen.has(key)) seen.set(key, { cwd, modified: new Date(e.mtimeMs).toISOString(), count: 0 });
    seen.get(key).count++;
  }
  return [...seen.values()].slice(0, 30);
}

export function isInside(file, roots) {
  const f = path.resolve(file);
  return roots.some((r) => {
    const rel = path.relative(r, f);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}
