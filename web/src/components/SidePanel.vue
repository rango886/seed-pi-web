<script setup>
import { ref, computed, watch } from 'vue';
import { S, loadSessions, openSession, newSession, deleteSession, openDir, openTerminal, renameSession } from '../store.js';
import { view, toggleSide, closeDrawer, openMenu } from '../settings.js';
import TreeNode from './TreeNode.vue';
import Icon from './Icon.vue';

const q = ref('');
const searchEl = ref(null);

let lastLoad = 0;
function setTab(t) {
  S.leftTab = t;
  localStorage.setItem('pi-web-left', t);
  // 切回来不用每次都重新拉列表：运行结束、切会话时 store 会自己刷新
  if (t === 'history' && Date.now() - lastLoad > 10000) {
    lastLoad = Date.now();
    loadSessions();
  }
}
watch(
  () => S.showAllSessions,
  () => loadSessions(),
);
const base = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const others = computed(() => S.agents.filter((a) => a.running && a.id !== S.agentId).length);

// 排序方式：时间 / 名称，存 localStorage
const sortBy = ref(localStorage.getItem('pi-web-sort') || 'time');
const sortLabel = computed(() => (sortBy.value === 'time' ? '时间' : '名称'));
function toggleSort() {
  sortBy.value = sortBy.value === 'time' ? 'name' : 'time';
  localStorage.setItem('pi-web-sort', sortBy.value);
}
const byTime = (a, b) => new Date(b.modified) - new Date(a.modified);
const byName = (a, b) => (a.title || '').localeCompare(b.title || '', 'zh');

// 显示全部目录时，每个目录像文件夹一样可以折叠（状态记下来）
const collapsed = ref(new Set(JSON.parse(localStorage.getItem('pi-web-collapsed-dirs') || '[]')));
function toggleDir(key) {
  const s = new Set(collapsed.value);
  if (s.has(key)) s.delete(key);
  else s.add(key);
  collapsed.value = s;
  localStorage.setItem('pi-web-collapsed-dirs', JSON.stringify([...s]));
}

// 会话分组：显示全部目录时按目录分组，只看当前目录时按时间分组；组内再按当前排序方式排
const groups = computed(() => {
  const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
  const list = S.sessions.filter((s) => words.every((w) => `${s.title} ${s.cwd || ''}`.toLowerCase().includes(w)));
  const cmp = sortBy.value === 'name' ? byName : byTime;

  if (S.showAllSessions) {
    const by = new Map();
    for (const s of list) {
      const k = s.cwd || '';
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(s);
    }
    // 不同路径重名（比如两个 switch）时，用上一级目录区分
    const seen = new Set();
    const dup = new Set();
    for (const cwd of by.keys()) {
      const n = (base(cwd) || '').toLowerCase();
      if (seen.has(n)) dup.add(n);
      seen.add(n);
    }
    const label = (cwd) => {
      const parts = (cwd || '').split(/[\\/]/).filter(Boolean);
      const n = parts.pop() || '(未知目录)';
      return dup.has(n.toLowerCase()) && parts.length ? `${parts.pop()}/${n}` : n;
    };
    return [...by.entries()]
      .map(([cwd, items]) => ({
        name: label(cwd),
        path: cwd,
        // 目录之间按“最近一次会话”排，和当前用什么方式排序无关
        last: items.reduce((m, s) => Math.max(m, new Date(s.modified).getTime()), 0),
        items: items.sort(cmp),
      }))
      .sort((a, b) => b.last - a.last);
  }

  if (sortBy.value === 'name') return [{ name: '', items: list.sort(byName) }];

  // 当前目录：按时间分桶，今天 / 昨天 / 7 天内 / 30 天内 / 更早
  const d0 = new Date();
  d0.setHours(0, 0, 0, 0);
  const t0 = d0.getTime();
  const DAY = 86400000;
  const buckets = [
    ['今天', t0],
    ['昨天', t0 - DAY],
    ['7 天内', t0 - 7 * DAY],
    ['30 天内', t0 - 30 * DAY],
    ['更早', -Infinity],
  ].map(([name, from]) => ({ name, from, items: [] }));
  for (const s of list) {
    const t = new Date(s.modified).getTime();
    buckets.find((b) => t >= b.from).items.push(s);
  }
  return buckets.filter((b) => b.items.length);
});
const timeOf = (iso) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : `${d.getMonth() + 1}/${d.getDate()}`;
};

function open(s) {
  openSession(s.file);
  closeDrawer();
}
function onNew() {
  newSession();
  closeDrawer();
}
function sessionMenu(e, s) {
  openMenu(e.clientX, e.clientY, [
    { label: '打开', icon: 'chat', run: () => open(s) },
    s.file === S.agent?.sessionFile && { label: '重命名…', icon: 'edit', run: () => renameSession() },
    { label: '复制文件路径', icon: 'copy', run: () => navigator.clipboard.writeText(s.file) },
    '-',
    { label: '删除', icon: 'trash', danger: true, run: () => deleteSession(s) },
  ].filter(Boolean));
}
function focusSearch() {
  setTab('history');
  setTimeout(() => searchEl.value?.focus(), 0);
}
</script>

<template>
  <aside class="side">
    <div class="brand">
      <span class="logo">π</span>
      <span class="name">pi</span>
      <div class="grow" />
      <button class="ib" title="搜索会话" @click="focusSearch"><Icon name="search" /></button>
      <button class="ib" :title="view.mobile ? '关闭' : '收起侧栏 (Ctrl+B)'" @click="toggleSide(false)"><Icon :name="view.mobile ? 'close' : 'sidebar'" /></button>
    </div>

    <div class="nav">
      <div class="nv" :class="{ dis: S.running }" @click="!S.running && onNew()"><Icon name="newchat" /><span>新会话</span></div>
      <div v-if="S.info.terminal" class="nv" @click="S.showTerm ? (S.showTerm = false) : openTerminal()">
        <Icon name="terminal" /><span class="grow">终端</span><span v-if="S.terms.length" class="cnt">{{ S.terms.length }}</span>
      </div>
    </div>

    <div class="seg">
      <div class="st" :class="{ on: S.leftTab === 'history' }" @click="setTab('history')">会话</div>
      <div class="st" :class="{ on: S.leftTab === 'files' }" @click="setTab('files')">文件</div>
      <div class="st" :class="{ on: S.leftTab === 'agents' }" @click="setTab('agents')">
        进程<span v-if="S.agents.length > 1" class="cnt">{{ S.agents.length }}</span>
      </div>
    </div>

    <!-- 三个面板都一直挂着，切换只是显示/隐藏，不会重新加载 -->
    <div v-show="S.leftTab === 'history'" class="pane">
      <div class="search">
        <Icon name="search" :size="15" />
        <input ref="searchEl" v-model="q" placeholder="搜索会话" @keydown.esc="q = ''" />
        <button class="ib sm" :class="{ on: S.showAllSessions }" :title="S.showAllSessions ? '正在显示所有目录的会话（按目录分组）' : '只显示当前目录，点击显示全部目录'" @click="S.showAllSessions = !S.showAllSessions">
          <Icon name="globe" :size="15" />
        </button>
        <button class="sbtn" :title="`当前按${sortLabel}排序，点击切换`" @click="toggleSort">{{ sortLabel }}</button>
      </div>
      <div class="list">
        <div v-if="!S.sessions.length" class="empty">{{ S.showAllSessions ? '还没有历史会话' : '这个目录还没有历史会话' }}</div>
        <div v-else-if="!groups.length" class="empty">没有匹配的会话</div>
        <template v-for="g in groups" :key="g.path || g.name">
          <!-- 目录：像文件夹一样，点一下折叠/展开 -->
          <div v-if="g.path" class="dirhead" :class="{ closed: collapsed.has(g.path) }" :title="g.path" @click="toggleDir(g.path)">
            <span class="arrow"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 6l6 6-6 6" /></svg></span>
            <Icon name="folder" :size="15" />
            <span class="ellipsis grow">{{ g.name }}</span>
            <span class="gcount">{{ g.items.length }}</span>
          </div>
          <div v-else-if="g.name" class="gname">{{ g.name }}</div>
          <template v-if="!g.path || !collapsed.has(g.path)">
            <div
              v-for="s in g.items"
              :key="s.file"
              class="sess"
              :class="{ active: s.file === S.agent?.sessionFile, child: !!g.path }"
              :title="s.title"
              @click="open(s)"
              @contextmenu.prevent.stop="sessionMenu($event, s)"
            >
              <div class="grow">
                <div class="ellipsis stitle">{{ s.title }}</div>
                <div class="meta ellipsis">{{ s.messages }} 条</div>
              </div>
              <span class="time">{{ timeOf(s.modified) }}</span>
              <button class="del" title="删除" @click.stop="deleteSession(s)"><Icon name="trash" :size="14" /></button>
            </div>
          </template>
        </template>
      </div>
    </div>

    <div v-show="S.leftTab === 'files'" class="pane">
      <div class="search">
        <span class="ellipsis grow dim small" :title="S.cwd">{{ S.cwd }}</span>
        <button class="ib sm" title="刷新" @click="S.fsEpoch++"><Icon name="refresh" :size="15" /></button>
      </div>
      <div class="list tree">
        <TreeNode v-if="S.cwd" :key="S.cwd" :entry="{ name: base(S.cwd), path: S.cwd, dir: true }" :depth="0" root />
      </div>
    </div>

    <div v-show="S.leftTab === 'agents'" class="pane">
      <div class="hint">每个目录一个 pi 进程，切走后会在后台继续跑</div>
      <div class="list">
        <div v-if="!S.agents.length" class="empty">没有运行中的 pi</div>
        <div v-for="a in S.agents" :key="a.id" class="sess" :class="{ active: a.id === S.agentId }" :title="a.cwd" @click="openDir(a.cwd), closeDrawer()">
          <span class="dot" :class="a.running ? 'busy' : 'on'" />
          <div class="grow">
            <div class="ellipsis stitle">{{ base(a.cwd) }}</div>
            <div class="meta ellipsis">{{ a.running ? '运行中' : '空闲' }} · {{ a.sessionName || a.cwd }}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="foot">
      <span class="dot" :class="{ on: S.connected }" />
      <span class="small">{{ S.connected ? '已连接' : '正在重连…' }}</span>
      <span v-if="others" class="small dim">· {{ others }} 个后台运行</span>
      <div class="grow" />
      <button class="ib" title="界面设置 (Ctrl+,)" @click="(view.settingsOpen = true), closeDrawer()"><Icon name="settings" /></button>
    </div>
  </aside>
</template>

<style scoped>
.side { display: flex; flex-direction: column; min-height: 0; min-width: 0; background: var(--panel-2); user-select: none; }
.brand { display: flex; align-items: center; gap: 8px; height: 56px; padding: 0 10px 0 16px; flex: none; }
.logo { background: var(--accent); color: #fff; width: 28px; height: 28px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 16px; }
.name { font-size: calc(var(--fs) + 3px); font-weight: 700; }
.ib { width: 32px; height: 32px; border: 0; background: transparent; border-radius: 8px; color: var(--text-2); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.ib:hover { background: var(--active); color: var(--text); }
.ib.sm { width: 26px; height: 26px; }
.ib.on { color: var(--accent-text); background: var(--accent-soft); }

.nav { padding: 0 8px 6px; display: flex; flex-direction: column; gap: 1px; flex: none; }
.nv { display: flex; align-items: center; gap: 12px; height: 38px; padding: 0 10px; border-radius: 10px; cursor: pointer; color: var(--text); }
.nv:hover { background: var(--active); }
.nv.dis { opacity: 0.45; cursor: default; }
.nv :deep(.icon) { color: var(--text-2); }

.seg { display: flex; gap: 2px; margin: 4px 12px 6px; padding: 3px; background: var(--active); border-radius: 10px; flex: none; }
.st { flex: 1; text-align: center; height: 28px; line-height: 28px; border-radius: 7px; cursor: pointer; color: var(--text-2); font-size: var(--fs-sm); }
.st:hover { color: var(--text); }
.st.on { background: var(--panel); color: var(--text); font-weight: 600; box-shadow: var(--shadow-sm); }
[data-theme='dark'] .st.on { background: var(--elev); }
.cnt { margin-left: 4px; font-size: 11px; background: var(--active); padding: 0 6px; border-radius: 8px; color: var(--text-2); }

.pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.search { display: flex; align-items: center; gap: 6px; margin: 2px 12px 4px; padding: 0 4px 0 10px; height: 34px; border-radius: 9px; background: var(--panel); border: 1px solid var(--line); color: var(--text-3); flex: none; }
.search:focus-within { border-color: var(--accent); }
.search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--text); font-size: var(--fs-sm); }
.list { flex: 1; overflow-y: auto; padding: 2px 8px 12px; }
.tree { padding: 2px 6px 12px; }
.gname { font-size: var(--fs-xs); color: var(--text-3); padding: 12px 10px 4px; display: flex; align-items: center; gap: 6px; }
.dirhead { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px 0 6px; border-radius: 8px; cursor: pointer; color: var(--text); font-size: var(--fs-sm); margin-top: 4px; }
.dirhead:hover { background: var(--active); }
.dirhead .arrow { width: 16px; height: 16px; flex: none; display: inline-flex; align-items: center; justify-content: center; color: var(--text-3); transition: transform 0.15s; }
.dirhead.closed .arrow { transform: rotate(-90deg); }
.dirhead :deep(.icon) { color: var(--accent-text); opacity: 0.85; }
.dirhead .gcount { margin-left: auto; }
.sess.child { padding-left: 26px; }
.gcount { font-size: 10px; padding: 0 5px; border-radius: 7px; background: var(--active); color: var(--text-3); }
.sbtn { height: 22px; padding: 0 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel-2); color: var(--text-2); font-size: var(--fs-xs); cursor: pointer; flex: none; }
.sbtn:hover { border-color: var(--accent); color: var(--accent-text); }
.list > .sess, .list > .gname { content-visibility: auto; contain-intrinsic-size: auto 50px; }
.sess { display: flex; align-items: center; gap: 8px; padding: 7px 8px 7px 10px; border-radius: 10px; cursor: pointer; position: relative; }
.sess:hover { background: var(--active); }
.sess.active { background: var(--panel); box-shadow: var(--shadow-sm); }
[data-theme='dark'] .sess.active { background: var(--elev); }
.stitle { line-height: 1.45; }
.sess.active .stitle { font-weight: 600; color: var(--accent-text); }
.meta { font-size: var(--fs-xs); color: var(--text-3); margin-top: 1px; }
.time { font-size: 11px; color: var(--text-3); flex: none; align-self: flex-start; margin-top: 3px; }
.del { display: none; width: 26px; height: 26px; border: 0; border-radius: 7px; background: transparent; color: var(--text-3); cursor: pointer; align-items: center; justify-content: center; flex: none; }
.sess:hover .del { display: inline-flex; }
.sess:hover .time { display: none; }
.del:hover { background: var(--err); color: #fff; }
.sess .dot { margin: 0 4px; }
.empty { padding: 32px 12px; text-align: center; font-size: var(--fs-sm); color: var(--text-3); }
.hint { font-size: var(--fs-xs); color: var(--text-3); padding: 4px 18px 6px; }
.small { font-size: var(--fs-xs); }
.foot { display: flex; align-items: center; gap: 6px; height: 52px; padding: 0 8px 0 18px; border-top: 1px solid var(--line); flex: none; color: var(--text-2); }
/* 触屏上没有悬停，删除按钮一直显示会太乱：靠长按/右键菜单删除 */
@media (hover: none) {
  .sess:hover .del { display: none; }
  .sess:hover .time { display: inline; }
}
</style>
