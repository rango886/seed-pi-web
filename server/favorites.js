// 收藏的目录：一个有顺序的路径数组，存在数据目录里（~/.seed-pi-web/favorites.json），
// 这样换浏览器、换电脑打开网页看到的都是同一份。
import fs from 'node:fs/promises';
import path from 'node:path';

const fold = (p) => {
  const k = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? k.toLowerCase() : k;
};

/** 只留非空字符串，按路径去重（Windows 不分大小写），保持原来的先后顺序 */
export function cleanFavorites(list) {
  if (!Array.isArray(list)) throw new Error('收藏列表必须是数组');
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (typeof p !== 'string' || !p.trim()) continue;
    const k = fold(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

export function createFavorites(file) {
  let queue = Promise.resolve();
  return {
    async read() {
      await queue;
      try {
        return cleanFavorites(JSON.parse(await fs.readFile(file, 'utf8')));
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
    },
    /** 整份替换：收藏、取消、拖动排序都是前端算好新数组再发过来。串行写 + 临时文件替换，不会写一半 */
    write(list) {
      const next = cleanFavorites(list);
      const task = queue.then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temp = file + '.tmp';
        try {
          await fs.writeFile(temp, JSON.stringify(next, null, 2) + '\n', 'utf8');
          await fs.rename(temp, file);
        } finally {
          await fs.rm(temp, { force: true }).catch(() => {});
        }
        return next;
      });
      queue = task.catch(() => {});
      return task;
    },
  };
}

export function registerFavorites(app, wrap, { favorites, changed }) {
  app.get('/api/favorites', wrap(async (req, res) => res.json({ list: await favorites.read() })));
  app.post('/api/favorites', wrap(async (req, res) => {
    const list = await favorites.write(req.body?.list);
    changed(list);
    res.json({ list });
  }));
}
