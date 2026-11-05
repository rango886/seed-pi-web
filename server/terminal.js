// 网页终端：node-pty 开一个真正的 shell。浏览器断开后终端继续活着，重连时回放最近输出。
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, fork } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let pty = null;
try {
  pty = (await import('node-pty')).default;
} catch (e) {
  console.warn('[seed-pi-web] node-pty 不可用，终端功能已禁用：', e.message);
}

export const terminalAvailable = () => !!pty;

function defaultShell() {
  if (process.env.SEED_PI_WEB_SHELL) return process.env.SEED_PI_WEB_SHELL;
  if (process.platform === 'win32') {
    // where.exe 能找到应用商店装的 pwsh（那种是别名，fs.existsSync 判断不出来）
    try {
      const out = execFileSync('where.exe', ['pwsh'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
      if (out) return out;
    } catch {}
    for (const dir of (process.env.PATH || '').split(';')) {
      if (dir && fs.existsSync(path.join(dir, 'pwsh.exe'))) return 'pwsh.exe';
    }
    return 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

// node-pty 1.1 的系统 ConPTY 关闭路径会 fork 控制台进程枚举助手，但没有传 windowsHide。
// 只替换当前实例的兼容钩子，保留原有后端、进程树清理和 PTY / worker 释放逻辑。
function hideConsoleHelper(terminal) {
  const agent = terminal._agent;
  if (process.platform !== 'win32' || typeof agent?._getConsoleProcessList !== 'function') return;
  let helper;
  try {
    helper = require.resolve('node-pty/lib/conpty_console_list_agent.js');
  } catch {
    return; // 新版依赖若移除了这个助手，就保留它自己的关闭实现。
  }
  agent._getConsoleProcessList = () => new Promise((resolve) => {
    const fallback = [terminal.pid];
    let child, timer, settled = false;
    const finish = (pids) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(pids);
    };
    try {
      child = fork(helper, [String(terminal.pid)], {
        windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
      });
    } catch {
      finish(fallback);
      return;
    }
    timer = setTimeout(() => {
      finish(fallback);
      try { child.kill(); } catch {}
    }, 5000);
    child.once('message', (message) => finish(Array.isArray(message?.consoleProcessList) ? message.consoleProcessList : fallback));
    child.once('error', () => finish(fallback));
    child.once('exit', () => finish(fallback));
  });
}

const MAX_BUFFER = 256 * 1024;
let seq = 0;

class Terminal extends EventEmitter {
  constructor({ cwd, cols = 100, rows = 24, title }) {
    super();
    this.id = `t${++seq}`;
    this.cwd = cwd;
    this.title = title || path.basename(cwd) || cwd;
    this.buffer = '';
    this.alive = true;
    const shell = defaultShell();
    this.p = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    hideConsoleHelper(this.p);
    this.p.onData((d) => {
      this.buffer = (this.buffer + d).slice(-MAX_BUFFER);
      this.emit('data', d);
    });
    this.p.onExit(({ exitCode }) => {
      this.alive = false;
      this.emit('exit', exitCode);
    });
  }
  write(d) {
    if (this.alive) this.p.write(d);
  }
  resize(cols, rows) {
    if (this.alive && cols > 0 && rows > 0) {
      try {
        this.p.resize(cols, rows);
      } catch {}
    }
  }
  kill() {
    if (this.alive) {
      try {
        this.p.kill();
      } catch {}
    }
  }
  info() {
    return { id: this.id, cwd: this.cwd, title: this.title, alive: this.alive };
  }
}

export class TerminalManager extends EventEmitter {
  constructor() {
    super();
    this.terms = new Map();
  }
  open(opts) {
    if (!pty) throw new Error('node-pty 不可用');
    const t = new Terminal(opts);
    this.terms.set(t.id, t);
    t.on('data', (d) => this.emit('data', t.id, d));
    t.on('exit', (code) => {
      this.emit('exit', t.id, code);
      this.terms.delete(t.id);
      this.emit('change');
    });
    if (opts.command) setTimeout(() => t.write(opts.command + '\r'), 300);
    this.emit('change');
    return t;
  }
  get(id) {
    return this.terms.get(id);
  }
  close(id) {
    this.terms.get(id)?.kill();
  }
  list() {
    return [...this.terms.values()].map((t) => t.info());
  }
  closeAll() {
    for (const t of this.terms.values()) t.kill();
  }
}
