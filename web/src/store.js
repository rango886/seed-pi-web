// 全局状态 + 所有动作。组件只负责显示，逻辑都在这里，方便看懂。
import { reactive, computed } from 'vue';
import { connect, call, fire, http, rawUrl } from './api.js';
import { stripAnsi, joinPath, normPath, isAbsPath } from './util.js';
import { view, UI } from './settings.js';

export const S = reactive({
  connected: false,
  info: { home: '', sep: '/', platform: '', terminal: false },
  agents: [], // 后端所有 pi 进程
  agentId: null,
  agent: null, // 当前 pi 进程信息（cwd / sessionFile / running）
  agentExited: null,
  cwd: localStorage.getItem('pi-web-cwd') || '',
  state: null, // get_state 结果
  stats: null, // get_session_stats 结果
  thinkingLevels: [],
  models: [],
  commands: [], // 扩展命令 / prompt 模板 / skill
  messages: [],
  tools: {}, // toolCallId -> { status, args, partial, result, durationMs }
  running: false,
  compacting: false,
  retry: null,
  detached: null, // 目录已不存在的会话：{ file, cwd }，只读看历史，不能对话
  queue: { steering: [], followUp: [] },
  bashLive: null,
  // 扩展 UI
  dialogs: [],
  statusItems: {},
  widgets: {},
  // 界面
  composer: { text: '', images: [] },
  toasts: [],
  picker: null,
  dirPicker: false,
  dirPickerMode: 'switch', // 'switch' 切工作目录 / 'new' 选个目录开新会话
  tabs: [], // 打开的文件
  activeTab: 'chat', // 'chat' | 文件路径 | 'term:<终端id>'
  fsEpoch: 0,
  sessions: [],
  showAllSessions: false,
  terms: [],
  activeTerm: null, // 最近一次看的终端（Ctrl+` 切回去用）
  connEpoch: 0,
  tick: 0, // 每来一个流式事件 +1，聊天区用它判断要不要滚到底
});

// 后台还有几个别的 pi 进程在跑（不含当前这个）
export const otherAgents = computed(() => S.agents.filter((a) => a.running && a.id !== S.agentId).length);
// 输入框上面那行状态信息有没有东西可显示：顶部栏的状态按钮靠它决定要不要出现
export const hasStatus = computed(() => !!(S.stats?.tokens || S.stats?.contextUsage || otherAgents.value || Object.keys(S.statusItems).length));

// ---------------- 小工具 ----------------
let keySeq = 0;
const withKey = (m) => ({ ...m, _k: ++keySeq });

export function toast(text, kind = 'info', ms = 4000) {
  const t = { id: ++keySeq, text: stripAnsi(String(text)), kind };
  S.toasts.push(t);
  setTimeout(() => (S.toasts = S.toasts.filter((x) => x.id !== t.id)), ms);
}

async function rpc(cmd) {
  if (!S.agentId) throw new Error('还没有打开目录');
  const res = await call('rpc', { agentId: S.agentId, cmd });
  if (!res.success) throw new Error(res.error || `${cmd.type} 失败`);
  return res.data;
}

const guard = (fn) => async (...a) => {
  try {
    return await fn(...a);
  } catch (e) {
    toast(e.message, 'error');
  }
};

/** 网页自己的对话框（复用扩展弹窗的组件），返回用户输入 */
export function ask(opts) {
  return new Promise((resolve) => S.dialogs.push({ id: `local${++keySeq}`, ...opts, _resolve: resolve }));
}

export function openPicker(opts) {
  S.picker = opts;
}

// ---------------- 连接 / 打开目录 ----------------
export const termListeners = new Map();

export function start() {
  connect({
    status: async (ok) => {
      S.connected = ok;
      if (!ok) return;
      try {
        S.info = await http.get('/api/info');
        // 别的标签页用 ?cwd=...&new=1 打开：只认第一次，之后重连（断线重连）走正常流程
        const bootCwd = pendingCwd;
        const bootNew = pendingNew;
        pendingCwd = null;
        pendingNew = false;
        let cwd = bootCwd || S.cwd;
        if (!cwd) {
          const recent = await http.get('/api/recent-dirs').catch(() => []);
          cwd = recent[0]?.cwd || S.info.home;
        }
        S.connEpoch++;
        // 会话列表不依赖 pi 进程，先拉，不用等 pi 启动完
        if (S.cwd) loadSessions();
        try {
          // 从别的标签页指定的目录：不恢复当前标签页记着的会话，那个还在原标签页用着
          await openDirRaw(cwd, true, bootCwd ? undefined : localStorage.getItem('pi-web-session'));
        } catch (e) {
          toast(e.message, 'error');
          await openDirRaw(S.info.home, true);
        }
        if (bootNew) await newSessionIn(cwd);
      } catch (e) {
        toast(e.message, 'error');
      }
    },
    message: onServerMsg,
  });
}

// 地址栏上的 ?cwd=<目录>&new=1：新标签页打开某个目录 / 直接在那里开个新会话
const bootQuery = new URLSearchParams(location.search);
let pendingCwd = bootQuery.get('cwd');
let pendingNew = bootQuery.get('new') === '1';
if (pendingCwd || pendingNew) history.replaceState(null, '', location.pathname);

/** 用新标签页打开某个目录（newSession：到那里直接开新会话）。Ctrl+点击目录选择窗口的主按钮就是这个 */
export function openInNewTab(cwd, { newSession: atNew = false } = {}) {
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('cwd', cwd);
  if (atNew) u.searchParams.set('new', '1');
  const token = localStorage.getItem('pi-web-token');
  if (token) u.searchParams.set('token', token);
  window.open(u.toString(), '_blank', 'noopener');
}

function onServerMsg(msg) {
  switch (msg.t) {
    case 'agents':
      S.agents = msg.list;
      if (S.agentId) {
        const a = msg.list.find((x) => x.id === S.agentId);
        if (a) {
          const sessionChanged = S.agent && a.sessionFile !== S.agent.sessionFile;
          S.agent = a;
          if (a.sessionFile) localStorage.setItem('pi-web-session', a.sessionFile);
          if (a.cwd !== S.cwd) setCwd(a.cwd);
          if (sessionChanged) loadSessions();
        }
      }
      break;
    case 'rec':
      if (msg.agentId === S.agentId) onRec(msg.rec);
      break;
    case 'agent_exit':
      if (msg.agentId === S.agentId) {
        S.agentExited = { code: msg.code, stderr: msg.stderr };
        S.running = false;
      }
      break;
    case 'terms':
      S.terms = msg.list;
      if (S.activeTerm && !msg.list.some((t) => t.id === S.activeTerm)) S.activeTerm = msg.list[0]?.id || null;
      // 正在看的终端没了（关掉、shell 退出）：切到另一个终端，没有就回对话
      if (termIdOf(S.activeTab) && !msg.list.some((t) => t.id === termIdOf(S.activeTab))) {
        S.activeTab = S.activeTerm ? termTab(S.activeTerm) : S.tabs[S.tabs.length - 1]?.path || 'chat';
      }
      break;
    case 'term_data':
    case 'term_exit':
      termListeners.get(msg.id)?.(msg);
      break;
  }
}

function setCwd(cwd) {
  S.cwd = cwd;
  localStorage.setItem('pi-web-cwd', cwd);
  syncTitle();
  if (S.agent?.sessionFile) localStorage.setItem('pi-web-session', S.agent.sessionFile);
  S.fsEpoch++;
}

/** 顶栏 / 浏览器标签页显示的会话名：自定义名 > 第一条用户消息 > 目录名 */
export function sessionTitle() {
  if (S.state?.sessionName) return S.state.sessionName;
  const first = S.messages.find((m) => m.role === 'user');
  const c = first?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b) => b.type === 'text')?.text || '' : '';
  const line = text.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (line) return line;
  return (S.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '新会话';
}

/** 开多个标签页时，靠标签标题区分是哪个会话（太长就截一下，不然标签挤成一坨） */
export function syncTitle() {
  const t = sessionTitle();
  document.title = t.length > 28 ? t.slice(0, 28) + '…' : t;
}

async function attachResult({ agent, uiPending, uiState }) {
  S.agentId = agent.id;
  S.agent = agent;
  S.agentExited = null;
  S.detached = null;
  S.dialogs = S.dialogs.filter((d) => d._resolve).concat(uiPending || []);
  S.statusItems = {};
  S.widgets = {};
  for (const r of uiState || []) onUiRequest(r);
  S.retry = null;
  S.compacting = false;
  setCwd(agent.cwd);
  await reload();
}

async function openDirRaw(cwd, force = false, sessionFile) {
  if (!force && S.agent?.alive && !S.agentExited && normPath(S.agent.cwd) === normPath(cwd)) return;
  await attachResult(await call('attach', { cwd, sessionFile }));
}
export const openDir = guard(openDirRaw);

export const openSession = guard(async (file) => {
  const res = await call('open_session', { file });
  if (res?.detached) return openDetached(res.detached);
  await attachResult(res);
});

/**
 * 目录已经不存在的历史会话：只读打开，历史照看，想接着聊得先选个新目录
 * （pi 自己不允许加载“记录目录不存在”的会话，所以换目录只会开新会话）
 */
function openDetached({ file, cwd, messages }) {
  S.agentId = null;
  S.agent = null;
  S.agentExited = null;
  S.detached = { file, cwd };
  S.state = null;
  S.stats = null;
  S.thinkingLevels = [];
  S.queue = { steering: [], followUp: [] };
  S.running = false;
  S.compacting = false;
  S.retry = null;
  S.statusItems = {};
  S.widgets = {};
  S.dialogs = S.dialogs.filter((d) => d._resolve);
  S.cwd = cwd; // 不写 localStorage：这个目录已经不存在了
  S.fsEpoch++;
  setMessages(messages);
  S.activeTab = 'chat';
  syncTitle();
}


export const restartAgent = guard(async () => {
  if (S.running) return toast('正在运行，先停止再重新加载', 'warning');
  if (!S.agentId || S.agentExited) return openDir(S.cwd, true);
  await attachResult(await call('restart', { agentId: S.agentId }));
  toast('已重新加载 pi（扩展、技能、设置）');
});

export async function reload() {
  await Promise.all([loadMessages(), loadState(), loadCommands(), loadStats()]);
  loadSessions();
}

// ---------------- 读取状态 ----------------
/** 把 pi 的 message 数组变成界面要的 S.messages + S.tools */
function setMessages(list) {
  const tools = {};
  const out = [];
  for (const m of list || []) {
    if (m.role === 'system') continue;
    if (m.role === 'toolResult') {
      tools[m.toolCallId] = { status: m.isError ? 'error' : 'done', result: m };
      continue;
    }
    out.push(withKey(m));
  }
  S.tools = tools;
  S.messages = out;
  liveIdx = -1;
  pendingDeltas.clear();
  S.tick++;
  syncTitle();
}

async function loadMessages() {
  const d = await rpc({ type: 'get_messages' }).catch(() => ({ messages: [] }));
  setMessages(d.messages);
}

async function loadState() {
  try {
    S.state = await rpc({ type: 'get_state' });
    S.running = !!S.state.isStreaming;
    S.compacting = !!S.state.isCompacting;
    const t = await rpc({ type: 'get_available_thinking_levels' });
    S.thinkingLevels = t.levels || [];
    syncTitle();
  } catch {}
}

async function loadStats() {
  S.stats = await rpc({ type: 'get_session_stats' }).catch(() => null);
}

async function loadCommands() {
  const d = await rpc({ type: 'get_commands' }).catch(() => ({ commands: [] }));
  S.commands = d.commands || [];
}

export async function loadSessions() {
  if (!S.cwd) return;
  // 只看当前目录时带 cwd；看全部目录时只传 all，后端才不会按 cwd 过滤
  const query = S.showAllSessions ? { all: 1 } : { cwd: S.cwd };
  S.sessions = await http.get('/api/sessions', query).catch(() => []);
}

export async function loadModels() {
  const d = await rpc({ type: 'get_available_models' });
  S.models = d.models || [];
  return S.models;
}

/** 直接切换模型（输入框下面的模型菜单用） */
export const setModel = guard(async (m) => {
  await rpc({ type: 'set_model', provider: m.provider, modelId: m.id });
  await loadState();
  const recent = JSON.parse(localStorage.getItem('pi-web-recent-models') || '[]').filter((k) => k !== `${m.provider}/${m.id}`);
  recent.unshift(`${m.provider}/${m.id}`);
  localStorage.setItem('pi-web-recent-models', JSON.stringify(recent.slice(0, 6)));
});

export const setThinking = guard(async (level) => {
  await rpc({ type: 'set_thinking_level', level });
  if (S.state) S.state.thinkingLevel = level;
});

// ---------------- 处理 pi 推过来的事件 ----------------
let liveIdx = -1; // 正在流式输出的那条消息在 S.messages 里的位置
const pendingDeltas = new Map(); // "contentIndex:field" -> { m, i, field, text }
let flushTimer = null;

function flushDeltas() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!pendingDeltas.size) return;
  for (const { m, i, field, text } of pendingDeltas.values()) {
    const c = m.content;
    if (!c[i]) c[i] = field === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' };
    c[i][field] = (c[i][field] || '') + text;
  }
  pendingDeltas.clear();
  S.tick++;
}

function liveAssistant() {
  let m = S.messages[liveIdx];
  if (!m || m.role !== 'assistant') {
    const last = S.messages[S.messages.length - 1];
    if (last?.role === 'assistant' && last.stopReason === 'pending') {
      liveIdx = S.messages.length - 1;
    } else {
      S.messages.push(withKey({ role: 'assistant', content: [], stopReason: 'pending' }));
      liveIdx = S.messages.length - 1;
    }
    m = S.messages[liveIdx];
  }
  return m;
}

function onRec(rec) {
  // 流式文字先攒着，定时一起写进状态：不然每来一个字就要重新解析 Markdown、高亮代码，回复一长就卡
  if (rec.type === 'message_update') {
    const ev = rec.assistantMessageEvent || {};
    if ((ev.type === 'text_delta' || ev.type === 'thinking_delta') && typeof ev.delta === 'string') {
      const m = liveAssistant();
      if (rec.usage) m.usage = rec.usage;
      const field = ev.type === 'text_delta' ? 'text' : 'thinking';
      const k = `${ev.contentIndex}:${field}`;
      const p = pendingDeltas.get(k);
      if (p && p.m === m) p.text += ev.delta;
      else {
        if (p) flushDeltas();
        pendingDeltas.set(k, { m, i: ev.contentIndex, field, text: ev.delta });
      }
      if (!flushTimer) flushTimer = setTimeout(flushDeltas, 50);
      return;
    }
  }
  flushDeltas();
  S.tick++;
  switch (rec.type) {
    case 'agent_start':
      S.running = true;
      break;
    case 'agent_settled':
      S.running = false;
      S.retry = null;
      loadStats();
      loadState();
      loadSessions();
      break;
    case 'message_start': {
      const m = rec.message;
      if (!m || m.role === 'system' || m.role === 'toolResult') break;
      S.messages.push(withKey(m));
      liveIdx = S.messages.length - 1;
      break;
    }
    case 'message_update': {
      const ev = rec.assistantMessageEvent || {};
      const m = liveAssistant();
      if (rec.usage) m.usage = rec.usage;
      const i = ev.contentIndex;
      const c = m.content;
      switch (ev.type) {
        case 'text_start':
          c[i] = { type: 'text', text: '' };
          break;
        case 'text_delta':
          if (!c[i]) c[i] = { type: 'text', text: '' };
          c[i].text += ev.delta;
          break;
        case 'text_end':
          c[i] = { type: 'text', text: ev.content ?? c[i]?.text ?? '' };
          break;
        case 'thinking_start':
          c[i] = { type: 'thinking', thinking: '' };
          break;
        case 'thinking_delta':
          if (!c[i]) c[i] = { type: 'thinking', thinking: '' };
          c[i].thinking += ev.delta;
          break;
        case 'thinking_end':
          c[i] = { type: 'thinking', thinking: ev.content ?? c[i]?.thinking ?? '' };
          break;
        case 'toolcall_start':
          c[i] = { type: 'toolCall', id: ev.id, name: ev.toolName, arguments: {}, _raw: '' };
          break;
        case 'toolcall_delta':
          if (c[i]) c[i]._raw = (c[i]._raw || '') + ev.delta;
          break;
        case 'toolcall_end':
          c[i] = ev.toolCall;
          break;
      }
      break;
    }
    case 'message_end': {
      const m = rec.message;
      if (!m || m.role === 'system') break;
      if (m.role === 'toolResult') {
        S.tools[m.toolCallId] = { ...(S.tools[m.toolCallId] || {}), status: m.isError ? 'error' : 'done', result: m };
        break;
      }
      const cur = S.messages[liveIdx];
      if (cur && cur.role === m.role) S.messages[liveIdx] = { ...m, _k: cur._k };
      else S.messages.push(withKey(m));
      liveIdx = -1;
      break;
    }
    case 'tool_execution_start':
      S.tools[rec.toolCallId] = { status: 'running', args: rec.args };
      break;
    case 'tool_execution_update':
      S.tools[rec.toolCallId] = { ...(S.tools[rec.toolCallId] || {}), status: 'running', partial: rec.partialResult };
      break;
    case 'tool_execution_end':
      S.tools[rec.toolCallId] = {
        ...(S.tools[rec.toolCallId] || {}),
        status: rec.isError ? 'error' : 'done',
        result: rec.result,
        durationMs: rec.durationMs,
      };
      onToolTouched(rec.args || S.tools[rec.toolCallId]?.args);
      break;
    case 'queue_update':
      S.queue = { steering: rec.steering || [], followUp: rec.followUp || [] };
      break;
    case 'compaction_start':
      S.compacting = true;
      break;
    case 'compaction_end':
      S.compacting = false;
      if (rec.result) {
        toast(`上下文已压缩：${rec.result.tokensBefore} → ~${rec.result.estimatedTokensAfter} tokens`);
        loadMessages();
        loadStats();
      } else if (rec.errorMessage) toast(`压缩失败：${rec.errorMessage}`, 'error');
      break;
    case 'auto_retry_start':
      S.retry = rec;
      break;
    case 'auto_retry_end':
      S.retry = null;
      if (!rec.success) toast(`重试失败：${rec.finalError || ''}`, 'error');
      break;
    case 'session_info_changed':
      if (S.state) S.state.sessionName = rec.name;
      syncTitle();
      loadSessions();
      break;
    case 'thinking_level_changed':
      if (S.state) S.state.thinkingLevel = rec.level;
      break;
    case 'bash_execution_update':
      if (S.bashLive) S.bashLive.output += rec.delta;
      break;
    case 'extension_ui_request':
      onUiRequest(rec);
      break;
    case 'extension_error':
      toast(`扩展出错：${rec.error}`, 'error', 8000);
      break;
  }
}

/** 工具改了文件：刷新文件树和已打开的同名文件 */
function onToolTouched(args) {
  S.fsEpoch++;
  if (!args) return;
  for (const v of Object.values(args)) {
    if (typeof v !== 'string' || v.length > 500 || v.includes('\n')) continue;
    const abs = normPath(isAbsPath(v) ? v : joinPath(S.cwd, v, S.info.sep));
    const tab = S.tabs.find((t) => normPath(t.path) === abs);
    if (tab) loadFile(tab);
  }
}

// ---------------- 扩展 UI ----------------
function onUiRequest(r) {
  switch (r.method) {
    case 'select':
    case 'confirm':
    case 'input':
    case 'editor':
      S.dialogs.push(r);
      if (r.timeout) setTimeout(() => (S.dialogs = S.dialogs.filter((d) => d.id !== r.id)), r.timeout);
      break;
    case 'notify':
      toast(r.message, r.notifyType || 'info');
      break;
    case 'setStatus':
      if (r.statusText == null) delete S.statusItems[r.statusKey];
      else S.statusItems[r.statusKey] = stripAnsi(r.statusText);
      break;
    case 'setWidget':
      if (!r.widgetLines) delete S.widgets[r.widgetKey];
      else S.widgets[r.widgetKey] = { lines: r.widgetLines.map(stripAnsi), placement: r.widgetPlacement || 'aboveEditor' };
      break;
    case 'setTitle':
      document.title = r.title;
      break;
    case 'set_editor_text':
      S.composer.text = r.text ?? '';
      break;
    default:
      if (r.message) toast(r.message);
  }
}

export function answerDialog(d, payload) {
  S.dialogs = S.dialogs.filter((x) => x.id !== d.id);
  if (d._resolve) return d._resolve(payload);
  call('ui_response', { agentId: S.agentId, msg: { id: d.id, ...payload } }).catch(() => {});
}

// ---------------- 发送消息 ----------------
/** 返回 true 表示已处理，输入框可以清空 */
export async function submit(text, { followUp = false } = {}) {
  const images = S.composer.images.map(({ type, data, mimeType }) => ({ type, data, mimeType }));
  if (!text.trim() && !images.length) return false;
  try {
    if (text.startsWith('/') && !images.length) {
      const handled = await runSlash(text.trim());
      if (handled) return true;
    }
    if (text.startsWith('!') && !images.length) return await runBash(text);
    const cmd = { type: 'prompt', message: text };
    if (images.length) cmd.images = images;
    if (S.running) cmd.streamingBehavior = followUp ? 'followUp' : 'steer';
    await rpc(cmd);
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}

async function runBash(text) {
  const exclude = text.startsWith('!!');
  const command = text.slice(exclude ? 2 : 1).trim();
  if (!command) return false;
  if (S.running || S.bashLive) {
    toast('pi 正在运行，稍后再执行 shell 命令', 'warning');
    return false;
  }
  S.messages.push(withKey({ role: 'bashExecution', command, output: '', running: true, excludeFromContext: exclude }));
  const m = S.messages[S.messages.length - 1];
  S.bashLive = m;
  try {
    const d = await rpc({ type: 'bash', command, excludeFromContext: exclude });
    Object.assign(m, { output: d.output, exitCode: d.exitCode, cancelled: d.cancelled, truncated: d.truncated });
  } finally {
    m.running = false;
    S.bashLive = null;
  }
  return true;
}

/** Esc / 停止按钮：和终端版一样，先把排队的消息拿回输入框，再中断 */
export const stop = guard(async () => {
  if (S.bashLive) return rpc({ type: 'abort_bash' });
  if (S.retry) await rpc({ type: 'abort_retry' }).catch(() => {});
  const q = await rpc({ type: 'clear_queue' }).catch(() => null);
  const back = [...(q?.steering || []), ...(q?.followUp || [])].join('\n');
  if (back) S.composer.text = back + (S.composer.text ? '\n' + S.composer.text : '');
  await rpc({ type: 'abort' });
});

// ---------------- 斜杠命令 ----------------
// pi 内置的终端命令在 RPC 里不能直接发，这里映射成对应的 RPC 命令。
// 扩展命令、prompt 模板、skill 由 get_commands 动态拿到，直接当 prompt 发给 pi。
export const BUILTINS = [
  { name: 'new', desc: '开始新会话', run: () => newSession() },
  { name: 'resume', desc: '切换到其他历史会话', run: () => pickSession() },
  { name: 'model', args: '[provider/model]', desc: '切换模型', run: (a) => pickModel(a) },
  { name: 'thinking', args: '[level]', desc: '设置思考强度', run: (a) => pickThinking(a) },
  { name: 'name', args: '[名称]', desc: '设置会话名称', run: (a) => renameSession(a) },
  { name: 'compact', args: '[说明]', desc: '压缩上下文', run: (a) => compact(a) },
  { name: 'fork', desc: '从之前的某条消息分叉出新会话', run: () => pickFork() },
  { name: 'clone', desc: '复制当前会话', run: () => cloneSession() },
  { name: 'session', desc: '当前会话信息和统计', run: () => showSessionInfo() },
  { name: 'copy', desc: '复制最后一条回复', run: () => copyLast() },
  { name: 'export', args: '[路径]', desc: '导出会话为 HTML', run: (a) => exportHtml(a) },
  { name: 'reload', desc: '重启 pi，重新加载扩展/技能/设置', run: () => restartAgent() },
  { name: 'cd', args: '[目录]', desc: '切换工作目录', run: (a) => changeDir(a) },
  { name: 'terminal', desc: '打开一个终端', run: () => openTerminal() },
  { name: 'hotkeys', desc: '快捷键说明', run: () => showHotkeys() },
  { name: 'ui', desc: '界面设置（主题、字体、气泡、间距…）', run: () => (view.settingsOpen = true) },
  { name: 'quit', desc: '关闭当前目录的 pi 进程', run: () => quitAgent() },
];
// 这些只有终端版 pi 有界面，网页里就在终端里打开 pi 来用
export const TUI_ONLY = ['settings', 'login', 'logout', 'scoped-models', 'tree', 'trust', 'share', 'bug', 'import', 'changelog'];

export function allCommands() {
  const list = BUILTINS.map((b) => ({ name: b.name, args: b.args, desc: b.desc, source: 'pi' }));
  for (const c of S.commands) list.push({ name: c.name, desc: c.description || '', source: c.source });
  for (const n of TUI_ONLY) if (!S.commands.some((c) => c.name === n)) list.push({ name: n, desc: '在终端版 pi 里打开', source: 'tui' });
  return list;
}

async function runSlash(text) {
  const m = text.match(/^\/(\S+)\s*([\s\S]*)$/);
  if (!m) return false;
  const [, name, arg] = m;
  if (S.commands.some((c) => c.name === name)) return false; // 交给 pi 处理
  const b = BUILTINS.find((x) => x.name === name);
  if (b) {
    await b.run(arg.trim());
    return true;
  }
  if (TUI_ONLY.includes(name)) {
    openTerminal({ command: 'pi', title: 'pi' });
    toast(`/${name} 只能在终端版 pi 里用，已经在下面的终端里打开 pi。改完设置后在这里输入 /reload 生效。`, 'info', 9000);
    return true;
  }
  return false; // 未知命令，和终端版一样当普通文字发出去
}

const requireIdle = () => {
  if (S.running) throw new Error('pi 正在运行，先停止或等它结束');
};

export const newSession = guard(async () => openDirPicker('new'));

/** 打开目录选择窗口。mode='new' 时选完目录就在那里开个新会话 */
export function openDirPicker(mode = 'switch') {
  S.dirPickerMode = mode;
  S.dirPicker = true;
}

/** 在指定目录里开始一个新会话（当前标签页）；正在跑的话不让切，免得丢内容 */
export const newSessionIn = guard(async (cwd) => {
  if (cwd) await openDirRaw(cwd);
  requireIdle();
  const d = await rpc({ type: 'new_session' });
  if (d?.cancelled) return toast('扩展取消了新建会话', 'warning');
  await reload();
});

export const pickSession = guard(async () => {
  await loadSessions();
  openPicker({
    title: '切换会话',
    items: S.sessions.map((s) => ({
      label: s.title,
      detail: `${new Date(s.modified).toLocaleString()} · ${s.messages} 条`,
      current: s.file === S.agent?.sessionFile,
      value: s,
    })),
    onPick: (s) => openSession(s.file),
  });
});

export const pickModel = guard(async (arg) => {
  const models = await loadModels();
  const pick = async (m) => {
    await setModel(m);
    toast(`模型：${m.provider}/${m.id}`);
  };
  if (arg) {
    const m = models.find((x) => `${x.provider}/${x.id}` === arg) || models.find((x) => x.id === arg) || models.find((x) => `${x.provider}/${x.id}`.includes(arg));
    if (!m) throw new Error(`找不到模型 ${arg}`);
    return pick(m);
  }
  const cur = S.state?.model;
  openPicker({
    title: '选择模型',
    items: models.map((m) => ({
      label: `${m.provider}/${m.id}`,
      detail: [m.reasoning ? '思考' : '', m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : ''].filter(Boolean).join(' · '),
      current: cur && cur.provider === m.provider && cur.id === m.id,
      value: m,
    })),
    onPick: guard(pick),
  });
});

export const pickThinking = guard(async (arg) => {
  const set = async (level) => {
    await rpc({ type: 'set_thinking_level', level });
    if (S.state) S.state.thinkingLevel = level;
  };
  if (arg) return set(arg);
  openPicker({
    title: '思考强度',
    items: S.thinkingLevels.map((l) => ({ label: l, current: l === S.state?.thinkingLevel, value: l })),
    onPick: guard(set),
  });
});

export const renameSession = guard(async (arg) => {
  let name = arg;
  if (!name) {
    const r = await ask({ method: 'input', title: '会话名称', prefill: S.state?.sessionName || '' });
    if (r.cancelled || !r.value?.trim()) return;
    name = r.value.trim();
  }
  await rpc({ type: 'set_session_name', name });
  if (S.state) S.state.sessionName = name;
  syncTitle();
  loadSessions();
});

export const compact = guard(async (arg) => {
  requireIdle();
  S.compacting = true;
  try {
    await rpc({ type: 'compact', ...(arg ? { customInstructions: arg } : {}) });
  } finally {
    S.compacting = false;
  }
  await loadMessages();
  await loadStats();
});

export const pickFork = guard(async () => {
  requireIdle();
  const d = await rpc({ type: 'get_fork_messages' });
  const list = (d.messages || []).slice().reverse();
  if (!list.length) return toast('还没有可以分叉的消息');
  openPicker({
    title: '从哪条消息分叉？',
    items: list.map((m) => ({ label: m.text.replace(/\s+/g, ' ').slice(0, 120), value: m })),
    onPick: guard(async (m) => {
      const r = await rpc({ type: 'fork', entryId: m.entryId });
      if (r?.cancelled) return toast('扩展取消了分叉', 'warning');
      await reload();
      S.composer.text = r?.text || m.text;
      toast('已分叉到新会话，可以修改这条消息后重新发送');
    }),
  });
});

export const cloneSession = guard(async () => {
  requireIdle();
  const r = await rpc({ type: 'clone' });
  if (r?.cancelled) return toast('扩展取消了复制', 'warning');
  await reload();
  toast('已复制为新会话');
});

export const showSessionInfo = guard(async () => {
  await loadStats();
  const s = S.stats || {};
  const st = S.state || {};
  const lines = [
    ['名称', st.sessionName || '(未命名)'],
    ['目录', S.cwd],
    ['文件', s.sessionFile || st.sessionFile || '(未保存)'],
    ['ID', s.sessionId || st.sessionId],
    ['模型', st.model ? `${st.model.provider}/${st.model.id}` : '-'],
    ['消息', `用户 ${s.userMessages ?? 0} · 助手 ${s.assistantMessages ?? 0} · 工具调用 ${s.toolCalls ?? 0}`],
    ['Tokens', s.tokens ? `输入 ${s.tokens.input} · 输出 ${s.tokens.output} · 缓存读 ${s.tokens.cacheRead} · 缓存写 ${s.tokens.cacheWrite}` : '-'],
    ['费用', s.cost != null ? `$${s.cost.toFixed(4)}` : '-'],
    ['上下文', s.contextUsage ? `${s.contextUsage.tokens ?? '?'} / ${s.contextUsage.contextWindow} (${s.contextUsage.percent ?? '?'}%)` : '-'],
  ];
  await ask({ method: 'info', title: '会话信息', rows: lines });
});

export const copyLast = guard(async () => {
  const d = await rpc({ type: 'get_last_assistant_text' });
  if (!d?.text) return toast('还没有回复可以复制');
  await navigator.clipboard.writeText(d.text);
  toast('已复制最后一条回复');
});

export const exportHtml = guard(async (arg) => {
  const d = await rpc({ type: 'export_html', ...(arg ? { outputPath: arg } : {}) });
  toast(`已导出：${d.path}`);
  window.open(rawUrl(d.path), '_blank');
});

export const changeDir = guard(async (arg) => {
  if (!arg) return openDirPicker('switch');
  const target = isAbsPath(arg) ? arg : joinPath(S.cwd, arg, S.info.sep);
  await openDir(target);
});

export const quitAgent = guard(async () => {
  if (!S.agentId) return;
  await call('stop', { agentId: S.agentId });
  S.agentExited = { code: 0, stderr: '', manual: true };
});

function showHotkeys() {
  ask({
    method: 'info',
    title: '快捷键',
    rows: [
      ...(UI.sendKey === 'ctrlEnter'
        ? [['Ctrl+Enter', '发送（运行中 = 插话 steer）'], ['Enter', '换行']]
        : [['Enter', '发送（运行中 = 插话 steer）'], ['Shift+Enter', '换行']]),
      ['Alt+Enter', '运行中排队到结束后（follow-up）'],
      ['Esc', '停止当前运行，排队的消息退回输入框'],
      ['/', '命令菜单，↑↓ 选择，Tab 补全'],
      ['!命令', '直接执行 shell 命令（结果进上下文）'],
      ['!!命令', '执行 shell 命令（不进上下文）'],
      ['Ctrl+V', '粘贴图片'],
      ['Ctrl+`', '打开终端标签页 / 回到对话'],
      ['Ctrl+E', '显示/隐藏文件侧栏'],
      ['Ctrl+P', '切换会话'],
      ['Ctrl+L', '切换模型'],
      ['Ctrl+B', '显示/隐藏会话侧栏'],
      ['Ctrl+,', '界面设置'],
    ],
  });
}

// ---------------- 文件 ----------------
export function openFile(path) {
  let tab = S.tabs.find((t) => normPath(t.path) === normPath(path));
  if (!tab) {
    S.tabs.push({ path, name: path.split(/[\\/]/).pop(), data: null, error: null, loading: true });
    tab = S.tabs[S.tabs.length - 1];
    loadFile(tab);
  }
  S.activeTab = tab.path;
}

export async function loadFile(tab) {
  tab.loading = true;
  try {
    tab.data = await http.get('/api/fs/read', { path: tab.path });
    tab.error = null;
  } catch (e) {
    tab.error = e.message;
  } finally {
    tab.loading = false;
  }
}

export function closeTab(path) {
  const tid = termIdOf(path);
  if (tid) return termClose(tid); // 终端关掉以后由 'terms' 消息切换标签
  const i = S.tabs.findIndex((t) => t.path === path);
  if (i < 0) return;
  S.tabs.splice(i, 1);
  if (S.activeTab === path) S.activeTab = S.tabs[i]?.path || S.tabs[i - 1]?.path || 'chat';
}

/** 关闭顶部的标签页（对话标签除外）。keep：留下的那个；有终端会先问一句，关终端会结束里面跑的程序 */
export const closeAllTabs = guard(async (keep = null) => {
  const terms = S.terms.filter((t) => termTab(t.id) !== keep);
  if (terms.length) {
    const r = await ask({
      method: 'select',
      title: `还有 ${terms.length} 个终端`,
      options: ['只关文件，终端留着', '终端也一起关掉（里面运行的程序会被结束）'],
    });
    if (r.cancelled) return;
    if (r.value?.startsWith('终端')) terms.forEach((t) => termClose(t.id)); // 关掉以后 'terms' 消息会自己切换标签
  }
  S.tabs = S.tabs.filter((t) => t.path === keep);
  // 正在看的是文件（已经关掉了）：切到留下的那个，没有就回对话
  if (S.activeTab !== 'chat' && !termIdOf(S.activeTab) && S.activeTab !== keep) S.activeTab = keep || 'chat';
});

export function insertToComposer(text) {
  const t = S.composer.text;
  S.composer.text = t + (t && !t.endsWith(' ') && !t.endsWith('\n') ? ' ' : '') + text + ' ';
  S.activeTab = 'chat';
}

export const deleteSession = guard(async (s) => {
  const r = await ask({ method: 'confirm', title: '删除会话', message: `确定删除「${s.title}」？文件会被永久删除。` });
  if (!r.confirmed) return;
  await http.del('/api/sessions', { file: s.file });
  loadSessions();
});

// ---------------- 终端 ----------------
// 终端和文件一样显示成顶部的标签页，标签名是 'term:<id>'
export const termTab = (id) => `term:${id}`;
export const termIdOf = (tab) => (typeof tab === 'string' && tab.startsWith('term:') ? tab.slice(5) : null);

export const openTerminal = guard(async ({ command, title } = {}) => {
  if (!S.info.terminal) throw new Error('后端没有可用的 node-pty，终端不可用');
  const { term } = await call('term_open', { cwd: S.cwd, cols: 120, rows: 24, command, title });
  S.activeTerm = term.id;
  S.activeTab = termTab(term.id);
});

/** Ctrl+` / 顶部终端按钮：在终端标签上就回对话；否则切到最近的终端，一个都没有就新建 */
export function toggleTerminal() {
  if (termIdOf(S.activeTab)) return (S.activeTab = 'chat');
  const id = S.terms.some((t) => t.id === S.activeTerm) ? S.activeTerm : S.terms[0]?.id;
  if (id) S.activeTab = termTab(id);
  else openTerminal();
}

export const termInput = (id, data) => fire('term_in', { id, data });
export const termResize = (id, cols, rows) => fire('term_resize', { id, cols, rows });
export const termAttach = (id) => call('term_attach', { id });
export const termClose = (id) => call('term_close', { id }).catch(() => {});
