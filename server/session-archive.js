// 归档只保存会话文件的标记，不改 JSONL，也不影响会话进程。
import fs from 'node:fs/promises';
import path from 'node:path';
import { isInside } from './sessions.js';

export const archiveKey = (file) => {
  const key = path.resolve(file).replace(/\\/g, '/');
  return process.platform === 'win32' ? key.toLowerCase() : key;
};

export function createSessionArchive(file) {
  let saved;
  let loading;
  let queue = Promise.resolve();
  async function read() {
    if (saved) return saved;
    if (!loading) loading = (async () => {
      try {
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!Array.isArray(data) || !data.every((p) => typeof p === 'string')) throw new Error('归档记录格式不正确');
        saved = new Set(data.map(archiveKey));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        saved = new Set();
      }
      return saved;
    })().catch((e) => { loading = null; throw e; });
    return loading;
  }
  return {
    async read() {
      await queue;
      return new Set(await read());
    },
    set(session, archived) {
      // 串行 + 临时文件替换：并发归档不丢记录，写盘失败不改变内存状态。
      const task = queue.then(async () => {
        const next = new Set(await read());
        const key = archiveKey(session);
        if (next.has(key) === archived) return;
        if (archived) next.add(key);
        else next.delete(key);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temp = file + '.tmp';
        try {
          await fs.writeFile(temp, JSON.stringify([...next], null, 2) + '\n', 'utf8');
          await fs.rename(temp, file);
        } finally {
          await fs.rm(temp, { force: true }).catch(() => {});
        }
        saved = next;
      });
      queue = task.catch(() => {});
      return task;
    },
  };
}

// 归档和星标都是“给会话文件打标记”，只是字段名和存储文件不同。
function registerSessionMark(app, wrap, { route, field, label, store, roots, changed }) {
  app.post(route, wrap(async (req, res) => {
    const file = req.body?.file;
    const value = req.body?.[field];
    if (typeof file !== 'string' || !path.isAbsolute(file) || !file.endsWith('.jsonl') || !isInside(file, await roots())) throw new Error(`不允许${label}这个文件`);
    if (typeof value !== 'boolean') throw new Error(`${label}状态必须是布尔值`);
    if (!(await fs.stat(file)).isFile()) throw new Error('不是会话文件');
    await store.set(file, value);
    changed({ file, [field]: value });
    res.json({ ok: true, file, [field]: value });
  }));
}

export function registerSessionArchive(app, wrap, { archive, roots, changed }) {
  registerSessionMark(app, wrap, { route: '/api/sessions/archive', field: 'archived', label: '归档', store: archive, roots, changed });
}

export function registerSessionStar(app, wrap, { stars, roots, changed }) {
  registerSessionMark(app, wrap, { route: '/api/sessions/star', field: 'starred', label: '星标', store: stars, roots, changed });
}