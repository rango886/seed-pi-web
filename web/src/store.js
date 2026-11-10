// 全局状态 + 所有动作。组件只负责显示，逻辑都在这里，方便看懂。
import { reactive, computed, watch, nextTick } from 'vue';
import { connect, call, fire, http, rawUrl, upload, CID } from './api.js';
import { stripAnsi, joinPath, normPath, isAbsPath, attachKind, baseName, buildAttachmentBlock, splitAttachments, stripAttachments, setAssetBase, levelName, textOf, imagesOf } from './util.js';
import { view, UI } from './settings.js';

// 收藏的目录存在后端数据目录（~/.seed-pi-web/favorites.json），连上后端后拉下来

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
  conversation: null, // stable entry ids, user-only tree, current-path usage
  branchesOpen: false,
  branchBusy: false,
  edit: null, // unsent inline edit; submission alone moves the pi cursor
  branchJump: null,
  branchBack: [],
  tools: {}, // toolCallId -> { status, args, partial, result, durationMs }
  running: false,
  compacting: false,
  retry: null,
  detached: null, // 目录已不存在的会话：{ file, cwd }，只读看历史，不能对话
  // 还没起 pi 进程的会话：{ cwd, file }（file 为空 = 还没说过话的新会话）。
  // 历史和模型目录由后端直接读取；发送消息或执行其他需要 pi 的命令时才起进程。
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
  composer: { text: '', attachments: [], images: [] },
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
  favorites: [],
  terms: [],
  activeTerm: null, // 最近一次看的终端（Ctrl+` 切回去用）
  connEpoch: 0,
  tick: 0, // 每来一个流式事件 +1，聊天区用它判断要不要滚到底
});

// 运行时有效用量优先；历史 JSONL 或压缩后没有有效 usage 时，用当前路径估计。
// 换模型不能继续拿旧模型的请求 token 数，只能退回保留内容的粗估。
export const contextUsage = computed(() => {
  const live = S.stats?.contextUsage;
  if (live?.tokens != null && Number.isFinite(live.percent)) return live;
  const estimate = S.stats?.contextEstimate;
  if (!estimate) return live;
  const model = S.state?.model;
  const catalogModel = S.models.find((m) => m.provider === model?.provider && m.id === model?.id);
  const window = model?.contextWindow ?? catalogModel?.contextWindow;
  if (!Number.isFinite(window) || window <= 0) return undefined;
  const sameModel = estimate.usageModel?.provider === model?.provider && estimate.usageModel?.id === model?.id;
  const tokens = sameModel ? estimate.tokens : estimate.contentTokens;
  if (!Number.isFinite(tokens) || tokens < 0) return undefined;
  return { tokens, contextWindow: window, percent: tokens / window * 100, estimated: true };
});

// 后台还有几个别的 pi 进程在跑（不含当前这个）
export const otherAgents = computed(() => S.agents.filter((a) => a.running && a.id !== S.agentId).length);
// 这个会话正在被别的窗口操作：这里只能看
export const viewer = computed(() => !!(S.agent?.owner && S.agent.owner !== CID && !S.agentExited));
// 输入框上面那行状态信息有没有东西可显示：顶部栏的状态按钮靠它决定要不要出现
export const hasStatus = computed(() => !!(S.stats?.tokens || S.stats?.contextUsage || otherAgents.value || Object.keys(S.statusItems).length));

// ---------------- 小工具 ----------------
let keySeq = 0;
let viewRevision = 0;
const withKey = (m) => ({ ...m, _k: ++keySeq });

export function toast(text, kind = 'info', ms = 4000, action = null) {
  const t = { id: ++keySeq, text: stripAnsi(String(text)), kind, action };
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
        syncFavorites();
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
    case 'branch_changed':
      if (msg.agentId === S.agentId && msg.snapshot) {
        applyConversation(msg.snapshot, !['web_label', 'web_restore_selection'].includes(msg.kind));
        loadState();
        loadStats();
      }
      break;
    case 'session_deleted':
      sessionDeleted(msg.file);
      break;
    case 'session_archive':
      for (const s of S.sessions) if (normPath(s.file) === normPath(msg.file)) s.archived = msg.archived;
      loadSessionsSoon();
      break;
    case 'favorites':
      if (Array.isArray(msg.list)) S.favorites = msg.list;
      break;
    case 'session_star':
      for (const s of S.sessions) if (normPath(s.file) === normPath(msg.file)) s.starred = msg.starred;
      break;
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
  viewRevision++;
  const changedSession = normPath(S.agent?.sessionFile) !== normPath(agent.sessionFile);
  if (changedSession) { S.edit = null; S.conversation = null; S.branchBack = []; }
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
  await Promise.all([loadCommands(), loadConversation()]);
  await Promise.all([loadState(), loadStats()]);
  loadSessions();
}

/** pi 给的消息和现在显示的是不是同一份（条数、角色、时间都对得上） */
function sameMessages(list) {
  const f = (list || []).filter((m) => m.role !== 'system' && m.role !== 'toolResult');
  return f.length === S.messages.length && f.every((m, i) => m.role === S.messages[i].role && m.timestamp === S.messages[i].timestamp);
}

// 上次读取的会话上下文占用；模型和思考档位不使用持久化缓存。
const CTX_KEY = 'seed-pi-web-context-usage';
const readJson = (k, d) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? d;
  } catch {
    return d;
  }
};
function rememberCtx(file, usage, leafId, model) {
  if (!file) return;
  const m = readJson(CTX_KEY, {});
  delete m[normPath(file)];
  if (usage && leafId) m[normPath(file)] = { usage, leafId, model: `${model?.provider}/${model?.id}` };
  const keys = Object.keys(m);
  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete m[k];
  localStorage.setItem(CTX_KEY, JSON.stringify(m));
}

/**
 * “只看”一个会话：不起 pi 进程，内容是后端从会话文件里读的。
 * keep：进程刚被回收，界面上的消息、模型、用量都还对，原样留着
 */
function openLazy({ cwd, file, messages, state, stats, models, conversation }, { keep = false } = {}) {
  viewRevision++;
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
    const cached = file ? readJson(CTX_KEY, {})[normPath(file)] : null;
    const matches = cached?.leafId === conversation?.leafId && cached?.model === `${state?.model?.provider}/${state?.model?.id}`;
    S.stats = stats ? { ...stats, contextUsage: matches && !stats.contextEstimate ? cached.usage : stats.contextUsage } : null;
    S.conversation = conversation || null;
    S.branchBack = [];
    S.edit = null;
    S.models = models || [];
    updateThinkingLevels();
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
    // 未启动时选择的配置先应用到进程，再读取最终状态、发送消息。
    for (const cmd of [
      lz.pendingModel && { type: 'set_model', provider: lz.pendingModel.provider, modelId: lz.pendingModel.id },
      lz.pendingThinking && { type: 'set_thinking_level', level: lz.pendingThinking },
    ].filter(Boolean)) {
      const r = await call('rpc', { agentId: res.agent.id, cmd });
      if (!r.success) throw new Error(r.error || `${cmd.type} 失败`);
    }
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
  viewRevision++;
  S.agentId = null;
  S.agent = null;
  S.agentExited = null;
  S.detached = { file, cwd };
  S.lazy = null;
  S.state = null;
  S.stats = null;
  S.conversation = null;
  S.edit = null;
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
  await loadMessages();
  await Promise.all([loadState(), loadCommands(), loadStats()]);
  loadSessions();
}

// ---------------- 读取状态 ----------------
/** 把 pi 的 message 数组变成界面要的 S.messages + S.tools */
function setMessages(list) {
  const tools = {};
  const out = [];
  const keys = new Map(S.messages.filter((m) => m._entryId).map((m) => [m._entryId, m._k]));
  for (const m of list || []) {
    if (m.role === 'system') continue;
    if (m.role === 'toolResult') {
      tools[m.toolCallId] = { status: m.isError ? 'error' : 'done', result: m };
      continue;
    }
    out.push({ ...m, _k: keys.get(m._entryId) ?? ++keySeq });
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
  const agentId = S.agentId, revision = viewRevision;
  try {
    const d = await rpc({ type: 'get_web_snapshot' });
    if (S.agentId === agentId && viewRevision === revision) applyConversation(d, true);
  } catch {
    if (S.agentId !== agentId || viewRevision !== revision) return;
    const d = await rpc({ type: 'get_messages' });
    if (S.agentId === agentId && viewRevision === revision) setMessages(d.messages);
  }
}

// 下面几个只是刷新显示：没有进程就算了，不为这个去起 pi
async function loadState() {
  if (!S.agentId) return;
  const id = S.agentId, revision = viewRevision;
  try {
    const state = await rpc({ type: 'get_state' });
    if (S.agentId !== id || viewRevision !== revision) return;
    S.state = state;
    S.running = !!state.isStreaming;
    S.compacting = !!state.isCompacting;
    const t = await rpc({ type: 'get_available_thinking_levels' });
    if (S.agentId !== id || viewRevision !== revision) return;
    S.thinkingLevels = t.levels || [];
    syncTitle();
  } catch {}
}

async function loadStats() {
  if (!S.agentId) return;
  const id = S.agentId, revision = viewRevision;
  const stats = await rpc({ type: 'get_session_stats' }).catch(() => null);
  if (S.agentId !== id || viewRevision !== revision) return;
  S.stats = stats ? { latestCacheHitRate: S.stats?.latestCacheHitRate, ...stats, contextEstimate: S.stats?.contextEstimate } : S.stats;
  if (S.stats && S.agent?.sessionFile) {
    S.stats.branchStats = S.conversation?.branchStats;
    rememberCtx(S.agent.sessionFile, S.stats.contextUsage, S.conversation?.leafId, S.state?.model);
  }
}

function applyConversation(d, replaceMessages = false) {
  if (!d?.nodes) return;
  const { messages, messageIds, contextUsage, contextEstimate, ...conversation } = d;
  if (S.conversation?.leafId !== d.leafId) viewRevision++;
  S.conversation = conversation;
  if (replaceMessages) setMessages(messages);
  else {
    // Streaming records don't carry session entry ids. Match the ordered snapshot
    // once finalized, without replacing DOM keys or disturbing an in-flight answer.
    const queues = new Map();
    for (const m of messages || messageIds || []) {
      const k = `${m.role}:${m.timestamp}`;
      if (!queues.has(k)) queues.set(k, []);
      queues.get(k).push(m._entryId);
    }
    for (const m of S.messages) {
      const id = queues.get(`${m.role}:${m.timestamp}`)?.shift();
      if (id) m._entryId = id;
    }
  }
  S.stats = { ...S.stats, ...d.totals, branchStats: d.branchStats, contextUsage, contextEstimate };
}

async function loadConversation() {
  if (!S.agentId) return;
  const id = S.agentId, revision = viewRevision;
  try {
    const d = await rpc({ type: 'get_web_snapshot', metadataOnly: true });
    if (S.agentId === id && viewRevision === revision) applyConversation(d);
  } catch (e) {
    // Basic chat still works if an older pi cannot load the bridge.
    if (S.agentId === id && viewRevision === revision) S.conversation = null;
    console.warn('读取对话分支失败', e.message);
  }
}

export const conversationNodes = computed(() => new Map((S.conversation?.nodes || []).map((n) => [n.id, n])));
export const branchDisabled = computed(() => !S.connected || viewer.value || S.running || S.compacting || !!S.bashLive || !!S.retry || S.branchBusy || !!S.detached || !!S.agentExited);

export const openBranches = guard(async () => {
  view.panel = null;
  S.branchesOpen = true;
  S.activeTab = 'chat';
  if (S.agentId) await loadConversation(); // inspecting a lazy tree never starts pi
});

export const beginEdit = guard(async (m) => {
  if (branchDisabled.value || !m._entryId) return;
  const file = S.agent?.sessionFile;
  if (S.edit && S.edit.entryId !== m._entryId) {
    const r = await ask({ method: 'confirm', title: '修改另一条消息', message: '丢弃当前未发送的修改？' });
    if (!r.confirmed || normPath(file) !== normPath(S.agent?.sessionFile) || branchDisabled.value) return;
  }
  const parts = splitAttachments(textOf(m.content));
  S.edit = { entryId: m._entryId, text: parts.text, attachments: parts.attachments.map(makeAtt), images: imagesOf(m.content).map((im) => ({ ...im })), error: '' };
});
export function cancelEdit() { if (!S.branchBusy) S.edit = null; }

export async function uploadEditFiles(files) {
  const edit = S.edit;
  if (!edit || S.branchBusy) return;
  for (const f of files) {
    if (UI.uploadMaxMB && f.size > UI.uploadMaxMB * 1048576) { toast(`${f.name} 超过上传大小上限`, 'warning'); continue; }
    const item = makeAtt({ name: f.name || pastedName(f), status: 'uploading', origin: 'upload' });
    edit.attachments.push(item);
    try {
      const r = await upload(f, { name: item.name, dir: UI.uploadDir, cwd: S.cwd, session: S.state?.sessionId, maxMB: UI.uploadMaxMB }, (p) => (item.progress = p));
      Object.assign(item, { ...r, kind: attachKind(r.name || r.path), status: 'ready' });
    } catch (e) {
      edit.attachments = edit.attachments.filter((a) => a !== item);
      edit.error = e.message;
    }
  }
}

export const sendEdit = guard(async () => {
  requireIdle();
  const edit = S.edit;
  if (!edit || branchDisabled.value) return false;
  if (edit.attachments.some((a) => a.status !== 'ready')) { edit.error = '附件还在上传，请稍等'; return false; }
  const block = edit.attachments.length ? buildAttachmentBlock(edit.attachments) : '';
  const message = [edit.text.replace(/\s+$/, ''), block].filter(Boolean).join('\n\n');
  if (!message.trim() && !edit.images.length) { edit.error = '消息不能为空'; return false; }
  await ensureAgent();
  if (S.edit !== edit || branchDisabled.value) return false;
  const id = S.agentId;
  S.branchBusy = true;
  edit.error = '';
  S.branchJump = { fromId: edit.entryId, toId: edit.entryId, bottom: true };
  try {
    await rpc({ type: 'web_edit', targetId: edit.entryId, expectedLeafId: S.conversation?.leafId, message, images: edit.images });
    if (S.agentId === id) { S.edit = null; await loadConversation(); }
    return true;
  } catch (e) {
    edit.error = e.message;
    return false;
  } finally { S.branchBusy = false; }
});

export const switchBranch = guard(async (targetId, { fromId = null, toId = null, back = false, prepare = false } = {}) => {
  requireIdle();
  if (branchDisabled.value) return;
  const file = S.agent?.sessionFile;
  const edit = S.edit;
  if (edit || (prepare && (S.composer.text || S.composer.attachments.length || S.composer.images.length))) {
    const r = await ask({ method: 'confirm', title: '切换分支', message: '当前有未发送的内容，用所选问题替换并切换？' });
    if (!r.confirmed || normPath(file) !== normPath(S.agent?.sessionFile)) return;
  }
  await ensureAgent();
  if (normPath(file) !== normPath(S.agent?.sessionFile) || branchDisabled.value) return;
  const oldLeaf = S.conversation?.leafId;
  if (targetId === oldLeaf && !prepare) return true;
  const id = S.agentId;
  S.branchBusy = true;
  let focusComposer = false;
  try {
    let prompt = null;
    if (prepare) {
      // Read the original before moving the cursor. Already-running bridges may
      // not return editorText, and tree previews are truncated/omit attachments.
      let message = S.messages.find(m => m._entryId === targetId && m.role === 'user');
      if (!message) {
        const d = await rpc({ type: 'get_entries' });
        if (S.agentId !== id || normPath(file) !== normPath(S.agent?.sessionFile)) return;
        message = d.entries?.find(e => e.id === targetId && e.type === 'message' && e.message?.role === 'user')?.message;
      }
      if (!message) throw new Error('找不到所选问题的原文，未切换分支');
      prompt = { editorText: textOf(message.content), editorImages: imagesOf(message.content).map(im => ({ ...im })) };
    }
    S.branchJump = { fromId, toId, bottom: prepare };
    const r = await rpc({ type: 'web_navigate', targetId, expectedLeafId: oldLeaf });
    if (S.agentId !== id || normPath(file) !== normPath(S.agent?.sessionFile)) return;
    if (!back && oldLeaf) S.branchBack = [...S.branchBack, oldLeaf].slice(-30);
    if (S.edit === edit) S.edit = null;
    const restored = prompt || r;
    if (restored?.editorText !== undefined) {
      if (prepare || (!S.composer.text && !S.composer.attachments.length && !S.composer.images.length)) {
        await nextTick(); // let lazy-session attachment drafts settle before restoring the prompt
        if (S.agentId !== id || normPath(file) !== normPath(S.agent?.sessionFile)) return;
        clearAttachments();
        S.composer.text = restoreMessage(restored.editorText);
        S.composer.images = (restored.editorImages || []).map(im => ({ ...im }));
        focusComposer = true;
      } else toast('已回到提问之前；输入框原有草稿保留，未覆盖', 'info');
    }
    await Promise.all([loadState(), loadStats()]);
    return true;
  } catch (e) {
    S.branchJump = null;
    throw e;
  } finally {
    S.branchBusy = false;
    if (focusComposer) {
      await nextTick(); // focus only after the composer is enabled again
      if (S.agentId === id && normPath(file) === normPath(S.agent?.sessionFile)) S.composerFocus++;
    }
  }
});
export const previousBranch = guard(async () => {
  const id = S.branchBack.at(-1);
  if (!id) return;
  const question = S.conversation?.nodes.filter((n) => n.targetId === id).at(-1);
  const ok = await switchBranch(id, { back: true, toId: question?.id });
  if (ok && S.branchBack.at(-1) === id) S.branchBack.pop();
});
export function switchVersion(m, delta) {
  const node = conversationNodes.value.get(m._entryId);
  if (!node) return;
  const target = conversationNodes.value.get(node.versions[node.versions.indexOf(node.id) + delta]);
  if (target) return switchBranch(target.targetId, { fromId: node.id, toId: target.id });
}
export const restoreBranchSelection = guard(async () => {
  requireIdle();
  if (branchDisabled.value) return;
  await ensureAgent();
  S.branchBusy = true;
  try {
    const r = await rpc({ type: 'web_restore_selection', expectedLeafId: S.conversation?.leafId });
    await Promise.all([loadState(), loadStats()]);
    toast(r.thinkingLevel !== r.requestedThinkingLevel ? `已恢复模型，思考强度按模型能力调整为 ${r.thinkingLevel}` : '已恢复此分支之前的模型与思考强度');
  } finally { S.branchBusy = false; }
});

export const labelBranch = guard(async (node) => {
  requireIdle();
  const file = S.agent?.sessionFile;
  const r = await ask({ method: 'input', title: '分支名称（留空清除）', prefill: node.label });
  if (r.cancelled || normPath(file) !== normPath(S.agent?.sessionFile) || branchDisabled.value) return;
  S.branchBusy = true;
  try { await rpc({ type: 'web_label', targetId: node.id, label: r.value || '' }); }
  finally { S.branchBusy = false; }
});

export const forkMessage = guard(async (m) => {
  requireIdle();
  if (!m?._entryId || branchDisabled.value) return;
  const file = S.agent?.sessionFile;
  if (S.composer.text || S.composer.attachments.length || S.composer.images.length) {
    const r = await ask({ method: 'confirm', title: 'Fork 为新会话', message: '用这条消息替换输入框里未发送的草稿？' });
    if (!r.confirmed || normPath(file) !== normPath(S.agent?.sessionFile)) return;
  }
  await ensureAgent();
  if (normPath(file) !== normPath(S.agent?.sessionFile) || branchDisabled.value) return;
  const id = S.agentId;
  S.branchBusy = true;
  try {
    const r = await rpc({ type: 'fork', entryId: m._entryId });
    if (S.agentId !== id) return;
    if (r?.cancelled) return toast('扩展取消了分叉', 'warning');
    await reload();
    await nextTick(); // switch the per-session attachment draft before restoring it
    clearAttachments();
    S.composer.text = restoreMessage(textOf(m.content));
    S.composer.images = imagesOf(m.content).map((im) => ({ ...im }));
    S.edit = null;
    S.branchBack = [];
    S.composerFocus++;
    toast('已 Fork 为新会话，修改后发送；原会话保留');
  } finally { S.branchBusy = false; }
});

async function loadCommands() {
  if (!S.agentId) return;
  const id = S.agentId;
  const d = await rpc({ type: 'get_commands' }).catch(() => ({ commands: [] }));
  if (S.agentId !== id) return;
  S.commands = (d.commands || []).filter((c) => !c.name.startsWith('seed-web-tree'));
}

let sessionsRequest = 0;
export async function loadSessions() {
  if (!S.cwd) return;
  const request = ++sessionsRequest;
  const mode = S.sessionMode;
  const cwd = S.cwd;
  // 只看当前目录时带 cwd；看全部 / 看收藏时都要拿全量，收藏是在前端按目录筛的
  const query = mode === 'dir' ? { cwd } : { all: 1 };
  const list = await http.get('/api/sessions', query).catch(() => []);
  if (request === sessionsRequest && mode === S.sessionMode && cwd === S.cwd) S.sessions = list;
}

// ---------------- 收藏的文件夹 ----------------
// 整份发给后端存；后端存好了会广播给所有标签页（包括自己），失败就提示一下并拉回后端那份
export async function setFavorites(list) {
  const { list: saved } = await http.post('/api/favorites', { list });
  S.favorites = saved;
  return saved;
}
function saveFavorites() {
  setFavorites(S.favorites).catch((e) => {
    toast(`收藏没存上：${e.message}`, 'error');
    syncFavorites();
  });
}
/** 连上后端时拉一次 */
async function syncFavorites() {
  try {
    S.favorites = (await http.get('/api/favorites')).list;
  } catch {}
}

/** 设置里导出用：后端存的收藏、归档、星标 */
export const readBackup = () => http.get('/api/backup');
/** 设置里导入用：整份替换后端的收藏、归档、星标（缺哪个字段就不动哪个） */
export const restoreBackup = (data) => http.post('/api/backup', data);

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
 * 顺序就是数组本身的顺序，改完整份发给后端存
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

function updateThinkingLevels() {
  const m = S.models.find((m) => m.provider === S.state?.model?.provider && m.id === S.state?.model?.id);
  S.thinkingLevels = m?.thinkingLevels || (S.state?.thinkingLevel ? [S.state.thinkingLevel] : []);
}

export async function loadModels() {
  if (S.agentId) {
    // 已启动的会话以实际进程为准，包含扩展动态注册的模型。
    const d = await rpc({ type: 'get_available_models' });
    S.models = d.models || [];
  } else if (!S.models.length) {
    const lz = S.lazy;
    const d = await http.get(`/api/models?cwd=${encodeURIComponent(S.cwd)}`);
    if (S.lazy !== lz) return S.models;
    S.models = d.models || [];
    updateThinkingLevels();
  }
  return S.models;
}

/** 直接切换模型（输入框下面的模型菜单用） */
export const setModel = guard(async (m) => {
  if (ensuring) await ensuring;
  if (S.lazy) {
    S.lazy.pendingModel = m;
    S.state = { ...S.state, model: m };
    updateThinkingLevels();
    if (!S.thinkingLevels.includes(S.state.thinkingLevel)) {
      const order = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      const index = order.indexOf(S.state.thinkingLevel);
      S.state.thinkingLevel = S.thinkingLevels.find((l) => order.indexOf(l) >= index) || S.thinkingLevels.at(-1) || 'off';
    }
    S.lazy.pendingThinking = S.state.thinkingLevel;
    if (S.stats) S.stats.contextUsage = undefined;
  } else {
    await rpc({ type: 'set_model', provider: m.provider, modelId: m.id });
    await loadState();
    await loadStats();
  }
  const recent = JSON.parse(localStorage.getItem('seed-pi-web-recent-models') || '[]').filter((k) => k !== `${m.provider}/${m.id}`);
  recent.unshift(`${m.provider}/${m.id}`);
  localStorage.setItem('seed-pi-web-recent-models', JSON.stringify(recent.slice(0, 6)));
});

export const setThinking = guard(async (level) => {
  if (ensuring) await ensuring;
  if (S.lazy) {
    if (!S.thinkingLevels.includes(level)) throw new Error(`当前模型不支持思考强度：${level}`);
    S.lazy.pendingThinking = level;
  } else {
    await rpc({ type: 'set_thinking_level', level });
  }
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
      loadConversation().then(() => Promise.all([loadStats(), loadState()]));
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
  if (S.branchBusy) return false;
  const atts = S.composer.attachments;
  const ready = atts.filter((a) => a.status === 'ready' && a.path);
  if (!text.trim() && !ready.length && !S.composer.images.length) {
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
    const cmd = { type: 'prompt', message, ...(S.composer.images.length ? { images: S.composer.images } : {}) };
    if (S.running) cmd.streamingBehavior = followUp ? 'followUp' : 'steer';
    await rpc(cmd);
    if (ready.length && !UI.keepAttachments) clearAttachments();
    S.composer.images = [];
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
  for (const f of files) startUpload(pendingAtt(f, pasted), f);
}

// 先把附件卡片摆出来（图片直接用本地 blob 做缩略图），再慢慢决定是用原路径还是上传
function pendingAtt(f, pasted) {
  const name = !f.name || (pasted && /^image\.\w+$/i.test(f.name)) ? pastedName(f) : f.name;
  const item = makeAtt({ name, size: f.size, origin: 'upload', status: 'uploading', preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : '' });
  S.composer.attachments.push(item);
  S.activeTab = 'chat';
  return S.composer.attachments.at(-1);
}

// 正在上传的附件 → 它的 AbortController。剪贴板查到原文件、或者卡片被删掉时用来停掉上传
const uploads = new WeakMap();
const cancelUpload = (item) => {
  uploads.get(item)?.abort();
  uploads.delete(item);
};

function startUpload(item, f) {
  const max = (Number(UI.uploadMaxMB) || 0) * 1048576;
  if (max && f.size > max) {
    toast(`${item.name} 太大了（上限 ${UI.uploadMaxMB}MB，可以在设置里改）`, 'warning');
    removeAttachment(item);
    return;
  }
  const name = item.name;
  const ctrl = new AbortController();
  uploads.set(item, ctrl);
  upload(f, { name, dir: UI.uploadDir, cwd: S.cwd, session: S.state?.sessionId, maxMB: UI.uploadMaxMB }, (p) => (item.progress = p), ctrl.signal)
    .then((r) => {
      // 上传期间剪贴板已经查到原文件、卡片换成了原路径：上传结果不要再覆盖回去
      if (item.origin === 'upload') Object.assign(item, { path: r.path, name: r.name, size: r.size, status: 'ready' });
    })
    .catch((e) => {
      if (ctrl.signal.aborted) return;
      toast(`${name} 上传失败：${e.message}`, 'error');
      removeAttachment(item);
    })
    .finally(() => uploads.get(item) === ctrl && uploads.delete(item));
}

// 浏览器给剪贴板位图（截图、网页里复制的图片）起的都是 image.png 这种名字。
// 资源管理器里真叫 image.png 的文件也长这样，所以这类先直接上传，剪贴板查到原文件再取消上传换成原路径
const looksLikeBitmap = (f) => f.type.startsWith('image/') && (!f.name || /^image\.\w+$/i.test(f.name));

/**
 * Ctrl+V 粘贴了文件。卡片立刻显示，不等后端。
 * 本机打开的网页：再问后端剪贴板里的路径列表（资源管理器复制文件时放进去的），
 * 按文件名 + 大小跟浏览器给的文件对上了就把卡片换成原路径；对不上的照常上传。
 * 看着像截图的不等这一步，先开始上传。files 为空：浏览器没给文件也没给文字，只看后端剪贴板
 */
export async function pasteFiles(files) {
  if (!S.info.local) {
    if (!files.length) return false;
    uploadFiles(files, { pasted: true });
    return true;
  }
  const pending = files.map((f) => ({ f, item: pendingAtt(f, true) }));
  for (const p of pending) if (looksLikeBitmap(p.f)) startUpload(p.item, p.f);
  const list = await http.get('/api/clipboard/files').then((r) => r.files || [], () => []);
  const alive = (item) => S.composer.attachments.includes(item); // 等的时候用户可能已经点掉了
  const used = new Set();
  const rest = [];
  for (const p of pending) {
    const i = list.findIndex((c, j) => !used.has(j) && c.name === p.f.name && (c.dir || c.size === p.f.size));
    if (i < 0) {
      rest.push(p);
      continue;
    }
    used.add(i);
    const c = list[i];
    cancelUpload(p.item);
    if (!alive(p.item)) continue;
    if (S.composer.attachments.some((a) => a !== p.item && a.path && normPath(a.path) === normPath(c.path))) removeAttachment(p.item);
    else Object.assign(p.item, { path: c.path, name: c.name, size: c.dir ? null : c.size, kind: attachKind(c.name, c.dir), origin: 'clipboard', status: 'ready', progress: 0 });
  }
  for (const p of rest) if (alive(p.item) && !looksLikeBitmap(p.f)) startUpload(p.item, p.f);
  // 浏览器给的全对上了：剪贴板里剩下的文件也加上（有的浏览器只给第一个，或者不给文件夹）
  if (list.length && !rest.length) attachPaths(list.filter((_, j) => !used.has(j)).map((c) => ({ path: c.path, name: c.name, size: c.dir ? null : c.size, dir: c.dir })), 'clipboard');
  return files.length > 0 || list.length > 0;
}

export function removeAttachment(a) {
  cancelUpload(a);
  const i = S.composer.attachments.indexOf(a);
  if (i >= 0) S.composer.attachments.splice(i, 1);
  if (a.preview) URL.revokeObjectURL(a.preview);
}
export function clearAttachments() {
  for (const a of S.composer.attachments) {
    cancelUpload(a);
    if (a.preview) URL.revokeObjectURL(a.preview);
  }
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
const imageLive = new Map(); // legacy inline-image drafts stay with their session (not localStorage)
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
  imageLive.set(attCur, S.composer.images);
  attCur = k;
  S.composer.images = imageLive.get(k) || [];
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
  { name: 'prompt', args: '[模板名] [参数…] | --help', desc: '选择提示词模板 / 查看变量用法', run: (a) => pickPrompt(a) },
  { name: 'name', args: '[名称]', desc: '设置会话名称', run: (a) => renameSession(a) },
  { name: 'compact', args: '[说明]', desc: '压缩上下文', run: (a) => compact(a) },
  { name: 'fork', desc: '从之前的某条消息分叉出新会话', run: () => pickFork() },
  { name: 'tree', desc: '打开对话分支窗口', run: () => openBranches() },
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
export const TUI_ONLY = ['settings', 'login', 'logout', 'scoped-models', 'trust', 'share', 'bug', 'import', 'changelog'];

export function allCommands() {
  const list = BUILTINS.filter((b) => b.name === 'tree' || !S.commands.some((c) => c.name === b.name))
    .map((b) => ({ name: b.name, args: b.args, desc: b.desc, source: 'pi' }));
  for (const c of S.commands) if (c.name !== 'tree') list.push({ name: c.name, args: c.argumentHint, desc: c.description || '', source: c.source });
  for (const n of TUI_ONLY) if (!S.commands.some((c) => c.name === n)) list.push({ name: n, desc: '在终端版 pi 里打开', source: 'tui' });
  return list;
}

async function runSlash(text) {
  const m = text.match(/^\/(\S+)\s*([\s\S]*)$/);
  if (!m) return false;
  const [, name, arg] = m;
  if (name !== 'tree' && S.commands.some((c) => c.name === name)) return false; // /tree 始终打开网页分支窗口，其余扩展命令交给 pi
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
  if (S.running || S.compacting || S.bashLive || S.retry) throw new Error('pi 正在运行，先停止或等它结束');
  if (S.branchBusy) throw new Error('正在处理分支，请稍等');
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
  S.composer.images = [];
  S.edit = null;
  S.activeTab = 'chat';
  S.composerFocus++;
}
export const newSessionIn = guard(newSessionRaw);

/** 临时会话：让后端在设置里的根目录下建个新文件夹，再在里面开新会话 */
export const newTempSession = guard(async () => {
  const { path } = await http.post('/api/fs/temp-dir', { root: UI.tempRoot, name: UI.tempName });
  await newSessionRaw(path);
});

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

function showPromptHelp(message = '') {
  ask({
    method: 'info',
    title: '提示词模板变量',
    message: message || '变量写在模板 .md 正文里；发送 /模板名 参数 时由 pi 替换，不是环境变量，也不会执行 shell。',
    rows: [
      ['/prompt', '选择模板，填入输入框；补参数后再发送'],
      ['/prompt review "API 兼容"', '填入 /review "API 兼容"，不会立即发送'],
      ['$1、$2、…', '第 1、2、… 个参数；缺省为空字符串'],
      ['$@ / $ARGUMENTS', '全部参数，用空格连接'],
      ['${1:-默认值}', '第 1 个参数未传或为空时使用默认值'],
      ['${@:-默认值}', '全部参数为空时使用默认值'],
      ['${@:N}', '从第 N 个参数开始，N 从 1 计数'],
      ['${@:N:L}', '从第 N 个参数开始取 L 个'],
      ['带空格的参数', '用双引号或单引号包起来，例如 /review "API 兼容"'],
      ['模板位置', '~/.pi/agent/prompts/*.md 或项目 .pi/prompts/*.md；文件名即命令名'],
      ['新增 / 修改模板', '输入 /reload 重新加载；项目模板需先在 pi 中授予项目信任'],
    ],
  });
}

async function pickPrompt(arg = '') {
  if (arg === '--help') return showPromptHelp();
  await ensureAgent(); // 模板发现交给 pi，不自行扫描文件或绕过项目信任
  const id = S.agentId;
  if (!id) return;
  const revision = viewRevision;
  const d = await rpc({ type: 'get_commands' });
  if (S.agentId !== id || viewRevision !== revision) return;
  S.commands = (d.commands || []).filter((c) => !c.name.startsWith('seed-web-tree'));
  // 同名扩展优先于模板，与 pi 实际执行顺序一致。
  const prompts = S.commands.filter((c) => c.source === 'prompt' && !S.commands.some((x) => x.name === c.name && x.source === 'extension'));
  const fill = (c, args = '') => {
    if (S.agentId !== id || viewRevision !== revision) return toast('会话已切换，请重新输入 /prompt');
    S.composer.text = `/${c.name} ${args}`;
    S.composerFocus++;
  };
  if (arg) {
    const [, name, args = ''] = arg.match(/^\/?(\S+)(?:\s+([\s\S]*))?$/);
    const c = prompts.find((p) => p.name === name);
    if (!c) throw new Error(`找不到提示词模板 ${name}；输入 /prompt 查看列表，新增模板后先 /reload`);
    return fill(c, args); // 保留引号及参数内容，让 pi 负责解析和替换
  }
  if (!prompts.length) return showPromptHelp('当前没有已加载且可调用的提示词模板。创建模板后输入 /reload，再用 /prompt 选择。');
  openPicker({
    title: '选择提示词模板',
    hint: '选中后填入输入框，补参数再发送。变量用法：/prompt --help',
    items: prompts.map((c) => ({ label: `/${c.name}${c.argumentHint ? ' ' + c.argumentHint : ''}`, detail: c.description || '', value: c })),
    onPick: (c) => fill(c),
  });
}

export const pickThinking = guard(async (arg) => {
  const set = (level) => setThinking(level);
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
    onPick: (m) => forkMessage(S.messages.find((x) => x._entryId === m.entryId) || { _entryId: m.entryId, content: m.text }),
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
  const ctx = contextUsage.value;
  const lines = [
    ['名称', st.sessionName || '(未命名)'],
    ['目录', S.cwd],
    ['文件', s.sessionFile || st.sessionFile || '(未保存)'],
    ['ID', s.sessionId || st.sessionId],
    ['模型', st.model ? `${st.model.provider}/${st.model.id}` : '-'],
    ['消息 · 整个会话', `用户 ${s.userMessages ?? 0} · 助手 ${s.assistantMessages ?? 0} · 工具调用 ${s.toolCalls ?? 0}`],
    ['Tokens · 整个会话', s.tokens ? `输入 ${s.tokens.input} · 输出 ${s.tokens.output} · 缓存读 ${s.tokens.cacheRead} · 缓存写 ${s.tokens.cacheWrite}` : '-'],
    ['费用 · 整个会话（所有分支）', s.cost != null ? `$${s.cost.toFixed(4)}` : '-'],
    ['当前路径 Tokens', s.branchStats?.tokens ? `输入 ${s.branchStats.tokens.input} · 输出 ${s.branchStats.tokens.output} · 缓存读 ${s.branchStats.tokens.cacheRead} · 缓存写 ${s.branchStats.tokens.cacheWrite}` : '-'],
    ['费用 · 当前路径', s.branchStats ? `$${s.branchStats.cost.toFixed(4)}` : '-'],
    ['上下文', ctx ? `${ctx.tokens ?? '?'} / ${ctx.contextWindow} (${ctx.percent != null ? Math.round(ctx.percent) : '?'}%)${ctx.estimated ? '，根据当前路径估算' : ''}` : '-'],
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
  // pi 可返回相对于它工作目录的路径，不能交给 Web 服务按自己的 cwd 解析。
  const cwd = S.cwd;
  const sep = S.info.sep;
  // 在用户操作的同步阶段预开标签页，避免 RPC 返回后被当作弹窗拦截。
  let tab = null;
  try {
    tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
  } catch { /* 被拦截时，仍可通过成功通知里的链接打开 */ }
  try {
    const d = await rpc({ type: 'export_html', ...(arg ? { outputPath: arg } : {}) });
    if (!d?.path || typeof d.path !== 'string') throw new Error('导出未返回文件路径');
    const file = isAbsPath(d.path) ? d.path : joinPath(cwd, d.path, sep);
    const url = rawUrl(file);
    if (tab && !tab.closed) tab.location.replace(url);
    toast(`已导出：${file}`, 'info', 15000, { label: '打开 HTML', href: url });
  } catch (error) {
    if (tab && !tab.closed) tab.close();
    throw error;
  }
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

const archiving = new Set();
export const setSessionArchived = guard(async (s, archived) => {
  const key = normPath(s.file);
  if (archiving.has(key)) return;
  archiving.add(key);
  try {
    await http.post('/api/sessions/archive', { file: s.file, archived });
    for (const row of S.sessions) if (normPath(row.file) === key) row.archived = archived;
    toast(archived ? '已归档' : '已取消归档', 'info', 6000, {
      label: '撤销', run: () => setSessionArchived(s, !archived),
    });
    loadSessions();
  } finally {
    archiving.delete(key);
  }
});

// 星标只是个标记，点一下就切换，不弹撤销提示（再点一次就是撤销）。
const starring = new Set();
export const setSessionStarred = guard(async (s, starred) => {
  const key = normPath(s.file);
  if (starring.has(key)) return;
  starring.add(key);
  try {
    await http.post('/api/sessions/star', { file: s.file, starred });
    for (const row of S.sessions) if (normPath(row.file) === key) row.starred = starred;
  } finally {
    starring.delete(key);
  }
});

function sessionDeleted(file) {
  const key = normPath(file);
  S.sessions = S.sessions.filter((s) => normPath(s.file) !== key);
  if (normPath(localStorage.getItem('seed-pi-web-session')) === key) localStorage.setItem('seed-pi-web-session', '');
  const last = readJson(LAST_KEY, {});
  for (const cwd of Object.keys(last)) if (normPath(last[cwd]) === key) delete last[cwd];
  localStorage.setItem(LAST_KEY, JSON.stringify(last));
  if ([S.agent?.sessionFile, S.lazy?.file, S.detached?.file].some((f) => f && normPath(f) === key)) {
    openLazy({ cwd: S.cwd, file: null, messages: [] });
  } else loadSessionsSoon(); // 批量删除会连着收到很多条通知，合并成一次刷新
}

const deletingSessions = new Set();
export const deleteSession = guard(async (s, event) => {
  const key = normPath(s.file);
  if (deletingSessions.has(key)) return;
  deletingSessions.add(key);
  try {
    if (!event?.ctrlKey) {
      const r = await ask({ method: 'confirm', title: '删除会话', message: `确定删除「${s.title}」文件会被永久删除` });
      if (!r.confirmed) return;
    }
    await http.del('/api/sessions', { file: s.file });
    sessionDeleted(s.file);
  } finally {
    deletingSessions.delete(key);
  }
});

// ---------------- 目录批量操作 ----------------
// 作用于这个目录下的全部已保存会话（不管搜索和归档筛选），正在运行 / 等你操作 / 别的窗口在用的跳过。
const busySession = (s) => {
  const st = sessionStatus(s.file);
  return !!(st && (st.running || st.waiting || st.elsewhere));
};
const dirKey = (p) => normPath(p || '').replace(/\/+$/, '').toLowerCase();
export const dirSessions = (cwd) => S.sessions.filter((s) => dirKey(s.cwd) === dirKey(cwd));
/** 每个目录的会话数 / 已归档数：整个列表只扫一遍，侧栏每个目录行直接查表（会话上千时逐行扫会卡） */
const dirArchiveIndex = computed(() => {
  const m = new Map();
  for (const s of S.sessions) {
    const k = dirKey(s.cwd);
    const v = m.get(k) || { total: 0, archived: 0 };
    v.total++;
    if (s.archived) v.archived++;
    m.set(k, v);
  }
  return m;
});
export function dirAllArchived(cwd) {
  const v = dirArchiveIndex.value.get(dirKey(cwd));
  return !!v && v.total > 0 && v.archived === v.total;
}

const skippedText = (n) => (n ? `，跳过 ${n} 个正在使用的会话` : '');

async function setArchivedMany(files, archived) {
  const done = [];
  for (const file of files) {
    try {
      await http.post('/api/sessions/archive', { file, archived });
      done.push(file);
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  const keys = new Set(done.map(normPath));
  for (const row of S.sessions) if (keys.has(normPath(row.file))) row.archived = archived;
  loadSessions();
  return done;
}

/** 目录上的归档按钮：目录里全都归档了就全部取消归档，否则把没归档的都归档 */
export const setDirArchived = guard(async (cwd, archived) => {
  const all = dirSessions(cwd);
  const targets = all.filter((s) => s.archived !== archived);
  const free = targets.filter((s) => !busySession(s));
  const skipped = targets.length - free.length;
  if (!free.length) {
    toast(skipped ? '这个目录里的会话都在使用中，没有可操作的' : '没有需要处理的会话', 'info');
    return;
  }
  const done = await setArchivedMany(free.map((s) => s.file), archived);
  if (!done.length) return;
  toast(`${archived ? '已归档' : '已取消归档'} ${done.length} 个会话${skippedText(skipped)}`, 'info', 6000, {
    label: '撤销', run: guard(() => setArchivedMany(done, !archived)),
  });
});

/** 目录上的删除按钮：删掉目录下全部会话，Ctrl+点击跳过确认 */
export const deleteDirSessions = guard(async (cwd, event) => {
  const all = dirSessions(cwd);
  const free = all.filter((s) => !busySession(s));
  const skipped = all.length - free.length;
  if (!free.length) {
    toast(skipped ? '这个目录里的会话都在使用中，没有可删除的' : '这个目录没有会话', 'info');
    return;
  }
  if (!event?.ctrlKey) {
    const r = await ask({
      method: 'confirm',
      title: '删除目录下的会话',
      message: `确定删除 ${cwd} 下的 ${free.length} 个会话？文件会被永久删除${skipped ? `\n（${skipped} 个正在使用的会话会跳过）` : ''}`,
    });
    if (!r.confirmed) return;
  }
  let ok = 0;
  for (const s of free) {
    const key = normPath(s.file);
    if (deletingSessions.has(key)) continue;
    deletingSessions.add(key);
    try {
      await http.del('/api/sessions', { file: s.file });
      sessionDeleted(s.file);
      ok++;
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      deletingSessions.delete(key);
    }
  }
  if (ok) toast(`已删除 ${ok} 个会话${skippedText(skipped)}`, 'info');
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
