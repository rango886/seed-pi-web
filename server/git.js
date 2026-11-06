// 只读 Git：所有参数直接传给 git，不经过 shell，不运行外部 diff / textconv。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { structuredPatch } from 'diff';

const exec = promisify(execFile);
const LIMIT = 2 * 1024 * 1024;
const cache = new Map();
async function git(cwd, args) {
  const { stdout } = await exec('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args], {
    cwd, encoding: 'buffer', timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
}
const text = (b) => b.toString('utf8');
const inside = (root, p) => {
  const r = path.relative(root, p);
  return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r));
};

// 固定字段按空格分开，最后的路径保留所有空格、换行；重命名的旧路径是下一个 NUL 记录。
export function parseStatus(output) {
  const records = output.split('\0');
  const result = { branch: '', oid: '', ahead: 0, behind: 0, entries: [], ignored: [] };
  for (let i = 0; i < records.length; i++) {
    const s = records[i];
    if (s.startsWith('# branch.head ')) result.branch = s.slice(14);
    else if (s.startsWith('# branch.oid ')) result.oid = s.slice(13);
    else if (s.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(s);
      if (m) [result.ahead, result.behind] = [Number(m[1]), Number(m[2])];
    } else if (s.startsWith('! ')) result.ignored.push(s.slice(2).replace(/\/$/, ''));
    else if (s.startsWith('? ')) result.entries.push({ path: s.slice(2), x: '?', y: '?', status: 'U', sub: 'N...' });
    else if (/^[12u] /.test(s)) {
      const count = s[0] === '1' ? 8 : s[0] === '2' ? 9 : 10;
      let pos = 0;
      const fields = [];
      for (let n = 0; n < count; n++) {
        const end = s.indexOf(' ', pos);
        fields.push(s.slice(pos, end));
        pos = end + 1;
      }
      const [, xy, sub] = fields;
      const conflict = s[0] === 'u';
      result.entries.push({ path: s.slice(pos), oldPath: s[0] === '2' ? records[++i] : undefined,
        x: xy[0], y: xy[1], sub, conflict, status: conflict ? '!' : xy[1] !== '.' ? xy[1] : xy[0] !== '.' ? xy[0] : sub.startsWith('S') ? 'M' : '.' });
    }
  }
  return result;
}

async function status(cwd) {
  let root;
  try {
    root = text(await git(cwd, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '');
  } catch (e) {
    if (e.code === 'ENOENT') return { available: false, message: '未安装 Git，文件浏览仍可使用', entries: [], ignored: [] };
    const message = text(e.stderr || Buffer.from(e.message));
    if (/not a git repository|must be run in a work tree/.test(message)) return { available: false, entries: [], ignored: [] };
    throw new Error(message.trim());
  }
  const d = parseStatus(text(await git(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignored=matching'])));
  if (d.branch === '(detached)') d.branch = `分离 HEAD · ${d.oid.slice(0, 8)}`;
  // 列表展示整个所属仓库；文件树仍然从用户的当前工作目录展开。
  return { available: true, root, ...d };
}

export function gitStatus(cwd, fresh = false) {
  cwd = path.resolve(cwd);
  const prev = cache.get(cwd);
  if (prev && (prev.pending || (!fresh && Date.now() - prev.time < 1200))) return prev.promise;
  const item = { time: Date.now(), pending: true };
  item.promise = status(cwd).finally(() => { item.pending = false; });
  cache.set(cwd, item);
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  item.promise.catch(() => { if (cache.get(cwd) === item) cache.delete(cwd); });
  return item.promise;
}

// 顶栏只要分支名：不跑完整的 status，两条很便宜的命令就够。不是仓库 / 没装 Git 都返回空
export async function gitBranch(cwd) {
  cwd = path.resolve(cwd);
  try {
    // symbolic-ref 在还没提交过的新仓库里也能拿到分支名
    return { branch: text(await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim() };
  } catch {}
  try {
    const oid = text(await git(cwd, ['rev-parse', '--short', 'HEAD'])).trim();
    return { branch: oid ? `分离 HEAD · ${oid}` : '', detached: true };
  } catch {
    return { branch: '' };
  }
}

async function blob(root, spec, missing = false) {
  let size;
  try {
    size = Number(text(await git(root, ['cat-file', '-s', spec])).trim());
  } catch (e) {
    if (missing && e.code === 128) return Buffer.alloc(0);
    throw e;
  }
  if (size > LIMIT) return null;
  return git(root, ['cat-file', 'blob', spec]);
}

async function disk(root, file) {
  // 不沿中间的符号链接读取仓库外文件；叶子符号链接比较的是链接文字，而不是目标内容。
  const rel = path.relative(root, file);
  let p = root;
  const parts = rel.split(path.sep);
  for (let i = 0; i < parts.length - 1; i++) {
    p = path.join(p, parts[i]);
    const st = await fs.lstat(p).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    if (st?.isSymbolicLink()) throw new Error('不能通过符号链接目录读取 Git 对比');
    if (!st?.isDirectory()) return Buffer.alloc(0);
  }
  const st = await fs.lstat(file).catch((e) => { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; });
  if (!st) return Buffer.alloc(0);
  if (st.isSymbolicLink()) return Buffer.from(await fs.readlink(file));
  if (!st.isFile()) throw new Error('目录或子模块不支持文本对比');
  if (st.size > LIMIT) return null;
  const fh = await fs.open(file, 'r');
  try {
    const b = Buffer.alloc(LIMIT + 1);
    let len = 0;
    while (len < b.length) {
      const { bytesRead } = await fh.read(b, len, b.length - len, null);
      if (!bytesRead) break;
      len += bytesRead;
    }
    return len > LIMIT ? null : b.subarray(0, len);
  } finally { await fh.close(); }
}

export async function gitDiff(cwd, file, mode = 'working') {
  if (!['staged', 'working', 'head'].includes(mode)) throw new Error('无效的对比模式');
  const d = await gitStatus(cwd, true);
  if (!d.available) throw new Error(d.message || '当前目录不属于 Git 仓库');
  const abs = path.resolve(file);
  if (!inside(d.root, abs) || abs === d.root) throw new Error('文件不在当前仓库内');
  const rel = path.relative(d.root, abs).split(path.sep).join('/');
  if (rel.split('/').includes('.git')) throw new Error('不能对比 Git 内部文件');
  const equal = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const entry = d.entries.find((e) => equal(path.resolve(d.root, e.path), abs));
  if (entry?.conflict && mode === 'staged') return { message: '这个文件存在合并冲突，没有完整的暂存版本；请查看未暂存对比。', hunks: [] };
  if (entry?.sub?.startsWith('S')) return { message: '子模块状态已变化；请进入子模块目录查看内部变更。', hunks: [] };
  const oldRel = entry?.oldPath || rel;
  let before, after;
  let oldLabel, newLabel;
  if (mode === 'staged') {
    before = d.oid === '(initial)' ? Buffer.alloc(0) : await blob(d.root, `HEAD:${entry?.x === 'R' || entry?.x === 'C' ? oldRel : rel}`, entry?.x === 'A' || entry?.x === '?');
    after = await blob(d.root, `:${rel}`, entry?.x === 'D' || entry?.x === '?');
    oldLabel = '上次提交'; newLabel = '暂存区';
  } else {
    if (mode === 'head') {
      before = d.oid === '(initial)' ? Buffer.alloc(0) : await blob(d.root, `HEAD:${entry?.x === 'R' || entry?.x === 'C' ? oldRel : rel}`, entry?.x === 'A' || entry?.x === '?');
      oldLabel = '上次提交';
    } else if (entry?.conflict) {
      before = await blob(d.root, `:2:${rel}`, true);
      oldLabel = '冲突：当前一侧（ours）';
    } else {
      before = await blob(d.root, `:${entry?.y === 'R' ? oldRel : rel}`, entry?.x === '?' || entry?.x === 'D');
      oldLabel = '暂存区';
    }
    after = await disk(d.root, abs);
    newLabel = '工作区';
  }
  const beforePath = mode === 'working' ? (entry?.y === 'R' ? oldRel : rel) : oldRel;
  const result = { oldPath: beforePath, path: rel, oldLabel, newLabel, conflict: !!entry?.conflict, hunks: [] };
  if (before === null || after === null) return { ...result, message: '文件超过 2MB，不生成文本对比。' };
  if (before.subarray(0, 8000).includes(0) || after.subarray(0, 8000).includes(0)) return { ...result, message: '二进制文件，不支持文本对比。' };
  // Git 仓库与 Windows 工作区的换行可能不同，不把单纯 CRLF 差异当成整文件修改。
  const a = text(before).replace(/\r\n/g, '\n');
  const b = text(after).replace(/\r\n/g, '\n');
  if (a.split('\n').length + b.split('\n').length > 60000) return { ...result, message: '文件行数过多，不生成文本对比。' };
  const patch = structuredPatch(oldRel, rel, a, b, '', '', { context: 3, timeout: 1500, maxEditLength: 20000 });
  if (!patch) return { ...result, message: '差异过大，已停止生成对比。' };
  return { ...result, hunks: patch.hunks };
}
