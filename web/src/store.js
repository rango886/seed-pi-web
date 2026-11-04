// 全局状态 + 所有动作。组件只负责显示，逻辑都在这里，方便看懂。
import { reactive, computed, watch, nextTick } from 'vue';
import { connect, call, fire, http, rawUrl, upload, CID } from './api.js';
import { stripAnsi, joinPath, normPath, isAbsPath, attachKind, baseName, buildAttachmentBlock, splitAttachments, stripAttachments, setAssetBase, levelName } from './util.js';
import { view, UI } from './settings.js';

const FAV_KEY = 'seed-pi-web-favorites';
function readFavorites() {
  try {
    const list = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string' && p.trim()) : [];
  } catch {
    return [];
  }
}

export const S = reactive({
  connected: false,
  info: { home: '', sep: '/', platform: '', terminal: false },
  agents: [], // 后端所有 pi 进程
  agentId: null,
  agent: null, // 当前 pi 进程信息（cwd / sessionFile / running）
  agentExited: null,
  cwd: localStorage.getItem('seed-pi-web-cwd') || '',
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
  // 还没起 pi 进程的会话：{ cwd, file }（file 为空 = 还没说过话的新会话）。
  // 历史是后端直接读会话文件拿到的；开始打字、发消息、换模型时才起进程（ensureAgent）
  lazy: null,
  starting: false, // 正在起 pi 进程
  queue: { steering: [], followUp: [] },
  bashLive: null,
  // 扩展 UI
  dialogs: [],
  statusItems: {},
  widgets: {},
  // 界面
  // attachments：输入框上面那一排附件（顺序就是发送时的编号），每个会话各自一份
  composer: { text: '', attachments: [] },
  toasts: [],
  picker: null,
  dirPicker: false,
  dirPickerMode: 'switch', // switch 打开目录 / new 在目录新建 / compose 选择输入框工作目录
  composerFocus: 0, // 新会话或目录选择完成后，把焦点交回输入框
  tabs: [], // 打开的文件
  activeTab: 'chat', // 'chat' | 文件路径 | 'term:<终端id>'
  fsEpoch: 0,
  sessions: [],
  // 侧栏会话列表的三种看法：dir 只看当前目录 / all 全部目录 / fav 只看收藏的目录
  sessionMode: localStorage.getItem('seed-pi-web-session-mode') || 'dir',
  // 收藏的文件夹（目录选择窗口和右侧文件树右键都能加），存 localStorage
  favorites: readFavorites(),
  terms: [],
  activeTerm: null, // 最近一次看的终端（Ctrl+` 切回去用）
  connEpoch: 0,
  tick: 0, // 每来一个流式事件 +1，聊天区用它判断要不要滚到底
});

// 后台还有几个别的 pi 进程在跑（不含当前这个）
export const otherAgents = computed(() => S.agents.filter((a) => a.running && a.id !== S.agentId).length);
// 这个会话正在被别的窗口操作：这里只能看
export const viewer = computed(() => !!(S.agent?.owner && S.agent.owner !== CID && !S.agentExited));
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
  if (!S.agentId) {
    if (!S.lazy) throw new Error('还没有打开目录');
    await ensureAgent(); // 只看的会话：要用了，先把 pi 起起来
    if (!S.agentId) throw new Error('pi 进程没有启动起来');
  }
  if (viewer.value && !/^get_/.test(cmd.type) && cmd.type !== 'export_html') throw new Error('其他窗口正在使用这个会话，点「接管」以后才能操作');
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
          if (bootNew) await newSessionIn(cwd);
          // 从别的标签页指定的目录：不恢复当前标签页记着的会话
          else await openDirRaw(cwd, true, bootCwd ? null : S.agent?.sessionFile || localStorage.getItem('seed-pi-web-session'));
        } catch (e) {
          toast(e.message, 'error');
          await openDirRaw(S.info.home, true);
        }
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
  const token = localStorage.getItem('seed-pi-web-token');
  if (token) u.searchParams.set('token', token);
  window.open(u.toString(), '_blank', 'noopener');
}

function onServerMsg(msg) {
  switch (msg.t) {
    case 'agents': {
      const prev = new Map(S.agents.map((a) => [a.id, a]));
      S.agents = msg.list;
      // 别的会话回复完了、新会话第一次写盘了：侧栏列表要更新（条数、时间、标题）
      if (msg.list.some((a) => { const p = prev.get(a.id); return p && (p.lastSettledAt !== a.lastSettledAt || p.saved !== a.saved || p.sessionName !== a.sessionName); })) loadSessionsSoon();
      // 正在“只看”的会话被别的窗口起了进程：直接连上去（不会多起进程），那边写的新内容这里也能看到
      if (!S.agentId && S.lazy?.file && msg.list.some((a) => a.alive && a.sessionFile && normPath(a.sessionFile) === normPath(S.lazy.file))) {
        ensureAgent().catch(() => {});
      }
      if (S.agentId) {
        const a = msg.list.find((x) => x.id === S.agentId);
        if (a) {
          const sessionChanged = S.agent && a.sessionFile !== S.agent.sessionFile;
          const lostOwner = S.agent?.owner === CID && a.owner && a.owner !== CID;
          S.agent = a;
          if (a.sessionFile) rememberSession(a);
          if (a.cwd !== S.cwd) setCwd(a.cwd);
          if (sessionChanged) loadSessions();
          // 操作权被别的窗口拿走了：扩展弹窗归它管，这边关掉
          if (lostOwner) {
            S.dialogs = S.dialogs.filter((d) => d._resolve);
            toast('另一个窗口接管了这个会话，这里现在只能看', 'warning');
          }
        }
      }
      break;
    }
    case 'rec':
      if (msg.agentId === S.agentId) onRec(msg.rec);
      break;
    case 'agent_exit':
      if (msg.agentId === S.agentId) {
        // 别的窗口重启了 pi（/reload）：等它起来以后重新连上同一个会话
        if (msg.restart) {
          if (!restarting && msg.sessionFile) setTimeout(() => reopenSession(msg.sessionFile, msg.cwd), 1500);
          break;
        }
        // 闲置回收、手动关闭：不算出错，退回“只看”，内容照旧显示，要用时再起进程
        if (msg.quiet) {
          openLazy({ cwd: msg.cwd, file: msg.saved ? msg.sessionFile : null }, { keep: true });
          break;
        }
        S.agentExited = { code: msg.code, stderr: msg.stderr };
        S.running = false;
      }
      break;
    // 操作者在另一个窗口 fork / clone 了：那个进程跟着它去了新会话，这里留在原来的会话上
    case 'session_moved':
      if (msg.agentId === S.agentId) {
        S.agentId = null;
        reopenSession(msg.from, msg.cwd);
      }
      break;
    // 操作者改了模型、压缩了、跑了 shell ……：旁观的窗口跟着刷新
    case 'state_changed':
      if (msg.agentId === S.agentId) {
        loadState();
        loadStats();
        if (msg.cmd === 'bash' || msg.cmd === 'compact') loadMessages();
      }
      break;
    case 'notice':
      toast(msg.text, msg.kind || 'info', 8000);
      break;
    case 'terms':
      S.terms = msg.list;
      if (S.activeTerm && !msg.list.some((t) => t.id === S.activeTerm)) S.activeTerm = msg.list[0]?.id || null;
      // 正在看的终端没了（关掉、shell 退出）：切到另一个终端，没有就回对话
      if (termIdOf(S.activeTab) && !msg.list.some((t) => t.id === termIdOf(S.activeTab))) {
        S.activeTab = S.activeTerm ? termTab(S.activeTerm) : S.tabs[S.tabs.length - 1]?.id || 'chat';
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
  setAssetBase(cwd); // markdown 里的相对图片路径按这个目录找文件
  localStorage.setItem('seed-pi-web-cwd', cwd);
  syncTitle();
  if (S.agent?.sessionFile) rememberSession(S.agent);
  S.fsEpoch++;
}

// 每个目录上次用的是哪个会话：打开目录时优先回到它
const LAST_KEY = 'seed-pi-web-last-session';
function rememberSession(a) {
  localStorage.setItem('seed-pi-web-session', a.sessionFile);
  if (!a.cwd) return;
  let m = {};
  try {
    m = JSON.parse(localStorage.getItem(LAST_KEY) || '{}');
  } catch {}
  if (m[normPath(a.cwd)] === a.sessionFile) return;
  delete m[normPath(a.cwd)];
  m[normPath(a.cwd)] = a.sessionFile;
  const keys = Object.keys(m);
  for (const k of keys.slice(0, Math.max(0, keys.length - 100))) delete m[k];
  localStorage.setItem(LAST_KEY, JSON.stringify(m));
}
function lastSessionOf(cwd) {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) || '{}')[normPath(cwd)] || null;
  } catch {
    return null;
  }
}

// ---- 侧栏的状态图标：运行中 / 等你操作 / 有新回复没看 / 别的窗口正在用 ----
// “看没看过”每个浏览器各记各的：会话文件 -> 上次看到它的时间
const SEEN_KEY = 'seed-pi-web-seen';
const seen = reactive((() => {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
  } catch {
    return {};
  }
})());
function markSeen() {
  const f = S.agent?.sessionFile;
  if (!f || document.hidden) return;
  seen[normPath(f)] = Date.now();
  const keys = Object.keys(seen);
  for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete seen[k];
  localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
}
watch(() => [S.agent?.sessionFile, S.agent?.lastSettledAt], markSeen);
document.addEventListener('visibilitychange', markSeen);

const agentByFile = computed(() => {
  const m = new Map();
  for (const a of S.agents) if (a.sessionFile) m.set(normPath(a.sessionFile), a);
  return m;
});
/** 某个会话现在是什么状态（侧栏、进程列表用） */
export function sessionStatus(file) {
  const k = normPath(file || '');
  const a = agentByFile.value.get(k);
  if (!a) return null;
  const current = a.id === S.agentId;
  return {
    running: a.running,
    waiting: a.waitingUi,
    unread: !current && !a.running && a.lastSettledAt > (seen[k] || 0),
    elsewhere: !!(a.owner && a.owner !== CID),
  };
}

let sessionsTimer = null;
function loadSessionsSoon() {
  clearTimeout(sessionsTimer);
  sessionsTimer = setTimeout(loadSessions, 400);
}

/** 重新连上某个会话；会话文件还没写盘（没说过话的新会话）就回到那个目录 */
async function reopenSession(file, cwd) {
  try {
    await openSessionRaw(file);
  } catch {
    await openDirRaw(cwd || S.cwd, true, null).catch((e) => toast(e.message, 'error'));
  }
}

/** 顶栏 / 浏览器标签页显示的会话名：自定义名 > 第一条用户消息 > 目录名 */
export function sessionTitle() {
  if (S.state?.sessionName) return S.state.sessionName;
  const first = S.messages.find((m) => m.role === 'user');
  const c = first?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b) => b.type === 'text')?.text || '' : '';
  const line = stripAttachments(text).replace(/\s+/g, ' ').trim().slice(0, 60);
  if (line) return line;
  return (S.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '新会话';
}

/** 开多个标签页时，靠标签标题区分是哪个会话（太长就截一下，不然标签挤成一坨） */
export function syncTitle() {
  const t = sessionTitle();
  document.title = t.length > 28 ? t.slice(0, 28) + '…' : t;
}

/** 连上一个 pi 进程。后端的回复里带着快照：写完的消息 + 进行中的事件（正在吐的字、正在跑的工具）。
 *  keep：从“只看”接上进程，消息和已经显示的一样就不重新渲染（长对话重新解析 Markdown 会卡一下） */
async function attachResult({ agent, uiPending, uiState, messages, live }, { keep = false } = {}) {
  S.agentId = agent.id;
  S.agent = agent;
  S.agentExited = null;
  S.detached = null;
  S.lazy = null;
  S.dialogs = S.dialogs.filter((d) => d._resolve).concat(uiPending || []);
  S.statusItems = {};
  S.widgets = {};
  for (const r of uiState || []) onUiRequest(r);
  S.retry = null;
  S.compacting = false;
  S.queue = { steering: [], followUp: [] };
  S.bashLive = null;
  S.running = !!agent.running;
  setCwd(agent.cwd);
  if (!(keep && !live?.length && sameMessages(messages))) setMessages(messages);
  // 补放进行中的事件：和一直开着这个窗口的效果一样
  for (const rec of live || []) onRec(rec);
  flushDeltas();
  await Promise.all([loadState(), loadCommands(), loadStats()]);
  loadSessions();
}

/** pi 给的消息和现在显示的是不是同一份（条数、角色、时间都对得上） */
function sameMessages(list) {
  const f = (list || []).filter((m) => m.role !== 'system' && m.role !== 'toolResult');
  return f.length === S.messages.length && f.every((m, i) => m.role === S.messages[i].role && m.timestamp === S.messages[i].timestamp);
}

// “只看”时没法问 pi 的东西，用上次问到的顺着显示：思考强度有哪几档、每个会话的上下文占用
const LEVELS_KEY = 'seed-pi-web-thinking-levels';
const CTX_KEY = 'seed-pi-web-context-usage';
const readJson = (k, d) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? d;
  } catch {
    return d;
  }
};
function rememberCtx(file, usage) {
  if (!file) return;
  const m = readJson(CTX_KEY, {});
  delete m[normPath(file)];
  if (usage) m[normPath(file)] = usage;
  const keys = Object.keys(m);
  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete m[k];
  localStorage.setItem(CTX_KEY, JSON.stringify(m));
}

/**
 * “只看”一个会话：不起 pi 进程，内容是后端从会话文件里读的。
 * keep：进程刚被回收，界面上的消息、模型、用量都还对，原样留着
 */
function openLazy({ cwd, file, messages, state, stats }, { keep = false } = {}) {
  S.agentId = null;
  S.lazy = { cwd, file: file || null };
  S.agent = { id: null, cwd, sessionFile: file || null, sessionName: (keep ? S.state?.sessionName : state?.sessionName) || null, alive: false, saved: !!file, running: false, owner: null, lazy: true };
  S.agentExited = null;
  S.detached = null;
  S.dialogs = S.dialogs.filter((d) => d._resolve);
  S.statusItems = {};
  S.widgets = {};
  S.retry = null;
  S.compacting = false;
  S.queue = { steering: [], followUp: [] };
  S.bashLive = null;
  S.running = false;
  if (S.state) S.state.isStreaming = false;
  if (!keep) {
    S.state = state || null;
    S.stats = stats ? { ...stats, contextUsage: file ? readJson(CTX_KEY, {})[normPath(file)] : undefined } : null;
    S.thinkingLevels = readJson(LEVELS_KEY, []);
    setMessages(messages);
  }
  setCwd(cwd);
  syncTitle();
  loadSessions();
}

/**
 * 把“只看”的会话变成能用的：后端起一个 pi 进程（已经有就直接连上）。
 * 同时只会有一次启动，几处一起调用等的是同一个
 */
let ensuring = null;
let adoptDraft = false; // 新会话起了进程以后有了会话文件：输入框上已经加的附件跟着它走
export function ensureAgent() {
  if (S.agentId) return Promise.resolve();
  if (!S.lazy) return Promise.reject(new Error('还没有打开目录'));
  if (ensuring) return ensuring;
  const lz = S.lazy;
  S.starting = true;
  ensuring = (async () => {
    const res = await call('ensure_agent', { cwd: lz.cwd, file: lz.file });
    // 等进程的时候已经切到别的会话了：这个进程先不看了（没人用会被自动回收）
    if (S.lazy !== lz) {
      call('leave', { agentId: res.agent.id }).catch(() => {});
      return;
    }
    adoptDraft = !lz.file;
    try {
      await attachResult(res, { keep: true });
    } finally {
      adoptDraft = false;
    }
  })().finally(() => {
    ensuring = null;
    S.starting = false;
  });
  return ensuring;
}

/** 历史会话开始编辑时预热；新会话草稿等首次发送（或修改模型等操作）才启动。 */
export function warmUp() {
  if (S.agentId || !S.lazy?.file || ensuring) return;
  ensureAgent().catch((e) => toast(e.message, 'error'));
}

/** 后端打开会话 / 目录的回复：可能是连上了进程，也可能只看（lazy）、目录不在了（detached） */
async function present(res) {
  if (res?.lazy) return openLazy(res.lazy);
  if (res?.detached) return openDetached(res.detached);
  await attachResult(res);
}

async function openDirRaw(cwd, force = false, sessionFile) {
  if (!force && (S.lazy || (S.agent?.alive && !S.agentExited)) && normPath(S.agent?.cwd || '') === normPath(cwd)) return;
  // sessionFile：undefined = 用这个目录上次的会话；null = 不指定，由后端挑
  await present(await call('attach', { cwd, sessionFile: sessionFile === undefined ? lastSessionOf(cwd) : sessionFile }));
}
export const openDir = guard(openDirRaw);

async function openSessionRaw(file) {
  await present(await call('open_session', { file }));
}
export const openSession = guard(openSessionRaw);

/** 把操作权拿过来（另一个窗口正在用，比如别的电脑上忘了关） */
export const takeOver = guard(async () => {
  if (!S.agentId) return;
  const r = await call('take_over', { agentId: S.agentId });
  S.dialogs = S.dialogs.filter((d) => d._resolve).concat(r.uiPending || []);
  toast('已接管这个会话');
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
  S.lazy = null;
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
  setAssetBase(cwd);
  S.fsEpoch++;
  setMessages(messages);
  S.activeTab = 'chat';
  syncTitle();
}


let restarting = false;
export const restartAgent = guard(async () => {
  if (S.running) return toast('正在运行，先停止再重新加载', 'warning');
  // 还没起进程：现在起一个就是最新的扩展、技能、设置
  if (S.lazy) {
    await ensureAgent();
    return toast('已启动 pi');
  }
  if (!S.agentId || S.agentExited) return restartExited();
  if (viewer.value) throw new Error('其他窗口正在使用这个会话，点「接管」以后才能操作');
  restarting = true;
  try {
    await attachResult(await call('restart', { agentId: S.agentId }));
  } finally {
    restarting = false;
  }
  toast('已重新加载 pi（扩展、技能、设置）');
});

/** 进程退出以后的「重新启动」：回到同一个会话，马上把 pi 起起来 */
export const restartExited = guard(async () => {
  const file = S.agent?.saved ? S.agent.sessionFile : null;
  openLazy({ cwd: S.cwd, file }, { keep: true });
  await ensureAgent();
});

/** 进程面板上的“强行关闭”：不管是谁在操作、是不是正在跑，直接把这个 pi 进程关掉（会话文件不删）。点了就关，不弹确认框 */
export const killAgent = guard(async (a) => {
  const name = a.sessionName || (a.saved ? '未命名会话' : '新会话');
  await call('force_stop', { agentId: a.id });
  toast(`已关闭「${name}」的进程`);
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
  if (!S.agentId) return;
  const d = await rpc({ type: 'get_messages' }).catch(() => ({ messages: [] }));
  setMessages(d.messages);
}

// 下面几个只是刷新显示：没有进程就算了，不为这个去起 pi
async function loadState() {
  if (!S.agentId) return;
  try {
    S.state = await rpc({ type: 'get_state' });
    S.running = !!S.state.isStreaming;
    S.compacting = !!S.state.isCompacting;
    const t = await rpc({ type: 'get_available_thinking_levels' });
    S.thinkingLevels = t.levels || [];
    localStorage.setItem(LEVELS_KEY, JSON.stringify(S.thinkingLevels));
    syncTitle();
  } catch {}
}

async function loadStats() {
  if (!S.agentId) return;
  S.stats = await rpc({ type: 'get_session_stats' }).catch(() => null);
  if (S.stats && S.agent?.sessionFile) rememberCtx(S.agent.sessionFile, S.stats.contextUsage);
}

async function loadCommands() {
  if (!S.agentId) return;
  const d = await rpc({ type: 'get_commands' }).catch(() => ({ commands: [] }));
  S.commands = d.commands || [];
}

export async function loadSessions() {
  if (!S.cwd) return;
  // 只看当前目录时带 cwd；看全部 / 看收藏时都要拿全量，收藏是在前端按目录筛的
  const query = S.sessionMode === 'dir' ? { cwd: S.cwd } : { all: 1 };
  S.sessions = await http.get('/api/sessions', query).catch(() => []);
}

// ---------------- 收藏的文件夹 ----------------
const saveFavorites = () => localStorage.setItem(FAV_KEY, JSON.stringify(S.favorites));

/** 这个目录是不是已经收藏了（大小写、末尾分隔符不算区别） */
export const isFav = (p) => !!p && S.favorites.some((f) => normPath(f) === normPath(p));

/** 收藏 / 取消收藏一个文件夹；新收藏的放在最前面 */
export function toggleFavorite(p) {
  if (!p) return;
  const fav = isFav(p);
  S.favorites = fav ? S.favorites.filter((f) => normPath(f) !== normPath(p)) : [p, ...S.favorites];
  saveFavorites();
  toast(fav ? `已取消收藏 ${p}` : `已收藏 ${p}`);
}

/**
 * 拖动收藏列表调整顺序：把 from 这一条挪到 to 那一行；after 为真就插在它后面。
 * 顺序本身就存在 localStorage 的数组里，改完写回去就行
 */
export function moveFavorite(from, to, after = false) {
  const key = (p) => normPath(p);
  const i = S.favorites.findIndex((f) => key(f) === key(from));
  if (i < 0) return;
  const item = S.favorites[i];
  const rest = S.favorites.filter((_, k) => k !== i); // 先把自己摘出来，后面的位置才算得准
  const j = rest.findIndex((f) => key(f) === key(to));
  if (j < 0) return;
  rest.splice(after ? j + 1 : j, 0, item);
  if (rest.every((p, k) => p === S.favorites[k])) return; // 落回原处：不用白存一次
  S.favorites = rest;
  saveFavorites();
}

/** 侧栏换一种看法（当前目录 / 全部 / 收藏），顺手把列表重新拉一遍 */
export function setSessionMode(m) {
  if (!m || m === S.sessionMode) return;
  S.sessionMode = m;
  localStorage.setItem('seed-pi-web-session-mode', m);
  loadSessions();
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
  const recent = JSON.parse(localStorage.getItem('seed-pi-web-recent-models') || '[]').filter((k) => k !== `${m.provider}/${m.id}`);
  recent.unshift(`${m.provider}/${m.id}`);
  localStorage.setItem('seed-pi-web-recent-models', JSON.stringify(recent.slice(0, 6)));
});

export const setThinking = guard(async (level) => {
  await rpc({ type: 'set_thinking_level', level });
  if (S.state) S.state.thinkingLevel = level;
});

/**
 * 把某个模型设为“新会话的默认”：pi 的 RPC 里没有这个命令（set_model 只改当前会话），
 * 所以让后端去改它的全局 settings.json，下次 pi 启动时读的就是它
 */
export const setDefaultModel = guard(async (m) => {
  await http.post('/api/settings/default', { provider: m.provider, modelId: m.id });
  toast(`新会话的默认模型已设为 ${m.name || m.id}`);
});

/** 把某一档思考强度设为“新会话的默认”（同样写 settings.json 的 defaultThinkingLevel） */
export const setDefaultThinking = guard(async (level) => {
  await http.post('/api/settings/default', { thinkingLevel: level });
  toast(`新会话的默认思考强度已设为${levelName(level)}`);
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
    for (const tab of S.tabs.filter((t) => normPath(t.path) === abs)) loadFile(tab);
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
  const atts = S.composer.attachments;
  const ready = atts.filter((a) => a.status === 'ready' && a.path);
  if (!text.trim() && !ready.length) {
    if (atts.some((a) => a.status === 'uploading')) toast('附件还在上传，稍等一下', 'warning');
    return false;
  }
  try {
    // 内置命令、! shell 命令跟附件没关系：照常执行，附件留着
    if (text.startsWith('/')) {
      const handled = await runSlash(text.trim());
      if (handled) return true;
    }
    if (text.startsWith('!')) return await runBash(text);
    if (atts.some((a) => a.status === 'uploading')) {
      toast('附件还在上传，稍等一下', 'warning');
      return false;
    }
    // 附件只发路径：拼在提示词最后面（会话名、斜杠命令都看的是开头，放前面会干扰）
    let message = text;
    if (ready.length) {
      const block = buildAttachmentBlock(ready);
      message = text.trim() ? `${text.replace(/\s+$/, '')}\n\n${block}` : block;
    }
    const cmd = { type: 'prompt', message };
    if (S.running) cmd.streamingBehavior = followUp ? 'followUp' : 'steer';
    await rpc(cmd);
    if (ready.length && !UI.keepAttachments) clearAttachments();
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}

// ---------------- 附件 ----------------
// 每个附件最后都变成一个后端机器上的路径（pi 跑在后端那台机器上，要的是那边的路径）：
//   tree      从右侧文件树拖进来 / 点 @         → 原文件
//   mention   输入框里 @ 补全选的                  → 原文件
//   clipboard 本机资源管理器复制、这里 Ctrl+V      → 原文件（后端读剪贴板拿到的真实路径）
//   upload    资源管理器拖进来、截图、局域网访问  → 上传到临时目录后的路径
export const ORIGIN_LABEL = {
  tree: '原文件（来自文件树）',
  mention: '原文件（@ 引用）',
  clipboard: '原文件（从剪贴板粘贴）',
  upload: '已上传到临时目录',
  path: '原文件',
};
let attSeq = 0;
function makeAtt(p) {
  return reactive({
    id: ++attSeq,
    kind: p.kind || attachKind(p.name || p.path, p.dir),
    name: p.name || baseName(p.path),
    path: p.path || '',
    size: p.size ?? null,
    origin: p.origin || 'path',
    status: p.status || 'ready', // ready | uploading
    progress: 0,
    preview: p.preview || '', // 上传中的图片先用本地 blob 当缩略图
    broken: false, // 缩略图加载不出来（文件被删了、不是真图片）就显示成文件图标
  });
}

/** 加一组已经知道路径的附件（同一个文件不重复加） */
export function attachPaths(list, origin = 'path') {
  let added = 0;
  for (const it of list) {
    if (!it?.path) continue;
    if (S.composer.attachments.some((a) => a.path && normPath(a.path) === normPath(it.path))) continue;
    S.composer.attachments.push(makeAtt({ ...it, origin: it.origin || origin }));
    added++;
  }
  if (added) {
    S.activeTab = 'chat';
    warmUp();
  }
  return added;
}

const pad = (n) => String(n).padStart(2, '0');
function pastedName(f) {
  const d = new Date();
  const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\W.*/, '');
  return `paste-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
}

/** 浏览器里的文件（拿不到路径）：上传到后端的临时目录，用上传后的路径。pasted：剪贴板里的截图，没有像样的文件名 */
export function uploadFiles(files, { pasted = false } = {}) {
  const max = (Number(UI.uploadMaxMB) || 0) * 1048576;
  if (files.length) warmUp();
  for (const f of files) {
    if (max && f.size > max) {
      toast(`${f.name} 太大了（上限 ${UI.uploadMaxMB}MB，可以在设置里改）`, 'warning');
      continue;
    }
    const name = !f.name || (pasted && /^image\.\w+$/i.test(f.name)) ? pastedName(f) : f.name;
    const item = makeAtt({ name, size: f.size, origin: 'upload', status: 'uploading', preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : '' });
    S.composer.attachments.push(item);
    upload(f, { name, dir: UI.uploadDir, cwd: S.cwd, session: S.state?.sessionId, maxMB: UI.uploadMaxMB }, (p) => (item.progress = p))
      .then((r) => Object.assign(item, { path: r.path, name: r.name, size: r.size, status: 'ready' }))
      .catch((e) => {
        toast(`${name} 上传失败：${e.message}`, 'error');
        removeAttachment(item);
      });
  }
}

/**
 * Ctrl+V 粘贴了文件。本机打开的网页：先问后端剪贴板里的路径列表（资源管理器复制文件时放进去的），
 * 按文件名 + 大小跟浏览器给的文件对上了就直接用原路径；对不上的（截图之类）照常上传。
 * files 为空：浏览器没给文件也没给文字，只看后端剪贴板
 */
export async function pasteFiles(files) {
  let list = [];
  if (S.info.local) list = await http.get('/api/clipboard/files').then((r) => r.files || [], () => []);
  if (!list.length) return files.length ? uploadFiles(files, { pasted: true }) : false;
  const used = new Set();
  const rest = [];
  for (const f of files) {
    const i = list.findIndex((c, j) => !used.has(j) && c.name === f.name && (c.dir || c.size === f.size));
    if (i >= 0) used.add(i);
    else rest.push(f);
  }
  // 浏览器给的全对上了：剪贴板里的全部文件都加上（有的浏览器只给第一个，或者不给文件夹）
  const pick = rest.length ? list.filter((_, j) => used.has(j)) : list;
  attachPaths(pick.map((c) => ({ path: c.path, name: c.name, size: c.dir ? null : c.size, dir: c.dir })), 'clipboard');
  if (rest.length) uploadFiles(rest, { pasted: true });
  return true;
}

export function removeAttachment(a) {
  const i = S.composer.attachments.indexOf(a);
  if (i >= 0) S.composer.attachments.splice(i, 1);
  if (a.preview) URL.revokeObjectURL(a.preview);
}
export function clearAttachments() {
  for (const a of S.composer.attachments) if (a.preview) URL.revokeObjectURL(a.preview);
  S.composer.attachments = [];
}
export function moveAttachment(from, to) {
  const l = S.composer.attachments;
  if (from === to || from < 0 || to < 0 || from >= l.length || to >= l.length) return;
  l.splice(to, 0, l.splice(from, 1)[0]);
}

/** 取回一条发过的消息（分叉、停止时退回排队消息）：正文放回输入框，附件放回上面那一排 */
function restoreMessage(raw) {
  const { text, attachments } = splitAttachments(raw || '');
  attachPaths(attachments.map((a) => ({ path: a.path, kind: a.kind, origin: 'path' })));
  return text;
}

// 每个会话各自一排附件：切会话时换一份，刷新页面也还在（localStorage 里只存路径）
const ATT_KEY = 'seed-pi-web-attachments';
let attSaved = {};
try {
  attSaved = JSON.parse(localStorage.getItem(ATT_KEY) || '{}');
} catch {}
const attLive = new Map(); // 内存里的：切走时还在上传的也能接着传完
let attCur = '';
// 还没说过话、也没起进程的新会话没有会话文件：按目录算一份草稿
const attKeyOf = () => S.agent?.sessionFile || S.detached?.file || (S.lazy ? `draft:${normPath(S.lazy.cwd)}` : '');
function saveAtt() {
  if (!attCur) return;
  const list = S.composer.attachments.filter((a) => a.status === 'ready' && a.path).map(({ kind, name, path, size, origin }) => ({ kind, name, path, size, origin }));
  delete attSaved[attCur];
  if (list.length) attSaved[attCur] = list;
  const keys = Object.keys(attSaved);
  for (const k of keys.slice(0, Math.max(0, keys.length - 80))) delete attSaved[k];
  localStorage.setItem(ATT_KEY, JSON.stringify(attSaved));
}
watch(attKeyOf, (k) => {
  if (k === attCur) return;
  // 草稿变成了真的会话（新会话刚起了进程）：附件不动，只是换个地方存
  if (adoptDraft && attCur.startsWith('draft:')) {
    adoptDraft = false;
    delete attSaved[attCur];
    attLive.delete(attCur);
    attCur = k;
    saveAtt();
    return;
  }
  attLive.set(attCur, S.composer.attachments);
  attCur = k;
  S.composer.attachments = attLive.get(k) || (attSaved[k] || []).map(makeAtt);
});
watch(() => S.composer.attachments.map((a) => a.status + a.path).join('|'), saveAtt);

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
  if (!S.agentId) return;
  if (S.bashLive) return rpc({ type: 'abort_bash' });
  if (S.retry) await rpc({ type: 'abort_retry' }).catch(() => {});
  const q = await rpc({ type: 'clear_queue' }).catch(() => null);
  const back = [...(q?.steering || []), ...(q?.followUp || [])].map(restoreMessage).join('\n');
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
  { name: 'quit', desc: '关闭这个会话的 pi 进程', run: () => quitAgent() },
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

export const newSession = guard(async () => {
  const cwd = S.cwd || S.info.home;
  if (!cwd) return openDirPicker('new');
  await newSessionRaw(cwd);
});

/** 打开目录选择窗口。mode='new' 时选完目录就在那里开个新会话 */
export function openDirPicker(mode = 'switch') {
  S.dirPickerMode = mode;
  S.dirPicker = true;
}

/** 在指定目录里开始一个新会话（当前标签页）。原来的会话在后台接着跑。 */
async function newSessionRaw(cwd) {
  await present(await call('create_session', { cwd: cwd || S.cwd }));
  S.composer.text = '';
  S.activeTab = 'chat';
  S.composerFocus++;
}
export const newSessionIn = guard(newSessionRaw);

/** 输入前换目录：保留正在写的内容；已有消息时，明确另开一个会话。 */
export const chooseDirectory = guard(async (cwd) => {
  if (normPath(cwd) === normPath(S.cwd) && !S.detached) {
    S.composerFocus++;
    return;
  }
  const isDraft = !S.messages.length && !S.agent?.saved && !S.lazy?.file && !S.detached;
  const text = S.composer.text;
  const attachments = S.composer.attachments;
  await newSessionRaw(cwd);
  if (isDraft) {
    await nextTick(); // 先让会话附件的切换完成，再迁移这份未发送的草稿
    S.composer.text = text;
    S.composer.attachments = attachments;
  } else {
    toast('已在所选目录开始新会话，原对话已保留');
  }
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
    items: S.thinkingLevels.map((l) => ({ label: levelName(l), current: l === S.state?.thinkingLevel, value: l })),
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
    items: list.map((m) => ({ label: stripAttachments(m.text).replace(/\s+/g, ' ').trim().slice(0, 120) || '（只有附件）', value: m })),
    onPick: guard(async (m) => {
      const r = await rpc({ type: 'fork', entryId: m.entryId });
      if (r?.cancelled) return toast('扩展取消了分叉', 'warning');
      await reload();
      S.composer.text = restoreMessage(r?.text || m.text);
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
  // 还没起进程：直接从显示的消息里找，不为这个起 pi
  const local = () => {
    const m = [...S.messages].reverse().find((x) => x.role === 'assistant' && Array.isArray(x.content) && x.content.some((b) => b.type === 'text' && b.text));
    return { text: m ? m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '' };
  };
  const d = S.agentId ? await rpc({ type: 'get_last_assistant_text' }) : local();
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
  if (!S.agentId) return toast('这个会话现在没有 pi 进程');
  if (viewer.value) throw new Error('其他窗口正在使用这个会话，点「接管」以后才能操作');
  // 关掉以后后端会发 agent_exit（quiet），这里退回“只看”，再打字会重新起进程
  await call('stop', { agentId: S.agentId });
  toast('已关闭这个会话的 pi 进程');
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
      ['Ctrl+V', '粘贴图片 / 文件（本机打开时，资源管理器复制的文件直接用原路径）'],
      ['@', '引用项目里的文件，选中后变成附件'],
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
/** 打开文件标签页。line：打开后滚到哪一行（模型回复里的 a.js:12 这种） */
export function openFile(path, { line = 0 } = {}) {
  let tab = S.tabs.find((t) => !t.diff && normPath(t.path) === normPath(path));
  if (!tab) {
    S.tabs.push({ id: path, path, name: path.split(/[\\/]/).pop(), data: null, error: null, loading: true, line: 0, jump: 0 });
    tab = S.tabs[S.tabs.length - 1];
    loadFile(tab);
  }
  if (line) {
    tab.line = line;
    tab.jump = (tab.jump || 0) + 1; // 同一行再点一次也要重新滚过去
  }
  S.activeTab = tab.id;
}

/** 三种对比各自复用标签，不覆盖同一文件的普通预览。cwd 固定在打开时的仓库。 */
export function openDiff(path, { mode = 'working', cwd = S.cwd } = {}) {
  const id = `diff:${mode}:${normPath(cwd)}:${normPath(path)}`;
  let tab = S.tabs.find((t) => t.id === id);
  if (!tab) {
    S.tabs.push({ id, path, cwd, mode, diff: true, name: path.split(/[\\/]/).pop(), data: null, error: null });
    tab = S.tabs[S.tabs.length - 1];
  }
  loadFile(tab);
  S.activeTab = id;
}

export async function loadFile(tab) {
  const request = (tab.request || 0) + 1;
  tab.request = request;
  tab.loading = true;
  try {
    const data = tab.diff
      ? await http.get('/api/git/diff', { cwd: tab.cwd, path: tab.path, mode: tab.mode })
      : await http.get('/api/fs/read', { path: tab.path });
    if (tab.request !== request) return;
    tab.data = data;
    tab.error = null;
  } catch (e) {
    if (tab.request === request) tab.error = e.message;
  } finally {
    if (tab.request === request) tab.loading = false;
  }
}

export function closeTab(path) {
  const tid = termIdOf(path);
  if (tid) return termClose(tid); // 终端关掉以后由 'terms' 消息切换标签
  const i = S.tabs.findIndex((t) => t.id === path);
  if (i < 0) return;
  S.tabs.splice(i, 1);
  if (S.activeTab === path) S.activeTab = S.tabs[i]?.id || S.tabs[i - 1]?.id || 'chat';
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
  S.tabs = S.tabs.filter((t) => t.id === keep);
  // 正在看的是文件（已经关掉了）：切到留下的那个，没有就回对话
  if (S.activeTab !== 'chat' && !termIdOf(S.activeTab) && S.activeTab !== keep) S.activeTab = keep || 'chat';
});

export function insertToComposer(text) {
  const t = S.composer.text;
  S.composer.text = t + (t && !t.endsWith(' ') && !t.endsWith('\n') ? ' ' : '') + text + ' ';
  S.activeTab = 'chat';
}

/** 文件树 / 文件查看器里的「@ 引用」：加到输入框上面的附件里（用原路径） */
export function attachFromTree(path, dir = false) {
  if (!attachPaths([{ path, dir }], 'tree')) toast('已经在附件里了');
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
