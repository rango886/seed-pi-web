// 一个 PiAgent = 一个 `pi --mode rpc` 子进程。
// 只依赖 pi 文档里公开的 RPC 协议（JSONL over stdin/stdout），不碰 pi 内部实现，
// 所以 pi 升级后一般不需要改这里。
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { execFile } from 'node:child_process';
import spawn from 'cross-spawn';

const PI_BIN = process.env.PI_BIN || 'pi';
// 额外传给 pi 的参数，比如 PI_WEB_PI_ARGS="--provider anthropic" 或 JSON 数组
const EXTRA_ARGS = (() => {
  const v = process.env.PI_WEB_PI_ARGS || '';
  if (!v.trim()) return [];
  if (v.trim().startsWith('[')) return JSON.parse(v);
  return v.trim().split(/\s+/);
})();
const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

let seq = 0;

export class PiAgent extends EventEmitter {
  constructor({ cwd, sessionFile, extraArgs = EXTRA_ARGS }) {
    super();
    this.id = `a${++seq}`;
    this.cwd = cwd;
    this.sessionFile = sessionFile || null;
    this.sessionName = null;
    this.extraArgs = extraArgs;
    this.running = false; // 是否正在跑一轮对话
    this.alive = false;
    this.stderrTail = '';
    this.pending = new Map(); // 我们发出的命令 id -> {resolve, reject}
    this.uiPending = new Map(); // 还没回复的扩展弹窗请求，供刷新页面后重新显示
    this.uiState = new Map(); // 扩展设置的状态栏/小组件/标题（按 key 只留最新一条），新打开的页面也能看到
    this.reqSeq = 0;
  }

  start() {
    const args = ['--mode', 'rpc', ...this.extraArgs];
    if (this.sessionFile) args.push('--session', this.sessionFile);
    const child = spawn(PI_BIN, args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.alive = true;

    // 严格按 LF 切分（文档要求，不能用 readline）
    const decoder = new StringDecoder('utf8');
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += decoder.write(chunk);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.trim()) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        this.#handle(rec);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d).slice(-8000);
    });

    child.on('error', (err) => {
      this.stderrTail += `\n${err.message}`;
    });
    child.on('exit', (code) => {
      this.alive = false;
      this.running = false;
      for (const p of this.pending.values()) p.reject(new Error('pi 进程已退出'));
      this.pending.clear();
      this.uiPending.clear();
      this.emit('exit', { code, stderr: this.stderrTail });
    });
    child.stdin.on('error', () => {});
  }

  #handle(rec) {
    if (rec.type === 'response' && rec.id && this.pending.has(rec.id)) {
      const p = this.pending.get(rec.id);
      this.pending.delete(rec.id);
      p.resolve(rec);
      return;
    }
    if (rec.type === 'extension_ui_request' && DIALOG_METHODS.has(rec.method)) {
      this.uiPending.set(rec.id, rec);
      if (rec.timeout) setTimeout(() => this.uiPending.delete(rec.id), rec.timeout + 500);
    }
    if (rec.type === 'extension_ui_request') {
      const key = { setStatus: `s:${rec.statusKey}`, setWidget: `w:${rec.widgetKey}`, setTitle: 'title' }[rec.method];
      if (key) this.uiState.set(key, rec);
    }
    if (rec.type === 'agent_start') this.#setRunning(true);
    if (rec.type === 'agent_settled') this.#setRunning(false);
    if (rec.type === 'session_info_changed') {
      this.sessionName = rec.name || null;
      this.emit('info');
    }
    this.emit('record', rec);
  }

  #setRunning(v) {
    if (this.running !== v) {
      this.running = v;
      this.emit('info');
    }
  }

  write(obj) {
    if (!this.alive) throw new Error('pi 进程未运行');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  /** 发送一个 RPC 命令，等待对应 id 的 response */
  request(cmd) {
    const id = `w${++this.reqSeq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ ...cmd, id });
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /** 回复扩展弹窗 */
  respondUi(msg) {
    this.uiPending.delete(msg.id);
    this.write({ ...msg, type: 'extension_ui_response' });
  }

  async refreshState() {
    const res = await this.request({ type: 'get_state' });
    if (res.success && res.data) {
      this.sessionFile = res.data.sessionFile || this.sessionFile;
      this.sessionName = res.data.sessionName || null;
      this.running = !!res.data.isStreaming;
    }
    return res;
  }

  info() {
    return {
      id: this.id,
      cwd: this.cwd,
      sessionFile: this.sessionFile,
      sessionName: this.sessionName,
      running: this.running,
      alive: this.alive,
    };
  }

  /** 关闭 stdin 让 pi 正常退出，超时就强杀整个进程树 */
  stop() {
    return new Promise((resolve) => {
      if (!this.alive) return resolve();
      this.once('exit', () => resolve());
      try {
        this.child.stdin.end();
      } catch {}
      setTimeout(() => {
        if (this.alive) killTree(this.child.pid);
      }, 3000);
    });
  }
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}
