// 附件相关：上传到临时目录、读剪贴板里复制的文件路径、@ 补全用的项目文件列表
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// ---------- 判断请求是不是本机发来的 ----------
const isLoop = (a) => !!a && (a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.'));

/**
 * 只有浏览器和后端在同一台机器上，后端读到的剪贴板才是用户正在用的那个。
 * 走 vite 开发代理时 socket 对端永远是 127.0.0.1，所以代理会带上 x-forwarded-for（vite.config.js 里开了 xfwd），
 * 这时以代理追加的最后一段为准（前面几段客户端可以伪造，最后一段是代理自己写的）
 */
export function isLocalRequest(req) {
  if (!isLoop(req.socket?.remoteAddress || '')) return false;
  const xff = req.headers['x-forwarded-for'];
  if (!xff) return true;
  const last = String(xff).split(',').pop().trim();
  return isLoop(last);
}

// ---------- 剪贴板 ----------
const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', ...opts }, (err, stdout) =>
      resolve(err ? null : String(stdout || '')),
    );
  });

const fromUriList = (s) =>
  (s || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('file://'))
    .map((l) => {
      try {
        return decodeURIComponent(new URL(l).pathname);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

// Windows：每次新起一个 powershell 要 200ms+（冷启动要好几秒），粘贴会明显卡一下。
// 所以第一次用到时起一个常驻的，从 stdin 送命令、输出到结束标记为止；闲置 10 分钟自己关掉
const END = '__PI_WEB_END__';
let ps = null;
let psChain = Promise.resolve();
let psIdle = null;

function startPs() {
  const p = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-STA', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  p.buf = '';
  p.waiter = null;
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => {
    p.buf += d;
    const i = p.buf.indexOf(END);
    if (i >= 0 && p.waiter) {
      const out = p.buf.slice(0, i);
      p.buf = p.buf.slice(i + END.length).replace(/^\r?\n/, '');
      p.waiter(out);
    }
  });
  const dead = () => {
    if (ps === p) ps = null;
    p.waiter?.(null);
  };
  p.on('exit', dead);
  p.on('error', dead);
  p.stdin.on('error', () => {});
  p.stdin.write('[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms\n');
  return p;
}

function winPs(command) {
  const job = psChain.then(
    () =>
      new Promise((resolve) => {
        if (!ps) ps = startPs();
        const p = ps;
        const timer = setTimeout(() => {
          p.kill();
          finish(null);
        }, 8000);
        const finish = (out) => {
          clearTimeout(timer);
          p.waiter = null;
          resolve(out);
        };
        p.waiter = finish;
        p.stdin.write(`${command}; Write-Output '${END}'\n`);
        clearTimeout(psIdle);
        psIdle = setTimeout(() => ps?.kill(), 10 * 60_000);
        psIdle.unref();
      }),
  );
  psChain = job.catch(() => {});
  return job;
}

/** 本机打开网页时先把常驻的 powershell 起好，第一次粘贴就不用等冷启动 */
export function warmClipboard() {
  if (process.platform === 'win32' && !ps) winPs('$null').catch(() => {});
}

async function clipboardPaths() {
  if (process.platform === 'win32') {
    // 资源管理器 Ctrl+C 复制文件时，剪贴板里放的是一份完整路径列表（CF_HDROP）。
    // 用 Windows PowerShell 5.1 + .NET 读（PS7 的 Get-Clipboard 没有 -Format FileDropList 了），必须 STA
    const out = await winPs('[System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }');
    return (out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  if (process.platform === 'darwin') {
    const js =
      "ObjC.import('AppKit');var pb=$.NSPasteboard.generalPasteboard;" +
      'var urls=pb.readObjectsForClassesOptions($([$.NSURL]),$({}));var out=[];' +
      'if(urls){for(var i=0;i<urls.count;i++){var u=urls.objectAtIndex(i);if(u.isFileURL)out.push(u.path.js)}}out.join("\\n")';
    const out = await run('osascript', ['-l', 'JavaScript', '-e', js]);
    return (out || '').split('\n').map((l) => l.trim()).filter(Boolean);
  }
  // Linux：Wayland 用 wl-paste，X11 用 xclip，文件管理器复制文件时放的是 text/uri-list
  const out = (await run('wl-paste', ['--no-newline', '-t', 'text/uri-list'])) ?? (await run('xclip', ['-selection', 'clipboard', '-t', 'text/uri-list', '-o']));
  return fromUriList(out);
}

export async function readClipboardFiles() {
  const list = [];
  for (const p of await clipboardPaths()) {
    const st = await fsp.stat(p).catch(() => null);
    if (!st) continue;
    list.push({ path: p, name: path.basename(p), size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() });
  }
  return list;
}

// ---------- 上传 ----------
const safePart = (s) => String(s || '').replace(/[^\w.-]+/g, '_').slice(0, 80);

/**
 * 把设置里的路径模板展开成绝对路径。占位符从 vars 里取（{tmp} {home} {date}…），
 * 认识不了的占位符原样留着；~ 开头换成用户目录，相对路径按 base 算，模板是空的就用 fallback
 */
export function expandPath(template, vars = {}, { base = os.homedir(), fallback = '' } = {}) {
  let p = (template || '').trim() || fallback;
  p = p.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(base, p);
}

/**
 * 上传目录（设置里可以改）。支持变量：
 *   {tmp} 系统临时目录   {cwd} 当前工作目录   {session} 会话 id   {date} 今天的日期   {home} 用户目录
 * 相对路径按 cwd 解析，~ 开头按用户目录解析
 */
export function resolveUploadDir(template, { cwd, session }) {
  const base = cwd && path.isAbsolute(cwd) ? cwd : os.homedir();
  const vars = { tmp: os.tmpdir(), cwd: base, session: safePart(session) || 'default', date: new Date().toISOString().slice(0, 10), home: os.homedir() };
  return expandPath(template, vars, { base, fallback: '{tmp}/pi-web/{session}' });
}

// 文件名里去掉系统不允许的字符，保留原名（中文也保留），方便模型和人看懂
function cleanName(name) {
  // eslint-disable-next-line no-control-regex
  const n = path.basename(String(name || '')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+$/, '').trim();
  return n.slice(-180);
}

async function openUnique(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || 'file';
  for (let i = 0; i < 1000; i++) {
    const file = path.join(dir, i ? `${stem}-${i}${ext}` : name);
    try {
      return { file, fh: await fsp.open(file, 'wx') };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('同名文件太多了');
}

export async function saveUpload(req, { dir, name, maxBytes }) {
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const { file, fh } = await openUnique(dir, cleanName(name) || `upload-${stamp}`);
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (maxBytes && size > maxBytes) return cb(new Error(`文件太大（超过 ${Math.round(maxBytes / 1048576)}MB）`));
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, limiter, fh.createWriteStream());
  } catch (e) {
    await fh.close().catch(() => {});
    await fsp.unlink(file).catch(() => {});
    throw e;
  }
  return { path: file, name: path.basename(file), size };
}

// ---------- @ 补全：项目里的文件列表 ----------
const IGNORE = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.cache', 'target', '.idea', '.vscode']);
const MAX_FILES = 30000;
const cache = new Map(); // cwd -> { at, data }

async function gitFiles(cwd) {
  // 是 git 仓库就用 git 的列表：自动遵守 .gitignore；路径相对于 cwd
  const out = await run('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd, maxBuffer: 128 * 1024 * 1024, timeout: 8000 });
  if (out == null) return null;
  return out.split('\0').filter(Boolean);
}

async function walkFiles(cwd) {
  const files = [];
  const walk = async (rel, depth) => {
    if (files.length >= MAX_FILES || depth > 12) return;
    const ents = await fsp.readdir(path.join(cwd, rel), { withFileTypes: true }).catch(() => []);
    for (const e of ents) {
      if (files.length >= MAX_FILES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORE.has(e.name)) await walk(r, depth + 1);
      } else files.push(r);
    }
  };
  await walk('', 0);
  return files;
}

export async function listProjectFiles(cwd, fresh = false) {
  const hit = cache.get(cwd);
  if (!fresh && hit && Date.now() - hit.at < 15_000) return hit.data;
  const st = await fsp.stat(cwd).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`目录不存在：${cwd}`);
  let files = (await gitFiles(cwd)) || (await walkFiles(cwd));
  const truncated = files.length > MAX_FILES;
  files = files.slice(0, MAX_FILES).map((f) => f.replace(/\\/g, '/'));
  const dirs = new Set();
  for (const f of files) {
    let i = f.lastIndexOf('/');
    while (i > 0) {
      const d = f.slice(0, i);
      if (dirs.has(d)) break;
      dirs.add(d);
      i = d.lastIndexOf('/');
    }
  }
  const data = { root: cwd, sep: path.sep, files, dirs: [...dirs], truncated };
  cache.set(cwd, { at: Date.now(), data });
  return data;
}
