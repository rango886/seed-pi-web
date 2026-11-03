<script setup>
import { ref, reactive, computed } from 'vue';
import { S, openSession, newSession, deleteSession, renameSession, sessionStatus, setSessionMode, isFav } from '../store.js';
import { view, toggleSide, closeDrawer, openMenu } from '../settings.js';
import Icon from './Icon.vue';

const q = ref('');
const base = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;

// 排序方式：时间 / 名称，存 localStorage
const sortBy = ref(localStorage.getItem('pi-web-sort') || 'time');
const sortLabel = computed(() => (sortBy.value === 'time' ? '时间' : '名称'));
function toggleSort() {
  sortBy.value = sortBy.value === 'time' ? 'name' : 'time';
  localStorage.setItem('pi-web-sort', sortBy.value);
}
const byTime = (a, b) => new Date(b.modified) - new Date(a.modified);
const byName = (a, b) => (a.title || '').localeCompare(b.title || '', 'zh');
const norm = (p) => (p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();

// 还没写盘的新会话（pi 要等有了消息才写文件）：磁盘上扫不到，从进程列表里补上
const unsaved = computed(() => {
  const known = new Set(S.sessions.map((s) => norm(s.file)));
  return S.agents
    .filter((a) => a.sessionFile && !known.has(norm(a.sessionFile)) && inMode(a.cwd))
    .map((a) => ({ file: a.sessionFile, cwd: a.cwd, title: a.sessionName || '新会话', modified: new Date().toISOString(), messages: 0, unsaved: true }));
});
/** 这三种看法（当前目录 / 全部 / 收藏）里，这个目录该不该出现 */
const inMode = (cwd) => (S.sessionMode === 'all' ? true : S.sessionMode === 'fav' ? isFav(cwd) : norm(cwd) === norm(S.cwd));

// 会话前面的状态图标
function stat(s) {
  const st = sessionStatus(s.file);
  if (!st) return null;
  if (st.waiting) return { cls: 'wait', tip: '在等你操作（扩展弹窗）' };
  if (st.running) return { cls: 'run', tip: st.elsewhere ? 'AI 正在回复（另一个窗口在用）' : 'AI 正在回复' };
  if (st.unread) return { cls: 'new', tip: '有新回复还没看' };
  if (st.elsewhere) return { cls: 'busy', tip: '另一个窗口正在用' };
  return null;
}

// 全部 / 收藏这两处会把不同目录的会话摆在一起，怎么摆由下面这套设置决定。
// 关键：这两处各记一套，互不影响——在“全部”里切成平铺，“收藏”还是它自己那套。
//   layout    平铺显示（flat：所有会话铺成一列）/ 折叠显示（group：每个目录一个文件夹，点一下折叠/展开）
//            默认：全部是平铺，收藏是折叠
//   dirLabel  目录那一列显示完整路径还是只显示文件夹名
//   collapsed 哪些目录被折叠了（记目录路径）
const uiKey = () => (S.sessionMode === 'fav' ? 'fav' : 'all');
function readUI(m) {
  const get = (k) => localStorage.getItem(`pi-web-${k}-${m}`);
  let collapsed = [];
  try {
    collapsed = JSON.parse(get('collapsed-dirs') || '[]') || [];
  } catch {
    collapsed = [];
  }
  return {
    layout: (get('session-layout') || (m === 'fav' ? 'group' : 'flat')) === 'flat' ? 'flat' : 'group',
    dirLabel: get('dir-label') === 'path' ? 'path' : 'name',
    collapsed,
  };
}
const modeUI = reactive({ all: readUI('all'), fav: readUI('fav') });
/** 当前这个看法（全部 / 收藏）自己那一套显示设置 */
const cur = computed(() => modeUI[uiKey()]);
/** 改当前看法的那一套设置，并只写回它自己的键 */
function saveUI(patch) {
  const m = uiKey();
  Object.assign(modeUI[m], patch);
  localStorage.setItem(`pi-web-collapsed-dirs-${m}`, JSON.stringify(modeUI[m].collapsed));
  localStorage.setItem(`pi-web-session-layout-${m}`, modeUI[m].layout);
  localStorage.setItem(`pi-web-dir-label-${m}`, modeUI[m].dirLabel);
}
const isCollapsed = (p) => cur.value.collapsed.includes(p);
function toggleDir(key) {
  const list = cur.value.collapsed;
  saveUI({ collapsed: list.includes(key) ? list.filter((x) => x !== key) : [...list, key] });
}
function expandAll() {
  saveUI({ collapsed: [] });
}
function collapseAll() {
  saveUI({ collapsed: groups.value.map((g) => g.path).filter(Boolean) });
}
function setDirLabel(v) {
  saveUI({ dirLabel: v });
}
function setLayout(v) {
  saveUI({ layout: v });
}
/** 右键菜单里“显示模式”那一组（每次开菜单时现算，勾选状态才对） */
const layoutItems = () => [
  { label: '平铺显示', check: cur.value.layout === 'flat', run: () => setLayout('flat') },
  { label: '折叠显示', check: cur.value.layout === 'group', run: () => setLayout('group') },
];
function dirMenu(e) {
  const group = cur.value.layout === 'group';
  openMenu(e.clientX, e.clientY, [
    ...layoutItems(),
    group && '-',
    group && { label: '全部展开', run: expandAll },
    group && { label: '全部折叠', run: collapseAll },
    group && '-',
    group && { label: '显示完整路径', check: cur.value.dirLabel === 'path', run: () => setDirLabel('path') },
    group && { label: '只显示文件夹名称', check: cur.value.dirLabel === 'name', run: () => setDirLabel('name') },
  ].filter(Boolean));
}
// 列表空白处的右键：全部 / 收藏时接管（切换平铺和折叠），只看当前目录时交回页面自己的菜单
function listMenu(e) {
  if (S.sessionMode === 'dir') return;
  e.preventDefault();
  e.stopPropagation();
  dirMenu(e);
}

// 是不是“按目录分组”摆：只有全部 / 收藏才有分目录这回事，当前目录本来就是一个目录
const byDir = computed(() => S.sessionMode !== 'dir' && cur.value.layout === 'group');
const flat = computed(() => S.sessionMode !== 'dir' && cur.value.layout === 'flat');
// 列表空的时候说人话：搜了关键词就说没搜到，否则说这个看法下为什么没东西
const emptyText = computed(() => {
  if (q.value.trim()) return '没有匹配的会话';
  if (S.sessionMode === 'all') return '还没有历史会话';
  if (S.sessionMode === 'fav') return S.favorites.length ? '收藏的目录还没有会话' : '还没有收藏的文件夹：在右侧文件树里右键一个文件夹就能收藏';
  return '这个目录还没有历史会话';
});

// 会话分组：按目录看（全部 / 收藏）时按目录分组，只看当前目录时按时间分组；组内再按当前排序方式排
const groups = computed(() => {
  const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
  let list = [...unsaved.value, ...S.sessions].filter((s) => words.every((w) => `${s.title} ${s.cwd || ''}`.toLowerCase().includes(w)));
  if (S.sessionMode === 'fav') list = list.filter((s) => isFav(s.cwd)); // 收藏：只要收藏目录里的会话
  const cmp = sortBy.value === 'name' ? byName : byTime;

  if (byDir.value) {
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
      if (cur.value.dirLabel === 'path') return cwd || '(未知目录)';
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

  // 平铺显示：不分目录，全部摆一列，按当前排序方式排
  if (flat.value) return list.length ? [{ name: '', items: list.sort(cmp) }] : [];

  if (sortBy.value === 'name') return list.length ? [{ name: '', items: list.sort(byName) }] : [];

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
// 右边那列时间/日期：今天显示 HH:MM，其余显示 MM/DD。
// 月日都补成两位（11/1 → 11/01），这样每行的长度一致，右侧那一列才能对齐
const timeOf = (iso) => {
  const d = new Date(iso);
  const p2 = (n) => String(n).padStart(2, '0');
  const today = new Date().toDateString() === d.toDateString();
  return today ? `${p2(d.getHours())}:${p2(d.getMinutes())}` : `${p2(d.getMonth() + 1)}/${p2(d.getDate())}`;
};

function open(s) {
  openSession(s.file);
  closeDrawer();
}
function onNew() {
  newSession(); // 现在会先弹目录选择窗口，选完才建会话
  closeDrawer();
}
function sessionMenu(e, s) {
  openMenu(e.clientX, e.clientY, [
    { label: '打开', run: () => open(s) },
    s.file === S.agent?.sessionFile && { label: '重命名…', run: () => renameSession() },
    { label: '复制文件路径', run: () => navigator.clipboard.writeText(s.file) },
    ...(s.unsaved ? [] : ['-', { label: '删除', danger: true, run: () => deleteSession(s) }]),
    // 全部 / 收藏里列表可能被会话铺满、右键点不到空白处，所以会话的菜单里也留一个显示模式的入口
    ...(S.sessionMode === 'dir' ? [] : ['-', { label: '显示模式', children: layoutItems() }]),
  ].filter(Boolean));
}
</script>

<template>
  <aside class="side">
    <div class="brand">
      <span class="logo">π</span>
      <span class="name">pi</span>
      <div class="grow" />
      <button class="ib" :title="view.mobile ? '关闭' : '收起侧栏 (Ctrl+B)'" @click="toggleSide(false)"><Icon :name="view.mobile ? 'close' : 'sidebar'" /></button>
    </div>

    <div class="nav">
      <div class="nv" @click="onNew()"><Icon name="newchat" /><span>新会话</span></div>
    </div>

    <!-- 左边只放会话；文件、进程在右边的浮动侧栏里（按钮在顶栏），终端在顶部标签页里 -->
    <div class="pane">
      <!-- 三种看法：全部目录 / 当前目录 / 收藏的目录。全部和收藏都会把不同目录的会话凑在一起，可平铺也可按目录折叠 -->
      <div class="modes">
        <button class="mode" :class="{ on: S.sessionMode === 'all' }" title="所有目录的会话，右键列表可以切换平铺 / 折叠" @click="setSessionMode('all')">全部</button>
        <button class="mode" :class="{ on: S.sessionMode === 'dir' }" title="只看当前目录的会话" @click="setSessionMode('dir')">当前目录</button>
        <button class="mode" :class="{ on: S.sessionMode === 'fav' }" :title="`只看收藏目录的会话${S.favorites.length ? '（' + S.favorites.length + ' 个目录）' : ''}`" @click="setSessionMode('fav')">收藏</button>
      </div>
      <div class="search">
        <Icon name="search" :size="15" />
        <input v-model="q" placeholder="搜索会话" @keydown.esc="q = ''" />
        <button class="sbtn" :title="`当前按${sortLabel}排序，点击切换`" @click="toggleSort">{{ sortLabel }}</button>
      </div>
      <div class="list" @contextmenu="listMenu">
        <div v-if="!groups.length" class="empty">{{ emptyText }}</div>
        <template v-for="g in groups" :key="g.path || g.name">
          <!-- 目录：像文件夹一样，点一下折叠/展开；右键可以全部展开折叠、切路径显示 -->
          <div v-if="g.path" class="dirhead" :class="{ closed: isCollapsed(g.path) }" :title="g.path" @click="toggleDir(g.path)" @contextmenu.prevent.stop="dirMenu($event)">
            <span class="arrow"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 6l6 6-6 6" /></svg></span>
            <Icon name="folder" :size="15" />
            <span class="ellipsis grow">{{ g.name }}</span>
            <span class="gcount">{{ g.items.length }}</span>
          </div>
          <div v-else-if="g.name" class="gname">{{ g.name }}</div>
          <template v-if="!g.path || !isCollapsed(g.path)">
            <div
              v-for="s in g.items"
              :key="s.file"
              class="sess"
              :class="{ active: s.file === (S.agent?.sessionFile || S.detached?.file), child: !!g.path, 'has-st': !!g.path && !!stat(s)?.cls }"
              :title="s.title"
              @click="open(s)"
              @contextmenu.prevent.stop="sessionMenu($event, s)"
            >
              <span v-if="stat(s)?.cls" class="st" :class="stat(s).cls" :title="stat(s).tip" />
              <span class="ellipsis grow stitle">{{ s.title }}</span>
              <span v-if="flat" class="sdir">{{ base(s.cwd) }}</span>
              <span class="sinfo">{{ s.unsaved ? '未保存' : `${s.messages} 条 · ${timeOf(s.modified)}` }}</span>
              <button v-if="!s.unsaved" class="del" title="删除" @click.stop="deleteSession(s)"><Icon name="trash" :size="14" /></button>
            </div>
          </template>
        </template>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.side { display: flex; flex-direction: column; min-height: 0; min-width: 0; background: var(--panel-2); user-select: none; }
.brand { display: flex; align-items: center; gap: 8px; height: 56px; padding: 0 10px 0 16px; flex: none; }
.logo { background: var(--accent); color: #fff; width: 28px; height: 28px; border-radius: var(--r-sm); display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 16px; }
.name { font-size: calc(var(--fs) + 3px); font-weight: 700; }
.ib { width: 32px; height: 32px; border: 0; background: transparent; border-radius: var(--r-sm); color: var(--text-2); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.ib:hover { background: var(--active); color: var(--text); }
.ib.sm { width: 26px; height: 26px; }
.ib.on { color: var(--accent-text); background: var(--accent-soft); }

.nav { padding: 0 8px 6px; display: flex; flex-direction: column; gap: 1px; flex: none; }
.nv { display: flex; align-items: center; gap: 12px; height: 38px; padding: 0 10px; border-radius: var(--r-md); cursor: pointer; color: var(--text); }
.nv:hover { background: var(--active); }
.nv.dis { opacity: 0.45; cursor: default; }
.nv :deep(.icon) { color: var(--text-2); }

/* 会话列表的三种看法（全部 / 当前目录 / 收藏）：一格一格的小按钮，选了的那格浮起来 */
.modes { display: flex; gap: 2px; margin: 2px 12px 8px; padding: 3px; background: var(--active); border-radius: var(--r-sm); flex: none; }
.mode { flex: 1; min-width: 0; height: 26px; padding: 0; border: 0; background: transparent; border-radius: calc(var(--r-sm) - 2px); color: var(--text-2); font-size: var(--fs-xs); cursor: pointer; white-space: nowrap; }
.mode:hover { color: var(--text); }
.mode.on { background: var(--panel); color: var(--accent-text); font-weight: 600; box-shadow: var(--shadow-sm); }
[data-theme='dark'] .mode.on { background: var(--elev); }

.pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.search { display: flex; align-items: center; gap: 6px; margin: 0 12px 8px; padding: 0 4px 0 10px; height: 34px; border-radius: var(--r-sm); background: var(--panel); border: 1px solid var(--line); color: var(--text-3); flex: none; }
.search:focus-within { border-color: var(--accent); }
.search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--text); font-size: var(--fs-sm); }
.list { flex: 1; overflow-y: auto; padding: 2px 8px 12px; }
.tree { padding: 2px 6px 12px; }
.gname { font-size: var(--fs-xs); color: var(--text-3); padding: 12px 10px 4px; display: flex; align-items: center; gap: 6px; }
.dirhead { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px 0 6px; border-radius: var(--r-sm); cursor: pointer; color: var(--text); font-size: var(--fs-sm); margin-top: 4px; }
.dirhead:hover { background: var(--active); }
.dirhead .arrow { width: 16px; height: 16px; flex: none; display: inline-flex; align-items: center; justify-content: center; color: var(--text-3); transform: rotate(90deg); transition: transform 0.15s; }
/* 折叠的时候箭头朝右（就是 svg 本身的样子），展开的时候转 90° 朝下 */
.dirhead.closed .arrow { transform: rotate(0deg); }
.dirhead :deep(.icon) { color: var(--accent-text); opacity: 0.85; }
.dirhead .gcount { margin-left: auto; }
/* 文件夹里的会话跟文件夹名对齐：目录头是 6(左 padding) + 16(箭头) + 6(gap) + 15(图标) + 6(gap) = 49px */
.sess.child { padding-left: 49px; }
/* 标题前面有状态点时，那个点连 gap 一共占 14px，把缩进相应减掉，标题还是落在 49px */
.sess.child.has-st { padding-left: 35px; }
.gcount { font-size: 10px; padding: 0 5px; border-radius: var(--r-pill); background: var(--active); color: var(--text-3); }
.sbtn { height: 22px; padding: 0 8px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--panel-2); color: var(--text-2); font-size: var(--fs-xs); cursor: pointer; flex: none; }
.sbtn:hover { border-color: var(--accent); color: var(--accent-text); }
.list > .sess, .list > .gname { content-visibility: auto; contain-intrinsic-size: auto 34px; }
.sess { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 8px 0 10px; border-radius: var(--r-sm); cursor: pointer; position: relative; }
.sess:hover { background: var(--active); }
.sess.active { background: var(--panel); box-shadow: var(--shadow-sm); }
[data-theme='dark'] .sess.active { background: var(--elev); }
.stitle { line-height: 1.4; }
.sess.active .stitle { font-weight: 600; color: var(--accent-text); }
.sdir { font-size: var(--fs-xs); color: var(--text-3); flex: none; max-width: 88px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sinfo { font-size: var(--fs-xs); color: var(--text-3); flex: none; font-variant-numeric: tabular-nums; text-align: right; }
.del { display: none; width: 24px; height: 24px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text-3); cursor: pointer; align-items: center; justify-content: center; flex: none; }
.sess:hover .del { display: inline-flex; }
.sess:hover .sinfo, .sess:hover .sdir { display: none; }
.del:hover { background: var(--err); color: #fff; }
/* 会话前面的状态点：没状态时整个不画（见模板里的 v-if），标题直接顶到左边，不留一块空白 */
.st { width: 8px; height: 8px; flex: none; margin-right: -2px; border-radius: 50%; position: relative; }
.st.run { border: 2px solid var(--accent); border-right-color: transparent; width: 10px; height: 10px; margin: 0 -3px 0 -1px; animation: st-spin 0.8s linear infinite; }
.st.new { background: var(--accent); }
.st.wait { background: var(--warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 25%, transparent); }
.st.busy { border: 1.5px solid var(--text-3); }
@keyframes st-spin { to { transform: rotate(360deg); } }
.empty { padding: 32px 12px; text-align: center; font-size: var(--fs-sm); color: var(--text-3); }
.hint { font-size: var(--fs-xs); color: var(--text-3); padding: 4px 18px 6px; }
/* 触屏上没有悬停，删除按钮一直显示会太乱：靠长按/右键菜单删除 */
@media (hover: none) {
  .sess:hover .del { display: none; }
  .sess:hover .sinfo, .sess:hover .sdir { display: inline; }
}
</style>
