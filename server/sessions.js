// 读取 pi 的会话文件（JSONL），给历史面板用。
// 只依赖文档里的会话文件格式：第一行是 header，后面是 entry。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

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

const cache = new Map(); // file -> {mtimeMs, size, info}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c.type === 'text').map((c) => c.text).join(' ');
  return '';
}

async function parseSession(file, st) {
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.info;
  const raw = await fs.readFile(file, 'utf8');
  const lines = raw.split('\n');
  let header = null;
  let firstUser = '';
  let name = null;
  let messages = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!header && e.type === 'session') {
      header = e;
      continue;
    }
    if (e.type === 'session_info') name = e.name || null;
    if (e.type === 'message' && e.message) {
      const role = e.message.role;
      if (role === 'user' || role === 'assistant') messages++;
      if (!firstUser && role === 'user') firstUser = textOf(e.message.content).slice(0, 200);
    }
  }
  if (!header) return null;
  const info = {
    file,
    id: header.id,
    cwd: header.cwd || '',
    created: header.timestamp,
    modified: new Date(st.mtimeMs).toISOString(),
    name,
    title: name || firstUser || '(空会话)',
    messages,
    parentSession: header.parentSession || null,
  };
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, info });
  return info;
}

async function walk(dir, depth, out) {
  let ents;
  try {
    ents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory() && depth > 0) await walk(p, depth - 1, out);
    else if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(p);
  }
}

export const samePath = (a, b) => {
  const n = (p) => path.resolve(p || '').replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

export async function listSessions({ cwd, roots }) {
  const files = [];
  for (const r of roots) await walk(r, 1, files);
  const list = [];
  await Promise.all(
    [...new Set(files)].map(async (f) => {
      try {
        const st = await fs.stat(f);
        const info = await parseSession(f, st);
        if (info && (!cwd || samePath(info.cwd, cwd))) list.push(info);
      } catch {}
    }),
  );
  list.sort((a, b) => (a.modified < b.modified ? 1 : -1));
  return list;
}

export async function recentDirs(roots) {
  const all = await listSessions({ roots });
  const seen = new Map();
  for (const s of all) {
    if (!s.cwd) continue;
    const key = process.platform === 'win32' ? s.cwd.toLowerCase() : s.cwd;
    if (!seen.has(key)) seen.set(key, { cwd: s.cwd, modified: s.modified, count: 0 });
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
