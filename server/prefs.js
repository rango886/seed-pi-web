// 网页的偏好设置：以前在浏览器 localStorage 里的那些 seed-pi-web-* 键（界面设置、会话列表怎么看、侧栏宽度、输入历史…），
// 现在统一存在数据目录里（~/.seed-pi-web/prefs.json），局域网里哪台设备打开都是同一份。
// 存的就是一个 { 键: 字符串 } 的对象，值原样保存，后端不关心里面是什么。
// 访问令牌不在这里：网页要先拿着令牌才能来读这份设置，所以令牌只能留在浏览器里。
import fs from 'node:fs/promises';
import path from 'node:path';

export const LOCAL_ONLY = new Set(['seed-pi-web-token']);
const okKey = (k) => typeof k === 'string' && k.startsWith('seed-pi-web-') && !LOCAL_ONLY.has(k);

/** 只留 seed-pi-web-* 开头、值是字符串的键 */
export function cleanPrefs(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('设置必须是一个对象');
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (okKey(k) && typeof v === 'string') out[k] = v;
  return out;
}

export function createPrefs(file) {
  let saved = null;
  let queue = Promise.resolve();
  async function load() {
    if (saved) return saved;
    try {
      saved = cleanPrefs(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      saved = {};
    }
    return saved;
  }
  // 串行 + 临时文件替换：几个标签页同时改也不会丢键、不会写一半
  function commit(build) {
    const task = queue.then(async () => {
      const next = await build({ ...(await load()) });
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = file + '.tmp';
      try {
        await fs.writeFile(temp, JSON.stringify(next, null, 2) + '\n', 'utf8');
        await fs.rename(temp, file);
      } finally {
        await fs.rm(temp, { force: true }).catch(() => {});
      }
      saved = next;
      return { ...next };
    });
    queue = task.catch(() => {});
    return task;
  }
  return {
    async read() {
      await queue;
      return { ...(await load()) };
    },
    /** 增量修改：set 里的键写进去，remove 里的键删掉。只动提到的键，别的标签页改的其他键不受影响 */
    patch({ set = {}, remove = [] } = {}) {
      const add = cleanPrefs(set);
      if (!Array.isArray(remove)) throw new Error('remove 必须是数组');
      return commit((cur) => {
        for (const k of remove) if (okKey(k)) delete cur[k];
        return Object.assign(cur, add);
      });
    },
    /** 整份替换（导入备份用） */
    replace(obj) {
      const next = cleanPrefs(obj);
      return commit(() => next);
    },
  };
}

export function registerPrefs(app, wrap, { prefs }) {
  app.get('/api/prefs', wrap(async (req, res) => res.json(await prefs.read())));
  app.post('/api/prefs', wrap(async (req, res) => {
    await prefs.patch(req.body || {});
    res.json({ ok: true });
  }));
}
