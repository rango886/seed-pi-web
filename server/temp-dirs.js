// 临时会话的目录：侧栏点「临时聊」时，在设置里指定的根目录下新建一个文件夹，会话就开在里面。
// 空文件夹的清理：只清这里自己建过的（记在 temp-dirs.json 里），而且要同时满足——
//   里面是空的、建了超过 1 天、没有任何 pi 会话用它当工作目录、也没有正在跑的 pi 进程在用它。
// 光聊天不写文件的临时会话，文件夹也是空的，但有会话记录指着它，所以不会被删。
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expandPath } from './attachments.js';
import { HOME_DIR } from './config.js';
import { samePath } from './sessions.js';

export const TEMP_ROOT_DEFAULT = '{data}/temp';
export const TEMP_NAME_DEFAULT = '{date}_{time}';
const REGISTRY = path.join(HOME_DIR, 'temp-dirs.json');
const STALE_MS = 24 * 60 * 60 * 1000;

const p2 = (n) => String(n).padStart(2, '0');

/** 根目录模板 → 绝对路径。{tmp} 系统临时目录、{home} 用户目录、{data} seed-pi-web 的数据目录（默认 ~/.seed-pi-web） */
export function resolveTempRoot(template) {
  return expandPath(template, { tmp: os.tmpdir(), home: os.homedir(), data: HOME_DIR }, { base: os.homedir(), fallback: TEMP_ROOT_DEFAULT });
}

/** 文件夹名模板 → 一个合法的文件夹名。{date} 2025-06-01、{time} 143022、{rand} 4 位随机字符 */
export function tempDirName(template, now = new Date()) {
  const vars = {
    date: `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`,
    time: `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`,
    rand: Math.random().toString(36).slice(2, 6).padEnd(4, '0'),
  };
  const raw = (String(template || '').trim() || TEMP_NAME_DEFAULT).replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
  // 只要一层文件夹：路径分隔符和系统不允许的字符都换成 _，结尾的点和空格 Windows 也不认
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 120);
  return name && !/^\.+$/.test(name) ? name : tempDirName(TEMP_NAME_DEFAULT, now);
}

async function readRegistry() {
  try {
    const list = JSON.parse(await fsp.readFile(REGISTRY, 'utf8'));
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}
async function writeRegistry(list) {
  await fsp.mkdir(HOME_DIR, { recursive: true });
  await fsp.writeFile(REGISTRY, JSON.stringify(list, null, 2));
}

// 登记和清理都是“读-改-写”同一个文件，串起来跑，免得两个请求互相覆盖
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

/** 在根目录下建一个新文件夹（重名就加 -1、-2…），返回它的绝对路径 */
export function createTempDir({ root, name }) {
  return serial(async () => {
    const base = resolveTempRoot(root);
    if (base === path.parse(base).root) throw new Error('临时目录不能直接放在磁盘根目录');
    await fsp.mkdir(base, { recursive: true });
    const stem = tempDirName(name);
    for (let i = 0; i < 1000; i++) {
      const dir = path.join(base, i ? `${stem}-${i}` : stem);
      try {
        await fsp.mkdir(dir); // 不带 recursive：已经存在会报 EEXIST，正好用来判断重名
      } catch (e) {
        if (e.code === 'EEXIST') continue;
        throw e;
      }
      await writeRegistry([...(await readRegistry()), dir]);
      return dir;
    }
    throw new Error('同名文件夹太多了，换个文件夹名模板试试');
  });
}

/**
 * 清理没用上的空文件夹。inUse(dir) 返回 true 表示还有会话 / 进程在用，不能删。
 * 已经不存在的也顺手从登记表里去掉。
 */
export function cleanupTempDirs(inUse) {
  return serial(async () => {
    const list = await readRegistry();
    if (!list.length) return [];
    const keep = [];
    const removed = [];
    for (const dir of list) {
      const st = await fsp.stat(dir).catch(() => null);
      if (!st?.isDirectory()) continue; // 被删掉或者被换成文件了：不再管它
      const empty = (await fsp.readdir(dir).catch(() => ['?'])).length === 0;
      if (!empty || Date.now() - st.mtimeMs < STALE_MS || (await inUse(dir))) {
        keep.push(dir);
        continue;
      }
      try {
        await fsp.rmdir(dir); // rmdir 只删空目录，万一这一刻里面多了东西就会失败，不会误删
        removed.push(dir);
      } catch {
        keep.push(dir);
      }
    }
    if (keep.length !== list.length) await writeRegistry(keep);
    return removed;
  });
}

/** 某个路径是不是在 dirs 里（Windows 不分大小写） */
export const listHas = (dirs, dir) => dirs.some((d) => d && samePath(d, dir));
