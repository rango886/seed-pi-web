<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { S, openSession, deleteSession, setSessionArchived, renameSession, sessionStatus, setSessionMode, isFav, newSession, newSessionIn } from '../store.js';
import { view, toggleSide, closeDrawer, openMenu } from '../settings.js';
import Icon from './Icon.vue';
import DirectoryMenu from './DirectoryMenu.vue';
import SessionDisplayMenu from './SessionDisplayMenu.vue';
import { readSessionView, saveSessionView, matchesArchive, sessionInfo } from '../session-list.js';

const q = ref('');
const listElement = ref(null);
const listScrollbarWidth = ref(0);
const listScrolling = ref(false);
let scrollHideTimer;
let listObserver;
function onListScroll() {
  listScrolling.value = true;
  clearTimeout(scrollHideTimer);
  scrollHideTimer = setTimeout(() => { listScrolling.value = false; }, 800);
}
function syncListGutter() {
  const el = listElement.value;
  if (el) listScrollbarWidth.value = Math.max(0, el.offsetWidth - el.clientWidth);
}
onMounted(() => {
  syncListGutter();
  listObserver = new ResizeObserver(syncListGutter);
  listObserver.observe(listElement.value);
});
onUnmounted(() => {
  listObserver?.disconnect();
  clearTimeout(scrollHideTimer);
});
const base = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;

// 排序和显示设置跟随当前模式，各自记忆。
const sortBy = computed(() => cur.value.sort);
const sortLabel = computed(() => (sortBy.value === 'time' ? '时间' : '名称'));
function toggleSort() {
  saveUI({ sort: sortBy.value === 'time' ? 'name' : 'time' });
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

// 全部 / 当前目录 / 收藏各记一套。当前目录不用布局和目录名称选项。
const modeUI = reactive(Object.fromEntries(['all', 'dir', 'fav'].map((m) => [m, readSessionView(localStorage, m)])));
const cur = computed(() => modeUI[S.sessionMode] || modeUI.dir);
function saveUI(patch) {
  Object.assign(cur.value, patch);
  saveSessionView(localStorage, S.sessionMode, cur.value);
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
function dirMenu(e, path) {
  const group = cur.value.layout === 'group';
  openMenu(e.clientX, e.clientY, [
    path && { label: '在此目录新建会话', run: () => newIn(path) },
    path && { label: '复制路径', run: () => navigator.clipboard.writeText(path) },
    path && '-',
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
const showSessionPath = computed(() => flat.value && cur.value.showPath);
// 列表空的时候说人话：搜了关键词就说没搜到，否则说这个看法下为什么没东西
const emptyText = computed(() => {
  if (q.value.trim()) return '当前筛选下没有匹配的会话';
  if (cur.value.archive === 'archived') return '当前范围内没有已归档会话';
  if (cur.value.archive === 'active' && [...unsaved.value, ...S.sessions].some((s) => inMode(s.cwd) && s.archived)) return '当前范围内没有未归档会话，可在“显示”中查看已归档会话';
  if (S.sessionMode === 'all') return '还没有历史会话';
  if (S.sessionMode === 'fav') return S.favorites.length ? '收藏的目录还没有会话' : '还没有收藏的文件夹：在右侧文件树里右键一个文件夹就能收藏';
  return '这个目录还没有历史会话';
});

// 会话分组：按目录看（全部 / 收藏）时按目录分组，只看当前目录时按时间分组；组内再按当前排序方式排
const groups = computed(() => {
  const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
  const list = [...unsaved.value, ...S.sessions].filter((s) => inMode(s.cwd) && matchesArchive(s, cur.value.archive) && words.every((w) => `${s.title} ${s.cwd || ''}`.toLowerCase().includes(w)));
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
  return buckets.filter((b) => b.items.length).map((b) => ({ ...b, items: b.items.sort(byTime) }));
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
function newHere() {
  newSession();
  closeDrawer();
}
function newIn(cwd) {
  newSessionIn(cwd);
  closeDrawer();
}
function sessionMenu(e, s) {
  openMenu(e.clientX, e.clientY, [
    { label: '打开', run: () => open(s) },
    s.file === S.agent?.sessionFile && { label: '重命名…', run: () => renameSession() },
    { label: '复制文件路径', run: () => navigator.clipboard.writeText(s.file) },
    ...(s.unsaved ? [] : ['-',
      { label: s.archived ? '取消归档' : '归档', run: () => setSessionArchived(s, !s.archived) },
      { label: '删除', danger: true, run: () => deleteSession(s) },
    ]),
    // 全部 / 收藏里列表可能被会话铺满、右键点不到空白处，所以会话的菜单里也留一个显示模式的入口
    ...(S.sessionMode === 'dir' ? [] : ['-', { label: '显示模式', children: layoutItems() }]),
  ].filter(Boolean));
}
</script>

<template>
  <aside class="side">
    <div class="brand">
      <span class="logo" role="img" aria-label="pi"><Icon name="pi" :size="18" aria-hidden="true" /></span>
      <div class="grow" />
      <button class="ib" :title="view.mobile ? '关闭' : '收起侧栏 (Ctrl+B)'" @click="toggleSide(false)"><Icon :name="view.mobile ? 'close' : 'sidebar'" /></button>
    </div>

    <!-- 新建：当前目录一键新建；其他目录单独一个按钮，弹出收藏 / 最近 / 浏览 -->
    <div class="actions">
      <button type="button" class="abtn" :title="`在当前目录新建会话 (Alt+N)\n${S.cwd || ''}`" @click="newHere"><Icon name="newchat" :size="16" /><span class="ellipsis">新会话</span></button>
      <DirectoryMenu @select="closeDrawer" />
    </div>

    <!-- 左边只放会话；文件、进程在右边的浮动侧栏里（按钮在顶栏），终端在顶部标签页里 -->
    <div class="pane">
      <div class="search">
        <Icon name="search" :size="15" />
        <input v-model="q" placeholder="搜索会话" @keydown.esc="q = ''" />
        <button type="button" class="sbtn" :title="`当前模式按${sortLabel}排序，点击切换`" @click="toggleSort">{{ sortLabel }}</button>
        <SessionDisplayMenu :mode="S.sessionMode" :settings="cur" @mode-change="setSessionMode" @change="saveUI" />
      </div>
      <div ref="listElement" class="list" :class="{ scrolling: listScrolling }" :style="{ '--list-scrollbar-width': listScrollbarWidth + 'px' }" @scroll.passive="onListScroll" @contextmenu="listMenu">
        <div v-if="!groups.length" class="empty">{{ emptyText }}</div>
        <template v-for="g in groups" :key="g.path || g.name">
          <!-- 目录：像文件夹一样，点一下折叠/展开；右键可以全部展开折叠、切路径显示 -->
          <div v-if="g.path" class="dirhead" :class="{ closed: isCollapsed(g.path) }" :title="g.path" @click="toggleDir(g.path)" @contextmenu.prevent.stop="dirMenu($event, g.path)">
            <span class="arrow"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 6l6 6-6 6" /></svg></span>
            <Icon name="folder" :size="15" />
            <span class="ellipsis grow">{{ g.name }}</span>
            <span class="gcount">{{ g.items.length }}</span>
            <button type="button" class="dir-new" :title="`在这个目录新建会话\n${g.path}`" aria-label="在这个目录新建会话" @click.stop="newIn(g.path)"><Icon name="plus" :size="14" /></button>
          </div>
          <div v-else-if="g.name" class="gname">{{ g.name }}</div>
          <template v-if="!g.path || !isCollapsed(g.path)">
            <div
              v-for="s in g.items"
              :key="s.file"
              class="sess"
              :class="{ active: s.file === (S.agent?.sessionFile || S.detached?.file), child: !!g.path, 'has-st': !!g.path && !!stat(s)?.cls, saved: !s.unsaved }"
              :title="s.title"
              tabindex="0"
              @keydown.enter.self.prevent="open(s)"
              @click="open(s)"
              @contextmenu.prevent.stop="sessionMenu($event, s)"
            >
              <span v-if="stat(s)?.cls" class="st" :class="stat(s).cls" :title="stat(s).tip" />
              <Icon v-if="s.archived" name="archive" :size="13" class="archive-mark" title="已归档" />
              <span class="ellipsis grow stitle">{{ s.title }}</span>
              <span v-if="showSessionPath" class="sdir" :title="s.cwd">{{ cur.dirLabel === 'path' ? s.cwd : base(s.cwd) }}</span>
              <span v-if="sessionInfo(s, cur, timeOf)" class="sinfo">{{ sessionInfo(s, cur, timeOf) }}</span>
              <button v-if="!s.unsaved" type="button" class="sess-action arch" :title="s.archived ? '取消归档' : '归档'" :aria-label="s.archived ? '取消归档' : '归档'" @click.stop="setSessionArchived(s, !s.archived)"><Icon :name="s.archived ? 'unarchive' : 'archive'" :size="14" /></button>
              <button v-if="!s.unsaved" type="button" class="sess-action del" title="删除" aria-label="删除" @click.stop="deleteSession(s)"><Icon name="trash" :size="14" /></button>
            </div>
          </template>
        </template>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.side { --side-gutter: 12px; --side-inset: 8px; --session-indent: 47px; display: flex; flex-direction: column; min-height: 0; min-width: 0; background: var(--panel-2); user-select: none; }
/* 顶部两端和搜索框 / 会话行的外边缘共用同一条对齐线。 */
.brand { display: flex; align-items: center; gap: 8px; height: 52px; padding: 0 var(--side-gutter); flex: none; }
.logo { background: var(--accent); color: #fff; width: 28px; height: 28px; border-radius: var(--r-sm); display: inline-flex; align-items: center; justify-content: center; flex: none; }
/* 用固定路径代替文字 π，避免不同字体的基线和字面留白让标记偏下。 */
.logo :deep(.icon) { stroke-width: 2.6; }
.brand > .ib { width: 28px; height: 28px; padding: 0; }
.ib { width: 32px; height: 32px; border: 0; background: transparent; border-radius: var(--r-sm); color: var(--text-2); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.ib:hover { background: var(--active); color: var(--text); }
.ib.sm { width: 26px; height: 26px; }
.ib.on { color: var(--accent-text); background: var(--accent-soft); }

.pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
/* 两个新建按钮：和搜索框同一套外观，左右对齐同一条线 */
.actions { display: flex; gap: 6px; margin: 0 var(--side-gutter) 8px; flex: none; }
.abtn { flex: 1; min-width: 0; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 10px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--panel); color: var(--text-2); font-size: var(--fs-sm); cursor: pointer; transition: border-color 0.15s, color 0.15s; }
.abtn:hover { border-color: var(--accent); color: var(--accent-text); }
/* 目录行悬停时，计数换成「+」：一步在这个目录新建，和会话行悬停出归档/删除一个路子 */
.dir-new { display: none; width: 24px; height: 24px; margin-left: auto; margin-right: -4px; padding: 0; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text-3); cursor: pointer; align-items: center; justify-content: center; flex: none; }
.dir-new:hover { background: var(--accent-soft); color: var(--accent-text); }
.dirhead:hover .dir-new, .dirhead:focus-within .dir-new { display: inline-flex; }
.dirhead:hover .gcount, .dirhead:focus-within .gcount { display: none; }
.dirhead .dir-new :deep(.icon) { color: inherit; opacity: 1; }
.search { display: flex; align-items: center; gap: 6px; margin: 0 var(--side-gutter) 8px; padding: 0 4px 0 var(--side-inset); height: 34px; border-radius: var(--r-sm); background: var(--panel); border: 1px solid var(--line); color: var(--text-3); flex: none; }
.search:focus-within { border-color: var(--accent); }
.search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--text); font-size: var(--fs-sm); }
/* 右侧总留白包含滚动条宽度；预留滚动槽，展开目录或切换模式时不挤动列表。 */
.list { --list-scroll-thumb: transparent; flex: 1; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; padding: 0 max(0px, calc(var(--side-gutter) - var(--list-scrollbar-width, 0px))) 12px var(--side-gutter); }
/* 只隐藏滑块颜色，滚动槽宽度不变。键盘操作时也显示，但鼠标点击留下的焦点不会阻止隐藏。 */
.list:is(:hover, .scrolling, :focus-visible, :has(:focus-visible)) { --list-scroll-thumb: var(--scroll); }
.list::-webkit-scrollbar-thumb { background-color: var(--list-scroll-thumb); transition: background-color 0.18s ease; }
.list::-webkit-scrollbar-thumb:hover { background-color: var(--text-3); }
/* Chromium 使用上面的细滑块；Firefox 使用标准属性，避免两套规则互相覆盖。 */
@supports not selector(::-webkit-scrollbar) {
  .list { scrollbar-color: var(--list-scroll-thumb) transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .list::-webkit-scrollbar-thumb { transition: none; }
}
@media (forced-colors: active) {
  .list { --scroll: CanvasText; --list-scroll-thumb: CanvasText; }
}
.tree { padding: 2px 6px 12px; }
.gname { font-size: var(--fs-xs); color: var(--text-3); padding: 12px var(--side-inset) 4px; display: flex; align-items: center; gap: 6px; }
.gname:first-child { padding-top: 4px; }
.dirhead { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 var(--side-inset); border-radius: var(--r-sm); cursor: pointer; color: var(--text-2); font-size: var(--fs-sm); font-weight: 500; margin: 10px 0 2px; }
.dirhead:first-child { margin-top: 0; }
.dirhead:hover { background: var(--active); }
.dirhead .arrow { width: 12px; height: 16px; flex: none; display: inline-flex; align-items: center; justify-content: center; color: var(--text-3); transform: rotate(90deg); transition: transform 0.15s; }
/* 折叠的时候箭头朝右（就是 svg 本身的样子），展开的时候转 90° 朝下 */
.dirhead.closed .arrow { transform: rotate(0deg); }
.dirhead :deep(.icon) { color: var(--accent-text); opacity: 0.85; }
.dirhead .gcount { margin-left: auto; }
/* 目录名和子会话对齐：8(内边距) + 12(箭头) + 6 + 15(图标) + 6 = 47px。 */
.sess.child { padding-left: var(--session-indent); }
/* 状态点和间隔共占 14px，抵消这部分宽度，避免标题左右跳动。 */
.sess.child.has-st { padding-left: calc(var(--session-indent) - 14px); }
.gcount { font-size: var(--fs-xs); min-width: 20px; line-height: 18px; text-align: center; font-variant-numeric: tabular-nums; padding: 0 5px; border-radius: var(--r-pill); background: var(--active); color: var(--text-3); }
.sbtn { height: 22px; padding: 0 6px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--panel-2); color: var(--text-2); font-size: var(--fs-xs); cursor: pointer; flex: none; }
.sbtn:hover { border-color: var(--accent); color: var(--accent-text); }
.list > .sess, .list > .gname { content-visibility: auto; contain-intrinsic-size: auto 30px; }
.sess { display: flex; align-items: center; gap: 8px; height: 30px; margin-bottom: 2px; padding: 0 var(--side-inset); border-radius: var(--r-sm); cursor: pointer; position: relative; font-size: calc(var(--fs) - 1px); }
.sess:hover { background: var(--active); }
.sess.active { background: var(--panel); box-shadow: var(--shadow-sm); }
[data-theme='dark'] .sess.active { background: var(--elev); }
.stitle { line-height: 1.4; }
.sess.active .stitle { font-weight: 600; color: var(--accent-text); }
.sdir { font-size: var(--fs-xs); color: var(--text-3); flex: none; max-width: 88px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sinfo { font-size: var(--fs-xs); color: var(--text-3); flex: none; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.sess-action { display: none; width: 24px; height: 24px; padding: 0; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text-3); cursor: pointer; align-items: center; justify-content: center; flex: none; }
.sess:hover .sess-action, .sess:focus-within .sess-action { display: inline-flex; }
.sess.saved:hover .sinfo, .sess.saved:hover .sdir, .sess.saved:focus-within .sinfo, .sess.saved:focus-within .sdir { display: none; }
.arch:hover { background: var(--accent-soft); color: var(--accent-text); }
.del:hover { background: var(--err); color: #fff; }
.archive-mark { color: var(--text-3); }
.sess:focus-visible { outline: 2px solid var(--accent-soft); outline-offset: -2px; }
/* 会话前面的状态点：没状态时整个不画（见模板里的 v-if），标题直接顶到左边，不留一块空白 */
.st { width: 8px; height: 8px; flex: none; margin-right: -2px; border-radius: 50%; position: relative; }
.st.run { border: 2px solid var(--accent); border-right-color: transparent; width: 10px; height: 10px; margin: 0 -3px 0 -1px; animation: st-spin 0.8s linear infinite; }
.st.new { background: var(--accent); }
.st.wait { background: var(--warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 25%, transparent); }
.st.busy { border: 1.5px solid var(--text-3); }
@keyframes st-spin { to { transform: rotate(360deg); } }
.empty { padding: 32px 12px; text-align: center; font-size: var(--fs-sm); color: var(--text-3); }
.hint { font-size: var(--fs-xs); color: var(--text-3); padding: 4px 18px 6px; }
/* 触屏靠长按/右键菜单归档和删除，键盘聚焦仍能使用行内按钮。 */
@media (hover: none) {
  .dir-new { display: inline-flex; }
  .dirhead .gcount { display: none; }
  .sess:hover:not(:focus-within) .sess-action { display: none; }
  .sess.saved:hover:not(:focus-within) .sinfo, .sess.saved:hover:not(:focus-within) .sdir { display: inline; }
}
</style>
