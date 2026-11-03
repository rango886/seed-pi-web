// 网页终端：node-pty 开一个真正的 shell。浏览器断开后终端继续活着，重连时回放最近输出。
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
