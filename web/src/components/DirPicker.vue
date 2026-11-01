// 选目录的窗口：左边是最近用过 / 正在跑的目录（完整路径），右边两种看法
//  - 多栏：像 mac 的 Finder，点一层右边多一栏，层数多了横向滚动
//  - 树状：一层层展开的树
// 选好以后要么在当前标签页打开 / 开新会话，要么丢到新标签页去（Ctrl+点击也行）
<script setup>
import { ref, computed, watch, nextTick } from 'vue';
import { S, openDir, newSessionIn, openInNewTab } from '../store.js';
import { http } from '../api.js';
import { relTime } from '../util.js';
import Icon from './Icon.vue';
import DirTreeNode from './DirTreeNode.vue';

const mode = computed(() => S.dirPickerMode || 'switch');
const sep = computed(() => S.info.sep || '/');
// 上次用的是多栏还是树状，记在 localStorage 里，下次打开还用它
const VIEW_KEY = 'pi-web-dir-view';
const viewMode = ref(localStorage.getItem(VIEW_KEY) === 'tree' ? 'tree' : 'cols');
watch(viewMode, (v) => localStorage.setItem(VIEW_KEY, v));

const roots = ref([]);
const cols = ref([]); // [{ path, parent, sep, entries }]，当前展开的每一层
const current = ref(''); // 选中的目录（完整路径）
const pathInput = ref('');
const filter = ref('');
const error = ref('');
const recent = ref([]);
const colsEl = ref(null);
const inputEl = ref(null);

const norm = (p) => (p || '').replace(/[\\/]+$/, '').toLowerCase();
const join = (dir, name, s = sep.value) => (dir.endsWith(s) ? dir + name : dir + s + name);

const list = (p) => http.get('/api/fs/list', { path: p, dirsOnly: 1 });

function select(p) {
  current.value = p;
  pathInput.value = p;
}
function pickInTree(p) {
  select(p);
}
function scrollEnd() {
  nextTick(() => {
    const el = colsEl.value;
    if (!el) return;
    // 让最深的那一栏完整露出来（它右边缘贴齐可视区，前面更浅的栏自然往左收）
    const last = [...el.querySelectorAll('.col')].pop();
    if (!last) return;
    el.scrollLeft = Math.max(0, last.offsetLeft + last.offsetWidth - el.clientWidth + 6);
  });
}
const isCurrent = (p) => !!current.value && norm(p) === norm(current.value);

const filtered = (c) => (filter.value ? c.entries.filter((e) => e.name.toLowerCase().includes(filter.value.toLowerCase())) : c.entries);

/** 打开某个目录：从磁盘根开始一层层把栏目铺出来 */
async function reveal(p) {
  if (!p) return;
  try {
    if (!roots.value.length) roots.value = await http.get('/api/fs/roots');
    const root = roots.value.find((r) => norm(p).startsWith(norm(r.path)));
    if (!root) throw new Error(`找不到 ${p} 所在的磁盘`);
    const segs = p.slice(root.path.length).split(/[\\/]/).filter(Boolean);
    const stack = [];
    let cur = root.path;
    for (const s of segs) {
      stack.push(await list(cur));
      cur = join(cur, s);
    }
    stack.push(await list(cur));
    cols.value = stack;
    select(cur);
    error.value = '';
    scrollEnd();
  } catch (e) {
    error.value = e.message;
    cols.value = [];
    select(p);
  }
}

/** 点某一栏里的目录：右边换成一栏新的（更深的层丢掉） */
async function enter(i, entry) {
  const p = join(cols.value[i].path, entry.name);
  cols.value = cols.value.slice(0, i + 1);
  try {
    const d = await list(p);
    cols.value = [...cols.value, d];
    select(d.path);
    error.value = '';
    scrollEnd();
  } catch (e) {
    error.value = e.message;
  }
}

async function clickRoot(r) {
  cols.value = [];
  try {
    const d = await list(r.path);
    cols.value = [d];
    select(d.path);
    error.value = '';
    scrollEnd();
  } catch (e) {
    error.value = e.message;
  }
}

// ---- 打开 / 新建 ----
function close() {
  S.dirPicker = false;
}
const verb = computed(() => (mode.value === 'new' ? '创建会话' : '打开目录'));

/** 主操作：当前选中的目录在当前标签页打开 / 开新会话；按住 Ctrl 就丢新标签页 */
function openCurrent(e) {
  const p = current.value;
  if (!p) return;
  if (e?.ctrlKey || e?.metaKey) return newTab();
  if (mode.value === 'new') newSessionIn(p);
  else openDir(p);
  close();
}
/** 双击某个目录：选中它并直接打开 */
function openNow(p) {
  select(p);
  openCurrent();
}
function newTab() {
  if (!current.value) return;
  openInNewTab(current.value, { newSession: mode.value === 'new' });
  close();
}

// ---- 挂在窗口打开时刷新一下数据 ----
watch(
  () => S.dirPicker,
  async (v) => {
    if (!v) return;
    filter.value = '';
    error.value = '';
    recent.value = await http.get('/api/recent-dirs').catch(() => []);
    await reveal(S.cwd || S.info.home);
    nextTick(() => inputEl.value?.focus());
  },
);

function onKey(e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    close();
  }
}
</script>

<template>
  <div v-if="S.dirPicker" class="modal-mask" @mousedown.self="close" @keydown="onKey">
    <div class="modal dirs">
      <div class="modal-title">
        <Icon name="folder" :size="17" />
        {{ mode === 'new' ? '选个目录开新会话' : '切换工作目录' }}
      </div>

      <div class="modal-body">
        <div class="top">
          <input ref="inputEl" v-model="pathInput" class="input grow mono" placeholder="输入完整路径后回车" @keydown.enter="reveal(pathInput)" />
          <input v-if="viewMode === 'cols'" v-model="filter" class="input filter" placeholder="过滤目录" />
          <div class="seg">
            <button :class="{ on: viewMode === 'cols' }" title="多栏（像 Finder）" @click="viewMode = 'cols'">多栏</button>
            <button :class="{ on: viewMode === 'tree' }" title="树状" @click="viewMode = 'tree'">树状</button>
          </div>
        </div>
        <div v-if="error" class="err small">{{ error }}</div>

        <div class="main">
          <aside class="left">
            <div class="grp">运行中的 pi</div>
            <div v-for="a in S.agents" :key="a.id" class="item" :class="{ active: isCurrent(a.cwd) }" :title="a.cwd" @click="reveal(a.cwd)" @dblclick="openNow(a.cwd)">
              <span class="dot" :class="a.running ? 'busy' : 'on'" />
              <span class="grow path">{{ a.cwd }}</span>
            </div>
            <div v-if="!S.agents.length" class="dim pad">无</div>
            <div class="grp">最近使用</div>
            <div v-for="r in recent" :key="r.cwd" class="item" :class="{ active: isCurrent(r.cwd) }" :title="r.cwd" @click="reveal(r.cwd)" @dblclick="openNow(r.cwd)">
              <span class="grow path">{{ r.cwd }}</span>
              <span class="tiny dim">{{ relTime(r.modified) }}</span>
            </div>
          </aside>

          <div class="right">
            <!-- 多栏：最左边固定一列磁盘根目录（吸在左侧不跟着横滚），右边每进入一层多一栏 -->
            <div v-if="viewMode === 'cols'" ref="colsEl" class="cols">
              <div class="roots">
                <div v-for="r in roots" :key="r.path" class="row" :class="{ active: norm(current).startsWith(norm(r.path)) }" :title="r.path" @click="clickRoot(r)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="9" rx="1.6" /><path d="M6 8V5.5h4l2 2.5" /></svg>
                  <span class="ellipsis">{{ r.name }}</span>
                </div>
              </div>
              <div v-for="(c, i) in cols" :key="c.path" class="col">
                <div v-if="!filtered(c).length" class="pad dim tiny">没有子目录</div>
                <div
                  v-for="e in filtered(c)"
                  :key="e.name"
                  class="row"
                  :class="{ active: isCurrent(join(c.path, e.name)), dim: e.name.startsWith('.') }"
                  :title="join(c.path, e.name)"
                  @click="enter(i, e)"
                  @dblclick="openNow(join(c.path, e.name))"
                >
                  <Icon name="folder" :size="14" />
                  <span class="ellipsis">{{ e.name }}</span>
                </div>
              </div>
            </div>

            <!-- 树状 -->
            <div v-else class="tree">
              <DirTreeNode
                v-for="r in roots"
                :key="r.path"
                :entry="{ name: r.name, path: r.path, dir: true }"
                :depth="0"
                :selected="current"
                :auto="current"
                @pick="pickInTree"
                @open="openNow"
              />
            </div>
          </div>
        </div>
      </div>

      <div class="modal-foot foot">
        <span class="ellipsis mono tiny dim pick" :title="current">{{ current || '还没选目录' }}</span>
        <div class="grow" />
        <span class="tiny dim hint">Ctrl+点击 = 在新标签页</span>
        <button class="btn" @click="newTab">在新标签页{{ verb }}</button>
        <button class="btn primary" @click="openCurrent">{{ verb }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dirs { width: min(1080px, 96vw); max-width: none; height: min(720px, 84vh); max-height: 84vh; }
.dirs .modal-body { overflow: hidden; flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.top { display: flex; align-items: center; gap: 8px; flex: none; }
.filter { width: 160px; flex: none; font-size: var(--fs-sm); }
.seg { display: flex; gap: 2px; padding: 3px; background: var(--active); border-radius: 9px; flex: none; }
.seg button { height: 26px; padding: 0 12px; border: 0; border-radius: 7px; background: transparent; color: var(--text-2); font-size: var(--fs-sm); cursor: pointer; }
.seg button:hover { color: var(--text); }
.seg button.on { background: var(--panel); color: var(--text); font-weight: 600; box-shadow: var(--shadow-sm); }

.main { flex: 1; min-height: 0; display: flex; gap: 10px; }
.left { width: 268px; flex: none; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--panel-2); overflow-y: auto; padding: 4px 6px 10px; }
.grp { font-size: var(--fs-xs); color: var(--text-3); padding: 10px 8px 4px; }
.item { display: flex; align-items: center; gap: 8px; min-height: 30px; padding: 5px 8px; border-radius: 7px; cursor: pointer; }
.item:hover { background: var(--hover); }
.item.active { background: var(--accent-soft); }
.item.active .path { color: var(--accent-text); }
.item .dot { margin: 0 2px; }
/* 左边一律显示完整路径，太长就换行显示，不截断 */
.path { font-family: var(--font-code); font-size: var(--fs-xs); line-height: 1.35; white-space: normal; word-break: break-all; }
.tiny { font-size: var(--fs-xs); }
.pad { padding: 4px 10px; }
.small { font-size: var(--fs-sm); }

.right { flex: 1; min-width: 0; display: flex; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--panel); overflow: hidden; }
/* 左侧磁盘根目录：和右边每一栏长得一样（同样的卡片 / 内边距 / 圆角 / 行高），只是 sticky 吸在左边不跟着横滚 */
.cols { display: flex; gap: 6px; align-items: stretch; overflow-x: auto; overflow-y: hidden; min-width: 0; flex: 1; padding: 6px; }
.roots { width: 124px; flex: none; position: sticky; left: 0; z-index: 2; overflow-y: auto; padding: 4px; border: 1px solid var(--line-2); border-radius: var(--r-sm); background: var(--panel-2); box-shadow: 3px 0 8px -4px rgba(15, 23, 42, 0.16); }
.col { width: 218px; flex: none; overflow-y: auto; border: 1px solid var(--line-2); border-radius: var(--r-sm); padding: 4px; background: var(--panel-2); }
.row { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 6px; border-radius: 6px; cursor: pointer; font-size: var(--fs-sm); white-space: nowrap; user-select: none; }
.row:hover { background: var(--hover); }
.row.active { background: var(--accent-soft); color: var(--accent-text); font-weight: 600; }
.tree { flex: 1; overflow: auto; padding: 6px; }

.foot { align-items: center; gap: 8px; flex-wrap: wrap; }
.pick { max-width: 100%; min-width: 0; flex: 0 1 auto; }
.hint { white-space: nowrap; }

@media (max-width: 768px) {
  .dirs { width: 96vw; height: 86vh; }
  .main { flex-direction: column; }
  .left { width: auto; max-height: 30%; }
  .filter { display: none; }
  .hint { display: none; }
  .col { width: 70vw; }
}
</style>