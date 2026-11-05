#!/usr/bin/env node
// seed-pi-web 命令行：启动/关闭后台服务、改配置（token、端口……）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  APP, HOME_DIR, CONFIG_FILE, STATE_FILE, LOG_FILE, KEYS,
  readFileConfig, writeFileConfig, parseValue, loadConfig, applyToEnv, readState,
} from '../server/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server', 'index.js');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HELP = `${APP} ${PKG.version}

用法：
  ${APP} start [-f] [-p 端口] [--host 地址] [--token xxx]
                         启动（默认后台运行；-f 前台运行，Ctrl+C 退出）
  ${APP} stop            关闭
  ${APP} restart         重启（参数同 start）
  ${APP} status          看运行状态
  ${APP} open            用浏览器打开（自动带上 token）
  ${APP} logs [-f]       看后台日志（-f 持续跟踪）

  ${APP} token           显示 token
  ${APP} token set <值>  设置 token
  ${APP} token gen       随机生成一个 token
  ${APP} token clear     去掉 token

  ${APP} config                 看全部配置
  ${APP} config get <键>
  ${APP} config set <键> <值>
  ${APP} config unset <键>      恢复默认
  ${APP} config path            配置文件在哪

配置项：${Object.keys(KEYS).join(', ')}
优先级：命令行参数 > 环境变量 > 配置文件（${CONFIG_FILE}）> 默认值
`;

// ---------- 小工具 ----------
const connectHost = (host) => (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host);
const urlOf = (cfg, withToken = true) => {
  const h = cfg.host === '0.0.0.0' || cfg.host === '::' ? 'localhost' : cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host;
  return `http://${h}:${cfg.port}/${withToken && cfg.token ? `?token=${encodeURIComponent(cfg.token)}` : ''}`;
};

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function api(cfg, p, method = 'GET') {
  // 用 node:http 短连接：fetch 的 keep-alive 连接会拖住退出，Windows 上还会触发 libuv 断言
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: connectHost(cfg.host), port: cfg.port, path: p, method, agent: false, timeout: 2000,
        headers: { connection: 'close', ...(cfg.token ? { 'x-seed-pi-web-token': cfg.token } : {}) } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** 看服务在不在：状态文件 + 真去请求一下，免得状态文件过期了还说在跑 */
async function probe() {
  let st = readState();
  if (st && !alive(st.pid)) {
    fs.rmSync(STATE_FILE, { force: true });
    st = null;
  }
  if (!st) {
    // 状态文件丢了（比如被删、换了配置目录）：再到配置的端口上问一下
    const cfg = loadConfig();
    try {
      const info = await api(cfg, '/api/ping');
      if (info.app === APP) return { pid: info.pid, host: info.host, port: info.port, startedAt: info.startedAt, cfg, ok: true };
    } catch {}
    return null;
  }
  const cfg = { ...loadConfig(), host: st.host, port: st.port };
  try {
    const info = await api(cfg, '/api/ping');
    if (info.app === APP) return { ...st, cfg, ok: true };
  } catch {}
  return { ...st, cfg, ok: false }; // 进程在，但没回应（可能还在启动，或者卡住了）
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else {
      try {
        process.kill(-pid, 'SIGKILL'); // 后台启动时是独立进程组
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {}
}

function tail(file, lines = 20) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines - 1).join('\n');
  } catch {
    return '';
  }
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: true }).unref();
}

// ---------- 命令 ----------
function startOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      foreground: { type: 'boolean', short: 'f' },
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      token: { type: 'string' },
      open: { type: 'boolean', short: 'o' },
    },
  });
  const cfg = loadConfig();
  if (values.port) cfg.port = parseValue('port', values.port);
  if (values.host) cfg.host = values.host;
  if (values.token !== undefined) cfg.token = values.token;
  return { cfg, foreground: values.foreground, open: values.open };
}

async function start(argv) {
  const { cfg, foreground, open } = startOptions(argv);
  const running = await probe();
  if (running) {
    console.log(`已经在运行了（pid ${running.pid}）：${urlOf({ ...cfg, ...running.cfg })}`);
    return;
  }
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) console.warn('提示：前端还没构建（dist/ 不存在），先在项目里运行 npm run build');

  if (foreground) {
    applyToEnv(cfg);
    if (open) setTimeout(() => openBrowser(urlOf(cfg)), 800);
    await import(pathToFileURL(SERVER).href);
    return;
  }

  fs.mkdirSync(HOME_DIR, { recursive: true });
  const log = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(log, `\n===== ${new Date().toLocaleString()} 启动 =====\n`);
  const child = spawn(process.execPath, [SERVER], {
    cwd: process.cwd(),
    env: applyToEnv(cfg, { ...process.env }),
    stdio: ['ignore', log, log],
    detached: true,
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(log);

  let exited = null;
  child.on('exit', (code) => (exited = code));
  for (let i = 0; i < 100 && exited === null; i++) {
    await sleep(150);
    try {
      const info = await api(cfg, '/api/ping');
      if (info.app === APP && info.pid === child.pid) {
        console.log(`已在后台启动（pid ${child.pid}）：${urlOf(cfg)}`);
        console.log(`日志：${LOG_FILE}`);
        if (open) openBrowser(urlOf(cfg));
        return;
      }
    } catch {}
  }
  console.error(exited !== null ? '启动失败，日志最后几行：' : '等了 15 秒还没启动好，日志最后几行：');
  console.error(tail(LOG_FILE).split('\n===== ').pop().replace(/^.*\n/, '').trim());
  process.exitCode = 1;
}

async function stop({ quiet = false } = {}) {
  const st = await probe();
  if (!st) {
    if (!quiet) console.log('没有在运行');
    return true;
  }
  if (st.ok) {
    try {
      await api(st.cfg, '/api/shutdown', 'POST');
    } catch {}
    for (let i = 0; i < 40 && alive(st.pid); i++) await sleep(150);
  }
  if (alive(st.pid)) killTree(st.pid); // 没回应 / 关不掉：直接把整棵进程树杀掉
  for (let i = 0; i < 20 && alive(st.pid); i++) await sleep(100);
  if (alive(st.pid)) {
    console.error(`关不掉进程 ${st.pid}`);
    return false;
  }
  fs.rmSync(STATE_FILE, { force: true });
  console.log(`已关闭（pid ${st.pid}）`);
  return true;
}

async function status() {
  const st = await probe();
  if (!st) return console.log('没有在运行');
  const cfg = { ...loadConfig(), host: st.host, port: st.port };
  console.log(`${st.ok ? '运行中' : '进程在但没响应'}  pid ${st.pid}`);
  console.log(`地址：${urlOf(cfg)}`);
  console.log(`启动于：${new Date(st.startedAt).toLocaleString()}`);
  console.log(`日志：${LOG_FILE}`);
}

async function logs(argv) {
  const { values } = parseArgs({ args: argv, options: { follow: { type: 'boolean', short: 'f' }, lines: { type: 'string', short: 'n' } } });
  if (!fs.existsSync(LOG_FILE)) return console.log('还没有日志');
  process.stdout.write(tail(LOG_FILE, Number(values.lines) || 50) + '\n');
  if (!values.follow) return;
  let pos = fs.statSync(LOG_FILE).size;
  fs.watchFile(LOG_FILE, { interval: 300 }, (cur) => {
    if (cur.size < pos) pos = 0; // 日志被清空了
    if (cur.size === pos) return;
    const fd = fs.openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(cur.size - pos);
    fs.readSync(fd, buf, 0, buf.length, pos);
    fs.closeSync(fd);
    pos = cur.size;
    process.stdout.write(buf);
  });
}

async function hintRestart() {
  if (await probe()) console.log(`服务正在运行，执行 ${APP} restart 后生效`);
}

async function token([sub, value]) {
  const file = readFileConfig();
  if (!sub) {
    const cfg = loadConfig();
    if (!cfg.token) return console.log('没有设置 token（只允许本机访问）');
    console.log(cfg.token);
    if (process.env.SEED_PI_WEB_TOKEN) console.log('（来自环境变量 SEED_PI_WEB_TOKEN）');
    return;
  }
  if (sub === 'set') {
    if (!value) throw new Error(`用法：${APP} token set <值>`);
    file.token = value;
  } else if (sub === 'gen') {
    file.token = crypto.randomBytes(18).toString('base64url');
  } else if (sub === 'clear') {
    delete file.token;
  } else throw new Error(`未知的子命令 token ${sub}`);
  writeFileConfig(file);
  console.log(file.token ? `token 已设为：${file.token}` : 'token 已去掉');
  await hintRestart();
}

async function config([sub, key, ...rest]) {
  const file = readFileConfig();
  const need = () => {
    if (!KEYS[key]) throw new Error(`未知配置项 ${key ?? ''}，可用：${Object.keys(KEYS).join(', ')}`);
  };
  if (!sub) {
    const cfg = loadConfig();
    for (const k of Object.keys(KEYS)) {
      const src = process.env[KEYS[k][0]] ? `环境变量 ${KEYS[k][0]}` : k in file ? '配置文件' : '默认';
      console.log(`${k.padEnd(12)} ${JSON.stringify(cfg[k]).padEnd(24)} (${src})`);
    }
    return;
  }
  if (sub === 'path') return console.log(CONFIG_FILE);
  if (sub === 'get') {
    need();
    return console.log(loadConfig()[key]);
  }
  if (sub === 'set') {
    need();
    if (!rest.length) throw new Error(`用法：${APP} config set ${key} <值>`);
    file[key] = parseValue(key, rest.join(' '));
  } else if (sub === 'unset') {
    need();
    delete file[key];
  } else throw new Error(`未知的子命令 config ${sub}`);
  writeFileConfig(file);
  console.log(sub === 'set' ? `${key} = ${JSON.stringify(file[key])}` : `${key} 已恢复默认`);
  await hintRestart();
}

// ---------- 入口 ----------
const [cmd, ...argv] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'start':
      await start(argv);
      break;
    case 'stop':
      process.exitCode = (await stop()) ? 0 : 1;
      break;
    case 'restart':
      startOptions(argv); // 先检查参数
      if (!(await stop({ quiet: true }))) {
        process.exitCode = 1;
        break;
      }
      await start(argv);
      break;
    case 'status':
      await status();
      break;
    case 'open': {
      const st = await probe();
      const cfg = st ? { ...loadConfig(), host: st.host, port: st.port } : loadConfig();
      if (!st) console.log(`服务没在运行，先执行 ${APP} start`);
      else openBrowser(urlOf(cfg));
      break;
    }
    case 'logs':
      await logs(argv);
      break;
    case 'token':
      await token(argv);
      break;
    case 'config':
      await config(argv);
      break;
    case '-v':
    case '--version':
      console.log(PKG.version);
      break;
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(HELP);
      break;
    default:
      console.error(`未知命令 ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
