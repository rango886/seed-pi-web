// 目录 ZIP 先写临时文件：生成失败可返回 JSON，下载时流式传输，不把整个 ZIP 放进内存。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';

const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const DEPENDENCIES = new Set(['node_modules', '.venv', 'venv', '__pycache__']);

export async function createDirectoryZip(directory, { omitDependencies = false, signal } = {}) {
  const root = await fsp.realpath(directory);
  if (!(await fsp.stat(root)).isDirectory()) throw new Error('这不是一个目录');
  if (path.basename(root).toLowerCase() === '.git') throw new Error('不打包 Git 内部目录');
  const items = [];
  let bytes = 0;
  let skippedLinks = 0;
  const top = path.basename(root) || 'directory';
  async function walk(dir, rel, depth) {
    signal?.throwIfAborted();
    if (depth > 64) throw new Error('目录层级过深，无法打包');
    items.push({ dir: true, name: rel + '/' });
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (e.name.toLowerCase() === '.git' || (omitDependencies && DEPENDENCIES.has(e.name))) continue;
      const file = path.join(dir, e.name);
      const st = await fsp.lstat(file);
      if (st.isSymbolicLink()) { skippedLinks++; continue; }
      if (st.isDirectory()) await walk(file, rel + '/' + e.name, depth + 1);
      else if (st.isFile()) {
        bytes += st.size;
        items.push({ file, name: rel + '/' + e.name, stat: st });
      }
      if (items.length > MAX_ENTRIES) throw new Error('目录条目超过 20000，请选择更小的目录');
      if (bytes > MAX_BYTES) throw new Error('目录内容超过 1GB，请缩小范围或排除依赖目录');
    }
  }
  await walk(root, top, 0);
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'seed-pi-zip-'));
  const file = path.join(temp, 'archive.zip');
  const cleanup = () => fsp.rm(temp, { recursive: true, force: true });
  const zip = new yazl.ZipFile();
  const output = fs.createWriteStream(file);
  zip.on('error', (e) => zip.outputStream.destroy(e));
  let saving;
  try {
    saving = pipeline(zip.outputStream, output, { signal });
    // Attach a handler immediately, even if preparing entries throws synchronously.
    saving.catch(() => {});
    for (const item of items) {
      if (item.dir) zip.addEmptyDirectory(item.name);
      else zip.addReadStreamLazy(item.name, { size: item.stat.size, mtime: item.stat.mtime, mode: item.stat.mode }, (cb) => {
        // O_NOFOLLOW protects leaf symlinks on platforms that support it.
        fsp.realpath(item.file).then((real) => {
          const rel = path.relative(root, real);
          if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) throw new Error('文件指向打包目录外部');
          cb(null, fs.createReadStream(item.file, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) }));
        }).catch(cb);
      });
    }
    zip.end();
    await saving;
    return { file, name: top + '.zip', bytes, skippedLinks, cleanup };
  } catch (e) {
    zip.outputStream.destroy();
    output.destroy();
    await saving?.catch(() => {});
    await cleanup();
    throw e;
  }
}

export function registerDownloads(app, wrap) {
  const ready = new Map();
  app.post('/api/fs/archive', wrap(async (req, res) => {
    if (typeof req.body?.path !== 'string' || !req.body.path) throw new Error('缺少目录路径');
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    const timer = setTimeout(() => controller.abort(new Error('打包超过 2 分钟，请选择更小的目录')), 120000);
    res.on('close', abort);
    let archive;
    try {
      archive = await createDirectoryZip(path.resolve(req.body.path), { omitDependencies: req.body.omitDependencies === true, signal: controller.signal });
      controller.signal.throwIfAborted();
      const id = randomUUID();
      const expiry = setTimeout(() => { ready.delete(id); archive.cleanup().catch(() => {}); }, 10 * 60 * 1000);
      expiry.unref();
      ready.set(id, { ...archive, expiry });
      res.json({ id, name: archive.name, skippedLinks: archive.skippedLinks });
    } catch (e) {
      if (archive) await archive.cleanup();
      throw e;
    } finally {
      clearTimeout(timer);
      res.off('close', abort);
    }
  }));
  app.get('/api/fs/archive/:id', (req, res) => {
    const item = ready.get(req.params.id);
    if (!item) return res.status(404).json({ error: '下载已过期，请重新打包' });
    // 一次性下载，断开连接也清理临时文件。
    ready.delete(req.params.id);
    clearTimeout(item.expiry);
    res.download(item.file, item.name, (err) => {
      item.cleanup().catch(() => {});
      if (err && !res.headersSent) res.status(500).end('下载失败，请重新打包');
    });
  });
}
