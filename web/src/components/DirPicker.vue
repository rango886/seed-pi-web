// 选目录的窗口：左边是最近用过的目录，右边上面是地址栏、下面是目录树
// 地址栏里输入还不存在的路径，回车就直接建出来；打字过程中树会跟着展开，
// 并且会把“最近使用”里能接下去的路径灰着提示在后面（Tab / → 接受）
// 选好以后要么在当前标签页打开 / 开新会话，要么丢到新标签页去（Ctrl+点击也行）
<script setup>
import { ref, computed, watch, nextTick } from 'vue';
import { S, openDir, newSessionIn, chooseDirectory, openInNewTab, toast, isFav, toggleFavorite, moveFavorite } from '../store.js';
import { openMenu } from '../settings.js';
import { http } from '../api.js';
import { relTime } from '../util.js';
import Icon from './Icon.vue';
import DirTreeNode from './DirTreeNode.vue';

const mode = computed(() => S.dirPickerMode || 'switch');
const norm = (p) => (p || '').replace(/[\\/]+$/, '').toLowerCase();
const same = (a, b) => !!a && !!b && norm(a) === norm(b);
// 地址栏里的目录末尾自动带上分隔符：接着打新目录名回车就能建，不用自己补 \
const withSep = (p) => (!p || /[\\/]$/.test(p) ? p : p + (p.includes('\\') ? '\\' : '/'));

const roots = ref([]);
const current = ref(''); // 选中的目录（完整路径）
const rowAt = ref(''); // 左栏里刚点的那一行（'fav:<路径>' / 'recent:<路径>'），用来决定高亮哪一个
const pathInput = ref('');
const error = ref('');
const recent = ref([]);
const inputEl = ref(null);
const ghostEl = ref(null);
// 右键菜单发下去的命令：{ mode: 'expand' | 'collapse', target: 节点路径（空 = 整棵树） }
const cmd = ref(null);
// 新建目录以后 +1：已经展开着的节点重新读一遍子目录，新目录才会出现在树里
const ver = ref(0);

function select(p, row = '') {
  current.value = p;
  pathInput.value = withSep(p);
  cmd.value = null; // 手选了新目标：之前“展开所有”的惯性到此为止，别让它继续往新分支上滑
  rowAt.value = row; // 左栏里哪一行是你刚点的（没点左栏就是空，一个都不亮）
}
const pickInTree = (p) => select(p);
// 左边两个列表的行各自的 id：同一个目录既收藏了又在最近用过是常事，光看路径会两行同时亮
const rowFav = (p) => 'fav:' + norm(p);
const rowRecent = (p) => 'recent:' + norm(p);

/** 把树展开到 p 并选中它（p 得是已经存在的目录）。row：从左栏的哪一行点进来的 */
async function reveal(p, row = '') {
  if (!p) return;
  try {
    if (!roots.value.length) roots.value = await http.get('/api/fs/roots');
    if (!roots.value.some((r) => norm(p).startsWith(norm(r.path)))) throw new Error(`找不到 ${p} 所在的磁盘`);
    select(p, row);
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
}

/** 这个路径是不是一个存在的目录（后端的 stat 很便宜，打字时也能一直问） */
async function dirOf(p) {
  try {
    const r = await http.get('/api/fs/stat', { path: p });
    return r.exists && r.dir ? r.path : '';
  } catch {
    return '';
  }
}

/** 地址栏回车：目录在就进去；不在就直接建出来（父目录一起建）再进去 */
async function go() {
  const p = pathInput.value.trim();
  if (!p) return;
  const dir = await dirOf(p);
  if (dir) return reveal(dir);
  try {
    const r = await http.post('/api/fs/mkdir', { path: p });
    ver.value++; // 已经展开着的父目录重新读一遍，新目录才会出现在树里
    await reveal(r.path);
    if (r.created) toast(`已新建目录 ${r.path}`);
  } catch (e) {
    error.value = e.message;
  }
}

// 打字过程中同步树：输入到一半、又刚好是个存在的目录，就先把树展开过去（不存在的等回车再说）
let syncTimer = 0;
watch(pathInput, (v) => {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    const p = (v || '').trim();
    if (!p || same(p, current.value)) return;
    const dir = await dirOf(p);
    if (dir && !same(dir, current.value)) reveal(dir);
  }, 260);
});

// 灰色补全：从“最近使用”里找一条以当前输入开头的路径，把剩下的部分灰着显示在后面
const ghost = computed(() => {
  const v = pathInput.value;
  // 框里的内容和选中的目录正好一样（刚点了最近使用、或者刚同步过去）：不用提示
  if (!v || same(v, current.value)) return '';
  const n = norm(v);
  // 用原样（只忽略大小写）比前缀：末尾带不带 \ 影响接下来要补的内容，也能避免“code\”匹配到“codex”
  const low = v.toLowerCase();
  const hit = recent.value
    .map((r) => r.cwd)
    .filter((p) => p && norm(p) !== n && p.toLowerCase().startsWith(low))
    .sort((a, b) => a.length - b.length)[0];
  return hit ? hit.slice(v.length) : '';
});
function acceptGhost() {
  if (!ghost.value) return false;
  pathInput.value += ghost.value;
  return true;
}
// 路径很长时输入框内部会横向滚动，灰字得跟着滚，不然就对不上了
function syncGhostScroll() {
  if (inputEl.value && ghostEl.value) ghostEl.value.scrollLeft = inputEl.value.scrollLeft;
}
watch(pathInput, () => nextTick(syncGhostScroll));
function onPathKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    return go();
  }
  const atEnd = inputEl.value?.selectionStart === pathInput.value.length;
  if (atEnd && (e.key === 'Tab' || e.key === 'ArrowRight') && acceptGhost()) e.preventDefault();
}

/** 树上的右键：收藏 / 展开 / 折叠；“展开所有”这种就是整棵树 */
function treeMenu(e, path) {
  const all = !path;
  openMenu(e.clientX, e.clientY, [
    ...(all ? [] : [{ label: isFav(path) ? '取消收藏这个文件夹' : '收藏这个文件夹', run: () => toggleFavorite(path) }]),
    { label: all ? '全部展开' : '展开所有子目录', run: () => (cmd.value = { mode: 'expand', target: path }) },
    { label: all ? '全部折叠' : '折叠所有子目录', run: () => (cmd.value = { mode: 'collapse', target: path }) },
  ]);
}
/** 左边收藏列表里的右键：只是取消收藏 */
function favMenu(e, p) {
  openMenu(e.clientX, e.clientY, [{ label: '取消收藏', run: () => toggleFavorite(p) }]);
}

// ---- 拖动收藏调整顺序 ----
// dragFav 是正被拖动的那一条；dropOn = { key: 落点那一行的归一化路径, after: 插在它下面还是上面 }
// 不在行间来回挪动，只在落点那一行的上边 / 下边画一条线，看着稳当
const dragFav = ref('');
const dropOn = ref(null);
const favCls = (p) => ({
  active: rowAt.value === rowFav(p),
  dragging: dragFav.value === p,
  'drop-before': dropOn.value?.key === norm(p) && !dropOn.value.after,
  'drop-after': dropOn.value?.key === norm(p) && dropOn.value.after,
});

function endFavDrag() {
  dragFav.value = '';
  dropOn.value = null;
}
function onFavDragStart(e, p) {
  dragFav.value = p;
  dropOn.value = null;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', p); // Firefox 不设这个不会真拖起来
}
function onFavDragOver(e, p) {
  if (!dragFav.value) return; // 从外面拖文件进来不归这里管
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (norm(p) === norm(dragFav.value)) {
    dropOn.value = null; // 拖到自己身上：不提示落点，松手也不动
    return;
  }
  const r = e.currentTarget.getBoundingClientRect();
  dropOn.value = { key: norm(p), after: e.clientY > r.top + r.height / 2 };
}
function onFavDragLeave(p) {
  if (dropOn.value?.key === norm(p)) dropOn.value = null;
}
function onFavDrop(e) {
  if (!dragFav.value) return;
  e.preventDefault();
  const from = dragFav.value;
  const d = dropOn.value;
  endFavDrag();
  if (d) moveFavorite(from, d.key, d.after);
}

// ---- 清空最近使用：不删会话，只是以后的列表里不再显示现在这些 ----
async function clearRecent() {
  try {
    await http.del('/api/recent-dirs');
    recent.value = [];
    if (rowAt.value.startsWith('recent:')) rowAt.value = '';
    toast('已清空最近使用', 'success', 1500);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---- 左栏宽度：拖中间的分隔条调，双击恢复默认 ----
const LEFT_KEY = 'seed-pi-web-dirpicker-left';
const LEFT_DEFAULT = 268;
const leftW = ref(Number(localStorage.getItem(LEFT_KEY)) || LEFT_DEFAULT);
const mainEl = ref(null);
const resizing = ref(false);
function clampLeft(w) {
  const max = Math.max(200, (mainEl.value?.clientWidth || 900) - 320); // 右边至少留 320px 给目录树
  return Math.round(Math.max(180, Math.min(max, w)));
}
function startLeftResize(e) {
  const start = e.clientX;
  const init = leftW.value;
  resizing.value = true;
  const move = (ev) => (leftW.value = clampLeft(init + ev.clientX - start));
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    document.body.style.cursor = '';
    resizing.value = false;
    localStorage.setItem(LEFT_KEY, leftW.value);
  };
  document.body.style.cursor = 'col-resize';
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
function resetLeft() {
  leftW.value = LEFT_DEFAULT;
  localStorage.removeItem(LEFT_KEY);
}

// ---- 打开 / 新建 ----
function close() {
  S.dirPicker = false;
}

/** 主操作：当前选中的目录在当前标签页打开 / 开新会话；按住 Ctrl 就丢新标签页 */
function openCurrent(e) {
  const p = current.value;
  if (!p) return;
  if (e?.ctrlKey || e?.metaKey) return newTab();
  if (mode.value === 'new') newSessionIn(p);
  else if (mode.value === 'compose') chooseDirectory(p);
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
  openInNewTab(current.value, { newSession: mode.value !== 'switch' });
  close();
}

// ---- 挂在窗口打开时刷新一下数据 ----
watch(
  () => S.dirPicker,
  async (v) => {
    if (!v) return;
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
        {{ mode === 'new' ? '选个目录开新会话' : mode === 'compose' ? '选择工作目录' : '切换工作目录' }}
      </div>

      <div class="modal-body">
        <div ref="mainEl" class="main" :class="{ resizing }">
          <aside class="left" :style="{ width: leftW + 'px' }">
            <div class="grp fav">收藏</div>
            <div
              v-for="p in S.favorites"
              :key="p"
              class="item fav-item"
              :class="favCls(p)"
              :title="`${p}\n拖动可以调整顺序`"
              draggable="true"
              @click="reveal(p, rowFav(p))"
              @dblclick="openNow(p)"
              @contextmenu.prevent.stop="favMenu($event, p)"
              @dragstart="onFavDragStart($event, p)"
              @dragover="onFavDragOver($event, p)"
              @dragleave="onFavDragLeave(p)"
              @drop="onFavDrop"
              @dragend="endFavDrag"
            >
              <Icon name="folder" :size="15" />
              <span class="grow path">{{ p }}</span>
              <button class="favdel" title="取消收藏" draggable="false" @click.stop="toggleFavorite(p)"><Icon name="close" :size="12" /></button>
            </div>
            <div v-if="!S.favorites.length" class="dim pad">在右边的树里右键文件夹就能收藏</div>

            <div class="grp recent-head">
              <span class="grow">最近使用</span>
              <button v-if="recent.length" class="clear" title="清空最近使用（不会删除会话，以后用到的目录会重新出现）" @click="clearRecent">清空</button>
            </div>
            <div v-for="r in recent" :key="r.cwd" class="item" :class="{ active: rowAt === rowRecent(r.cwd) }" :title="r.cwd" @click="reveal(r.cwd, rowRecent(r.cwd))" @dblclick="openNow(r.cwd)">
              <Icon name="folder" :size="15" />
              <span class="grow path">{{ r.cwd }}</span>
              <span class="tiny dim">{{ relTime(r.modified) }}</span>
            </div>
            <div v-if="!recent.length" class="dim pad">无</div>
          </aside>
          <div class="split" role="separator" aria-orientation="vertical" title="拖动调整宽度，双击恢复" @pointerdown.prevent="startLeftResize" @dblclick="resetLeft" />

          <section class="right">
            <div class="top">
              <div class="pathbox">
                <input ref="inputEl" v-model="pathInput" class="input path-input mono" placeholder="输入路径回车进入；不存在的会直接建出来" @keydown="onPathKey" @scroll="syncGhostScroll" />
                <div v-if="ghost" ref="ghostEl" class="ghost" aria-hidden="true"><span class="ghost-typed">{{ pathInput }}</span><span class="ghost-rest">{{ ghost }}</span></div>
              </div>
              <button class="btn primary" :disabled="!current" :title="mode === 'switch' ? '在当前标签打开所选目录' : '在所选目录创建会话'" @click="openCurrent">创建</button>
              <button class="btn" :disabled="!current" title="在新标签中使用所选目录" @click="newTab">新标签</button>
            </div>
            <div v-if="error" class="err small">{{ error }}</div>

            <div class="tree" @contextmenu.prevent.stop="treeMenu($event, '')">
              <DirTreeNode
                v-for="r in roots"
                :key="r.path"
                :entry="{ name: r.name, path: r.path, dir: true }"
                :depth="0"
                :selected="current"
                :auto="current"
                :cmd="cmd"
                :ver="ver"
                @pick="pickInTree"
                @open="openNow"
                @menu="treeMenu"
              />
            </div>
          </section>
        </div>
      </div>

    </div>
  </div>
</template>

<style scoped>
.dirs { width: min(1080px, 96vw); max-width: none; height: min(720px, 84vh); max-height: 84vh; }
.dirs .modal-body { overflow: hidden; flex: 1; min-height: 0; display: flex; flex-direction: column; }

.main { flex: 1; min-height: 0; display: flex; }
.main.resizing { user-select: none; }
.left { width: 268px; flex: none; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--panel-2); overflow-y: auto; padding: 4px 6px 10px; }
/* 左右两栏中间的 10px 间隙就是拖动条，悬停 / 拖动时中间亮一条细线 */
.split { flex: none; width: 10px; cursor: col-resize; position: relative; touch-action: none; }
.split::after { content: ''; position: absolute; top: 8px; bottom: 8px; left: 4px; width: 2px; border-radius: 1px; background: var(--accent); opacity: 0; transition: opacity 0.15s; }
.split:hover::after, .resizing .split::after { opacity: 1; }
.grp { font-size: var(--fs-xs); color: var(--text-3); padding: 10px 8px 4px; }
.recent-head { display: flex; align-items: center; }
.clear { border: 0; background: transparent; padding: 2px 8px; border-radius: var(--r-sm); font-size: var(--fs-xs); line-height: 1.5; color: var(--text-3); cursor: pointer; opacity: 0; transition: opacity 0.12s, background 0.12s, color 0.12s; }
/* 平时不占眼力，鼠标移到“最近使用”这一行（或键盘聚焦到它）才淡出来；位置一直留着，不会跳 */
.recent-head:hover .clear, .clear:focus-visible { opacity: 1; }
.clear:hover { color: var(--err); background: var(--hover); }
/* “收藏”这个小标题比“最近使用”亮一档，一眼能看出这块是自己整理的 */
.grp.fav { color: var(--text-2); }
.item { display: flex; align-items: center; gap: 8px; min-height: 30px; padding: 5px 8px; border-radius: var(--r-sm); cursor: pointer; }
.item:hover { background: var(--hover); }
.item.active { background: var(--accent-soft); }
.item.active .path { color: var(--accent-text); }
/* 取消收藏：平时不占眼力，悬停才淡出来；位置留着，免得鼠标一上去就跳 */
.favdel { flex: none; width: 18px; height: 18px; padding: 0; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text-3); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.12s, background 0.12s, color 0.12s; }
.item:hover .favdel { opacity: 1; }
.favdel:hover { background: var(--err); color: #fff; }
/* 收藏行可以直接拖着换位置：抓起来时整行淡下去，落点在哪行的上/下边就画一条线 */
/* 鼠标形状不动，还是原来的手型指针 */
.fav-item { position: relative; }
.fav-item.dragging { opacity: 0.4; }
.fav-item.drop-before::before, .fav-item.drop-after::after { content: ''; position: absolute; left: 4px; right: 4px; height: 2px; background: var(--accent); border-radius: 1px; pointer-events: none; }
.fav-item.drop-before::before { top: -1px; }
.fav-item.drop-after::after { bottom: -1px; }
/* 左边一律显示完整路径，太长就换行显示，不截断 */
.path { font-family: var(--font-code); font-size: var(--fs-xs); line-height: 1.35; white-space: normal; word-break: break-all; }
.tiny { font-size: var(--fs-xs); }
.pad { padding: 4px 10px; font-size: var(--fs-xs); line-height: 1.6; }
.small { font-size: var(--fs-sm); }

.right { flex: 1; min-width: 0; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--panel); overflow: hidden; }
.top { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid var(--line); }
.top > .btn { flex: none; }
.pathbox { position: relative; flex: 1; min-width: 0; }
.path-input { width: 100%; }
/* 灰色补全：和输入框同样的字体和内边距叠在它上面（1px 边框也算上），已经打出来的部分留空，剩下的灰字就接在光标后面 */
.ghost { position: absolute; inset: 0; display: flex; align-items: center; padding: 0 11px; font-family: var(--font-code); white-space: pre; overflow: hidden; pointer-events: none; color: var(--text-3); }
.ghost-typed { visibility: hidden; }
.err { padding: 0 8px 6px; color: var(--err); }
.tree { flex: 1; min-height: 0; overflow: auto; padding: 6px; }

@media (max-width: 768px) {
  .dirs { width: 96vw; height: 86vh; }
  .main { flex-direction: column; gap: 10px; }
  .left { width: auto !important; flex: none; max-height: 30%; }
  .split { display: none; }
}
</style>