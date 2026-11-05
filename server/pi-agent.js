// 一个 PiAgent = 一个 `pi --mode rpc` 子进程。
// 只依赖 pi 文档里公开的 RPC 协议（JSONL over stdin/stdout），不碰 pi 内部实现，
// 所以 pi 升级后一般不需要改这里。
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { execFile } from 'node:child_process';
import spawn from 'cross-spawn';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BRIDGE_COMMAND, BRIDGE_REPLY } from './conversation.js';

const CONVERSATION_EXTENSION = fileURLToPath(new URL('./extensions/conversation.js', import.meta.url));

const PI_BIN = process.env.SEED_PI_WEB_PI_BIN || 'pi';
// 额外传给 pi 的参数，比如 SEED_PI_WEB_PI_ARGS="--provider anthropic" 或 JSON 数组
const EXTRA_ARGS = (() => {
  const v = process.env.SEED_PI_WEB_PI_ARGS || '';
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
    // 中途打开的页面靠这两样补上“进行中”的内容（get_messages 拿不到还没写完的那条消息）：
    // live：上一条消息写完以后收到的事件；sticky：排队、重试、压缩这类“当前状态”，只留最新一条
    this.live = [];
    this.sticky = new Map();
    this.owner = null; // 正在操作这个会话的窗口（clientId），其他窗口只能看
    this.lastSettledAt = 0; // 最近一次回复完的时间，侧栏靠它显示“有新回复”
    this.saved = false; // 会话文件写到磁盘上没有（pi 新会话要等有消息才写盘）
    this.reqSeq = 0;
    this.bridgePending = new Map();
    this.bridgeCommand = null;
    this.conversationBusy = false;
  }

  start() {
    const args = ['--mode', 'rpc', ...this.extraArgs, '--extension', CONVERSATION_EXTENSION];
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
      for (const p of this.bridgePending.values()) p.reject(new Error('pi 进程已退出'));
      this.bridgePending.clear();
      this.uiPending.clear();
      this.emit('exit', { code, stderr: this.stderrTail });
    });
    child.stdin.on('error', () => {});
  }

  #handle(rec) {
    if (rec.type === 'extension_ui_request' && rec.method === 'notify' && rec.message?.startsWith(BRIDGE_REPLY)) {
      try {
        const reply = JSON.parse(rec.message.slice(BRIDGE_REPLY.length));
        const p = this.bridgePending.get(reply.requestId);
        if (p) {
          this.bridgePending.delete(reply.requestId);
          reply.ok ? p.resolve(reply.data) : p.reject(new Error(reply.error || '分支操作失败'));
          return;
        }
      } catch {}
      // Internal bridge replies never become chat notifications (including late replies).
      return;
    }
    if (rec.type === 'response' && rec.id && this.pending.has(rec.id)) {
      const p = this.pending.get(rec.id);
      this.pending.delete(rec.id);
      p.resolve(rec);
      return;
    }
    if (rec.type === 'extension_ui_request' && DIALOG_METHODS.has(rec.method)) {
      this.uiPending.set(rec.id, rec);
      this.emit('info');
      if (rec.timeout) setTimeout(() => this.uiPending.delete(rec.id) && this.emit('info'), rec.timeout + 500);
    }
    this.#track(rec);
    if (rec.type === 'extension_ui_request') {
      const key = { setStatus: `s:${rec.statusKey}`, setWidget: `w:${rec.widgetKey}`, setTitle: 'title' }[rec.method];
      if (key) this.uiState.set(key, rec);
    }
    if (rec.type === 'agent_start') this.#setRunning(true);
    if (rec.type === 'agent_settled') {
      this.lastSettledAt = Date.now();
      this.#setRunning(false);
    }
    if (rec.type === 'session_info_changed') {
      this.sessionName = rec.name || null;
      this.emit('info');
    }
    this.emit('record', rec);
  }

  /** 记下“进行中”的事件，给中途打开的页面补放 */
  #track(rec) {
    switch (rec.type) {
      case 'response':
      case 'extension_ui_request':
      case 'extension_error':
        return;
      case 'message_end': // 写完的消息 get_messages 能拿到，前面的事件就不用留了
        this.live = [];
        return;
      case 'agent_settled':
        this.live = [];
        this.sticky.delete('retry');
        this.sticky.delete('compaction');
        return;
      case 'queue_update':
        this.sticky.set('queue', rec);
        return;
      case 'auto_retry_start':
        this.sticky.set('retry', rec);
        return;
      case 'auto_retry_end':
        this.sticky.delete('retry');
        return;
      case 'compaction_start':
        this.sticky.set('compaction', rec);
        return;
      case 'compaction_end':
        this.sticky.delete('compaction');
        return;
    }
    // 连续的文字增量合成一条，回复再长 live 也不会攒太多条
    const ev = rec.type === 'message_update' && rec.assistantMessageEvent;
    const last = this.live[this.live.length - 1];
    const lev = last?.type === 'message_update' && last.assistantMessageEvent;
    if (ev && lev && /_delta$/.test(ev.type) && ev.type === lev.type && ev.contentIndex === lev.contentIndex && typeof ev.delta === 'string') {
      this.live[this.live.length - 1] = { ...rec, assistantMessageEvent: { ...ev, delta: lev.delta + ev.delta } };
      return;
    }
    this.live.push(rec);
  }

  /**
   * 给新打开的页面拍一张“快照”：已经写完的消息 + 进行中的事件。
   * get_messages 的回复在 pi 的输出流里有确定的位置，回复到达的那一刻（同步地）复制 live，
   * 并调用 onSnap 让调用方马上开始转发后面的事件，这样不重不漏。
   */
  snapshot(onSnap) {
    const id = `w${++this.reqSeq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (rec) => {
          const live = [...this.sticky.values(), ...this.live];
          onSnap?.();
          if (!rec.success) return reject(new Error(rec.error || 'get_messages 失败'));
          resolve({ messages: rec.data?.messages || [], live, running: this.running });
        },
        reject,
      });
      try {
        this.write({ type: 'get_messages', id });
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
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

  /** Public extension command bridge; discover by provenance before sending a prompt,
   * so a missing extension can never turn an internal command into an LLM request. */
  async conversation(payload) {
    {
      const res = await this.request({ type: 'get_commands' });
      const normalize = (p) => path.resolve(p || '').replace(/\\/g, '/').toLowerCase();
      const command = res.data?.commands?.find((c) =>
        (c.name === BRIDGE_COMMAND || c.name.startsWith(BRIDGE_COMMAND + ':')) &&
        normalize(c.sourceInfo?.path) === normalize(CONVERSATION_EXTENSION));
      if (!command) throw new Error('分支扩展没有加载，请重新加载 pi；需要支持 navigateTree 的 pi 版本');
      this.bridgeCommand = command.name;
    }
    const requestId = randomUUID();
    let timer;
    const result = new Promise((resolve, reject) => {
      this.bridgePending.set(requestId, { resolve, reject });
      timer = setTimeout(() => {
        this.bridgePending.delete(requestId);
        // A timed-out hook may still be awaiting UI. Stop this process rather
        // than let it navigate later, after the caller has already moved on.
        if (payload.op !== 'snapshot') { this.quiet = true; this.stop(); }
        reject(new Error('分支操作超时，请重新加载会话确认当前位置'));
      }, 120_000);
      timer.unref?.();
    });
    // Attach the rejection handler before invoking a command that may reply immediately.
    const accepted = this.request({ type: 'prompt', message: `/${this.bridgeCommand} ${JSON.stringify({ ...payload, requestId })}` })
      .then((r) => { if (!r.success) throw new Error(r.error || '分支命令失败'); });
    try {
      const [data] = await Promise.all([result, accepted]);
      return data;
    } finally {
      clearTimeout(timer);
      this.bridgePending.delete(requestId);
    }
  }

  /** 回复扩展弹窗 */
  respondUi(msg) {
    if (this.uiPending.delete(msg.id)) this.emit('info');
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
      owner: this.owner,
      saved: this.saved,
      waitingUi: this.uiPending.size > 0,
      lastSettledAt: this.lastSettledAt,
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
