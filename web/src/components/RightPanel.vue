<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { S, openSession, sessionStatus, isFav, toggleFavorite, killAgent } from '../store.js';
import { view, openMenu } from '../settings.js';
import TreeNode from './TreeNode.vue';
import GitChanges from './GitChanges.vue';
import { G } from '../git.js';
import { downloadPath, packing } from '../file-download.js';
import Icon from './Icon.vue';
import FloatingPanel from './FloatingPanel.vue';

const filesOpen = ref(true);
const sectionsEl = ref(null);
const splitKey = 'seed-pi-web-files-split';
const savedRatio = Number(localStorage.getItem(splitKey));
const splitRatio = ref(savedRatio > 0 && savedRatio < 1 ? savedRatio : 0.42);
const splitHeight = ref(0);
const resizing = ref(false);
const hasGit = computed(() => G.cwd === S.cwd && G.data?.available);
const canResize = computed(() => hasGit.value && filesOpen.value);
const splitStyle = computed(() => canResize.value ? { gridTemplateRows: `minmax(0, ${splitRatio.value}fr) 7px minmax(0, ${1 - splitRatio.value}fr)` } : null);
let resizeObserver, dragState;
function bounds() {
  const height = splitHeight.value || 400;
  return { min: Math.min(0.4, 72 / height), max: 1 - Math.min(0.4, 80 / height) };
}
function setRatio(value, save = false) {
  const { min, max } = bounds();
  splitRatio.value = Math.max(min, Math.min(max, value));
  if (save) localStorage.setItem(splitKey, String(splitRatio.value));
}
function startResize(e) {
  if (e.button !== 0 || !canResize.value) return;
  finishResize();
  const el = e.currentTarget;
  el.focus({ preventScroll: true });
  splitHeight.value = Math.max(1, sectionsEl.value.clientHeight - el.offsetHeight);
  dragState = { el, id: e.pointerId, y: e.clientY, ratio: splitRatio.value, cursor: document.body.style.cursor, select: document.body.style.userSelect };
  resizing.value = true;
  document.body.style.cursor = 'row-resize';
  document.body.style.userSelect = 'none';
  el.setPointerCapture(e.pointerId);
}
function moveResize(e) {
  if (!dragState || e.pointerId !== dragState.id) return;
  setRatio(dragState.ratio + (e.clientY - dragState.y) / splitHeight.value);
}
function finishResize() {
  if (!dragState) return;
  const state = dragState;
  dragState = null;
  resizing.value = false;
  document.body.style.cursor = state.cursor;
  document.body.style.userSelect = state.select;
  if (state.el.hasPointerCapture(state.id)) state.el.releasePointerCapture(state.id);
  localStorage.setItem(splitKey, String(splitRatio.value));
}
function resizeKey(e) {
  const { min, max } = bounds();
  const step = e.shiftKey ? 0.1 : 0.03;
  const value = e.key === 'ArrowUp' ? splitRatio.value - step : e.key === 'ArrowDown' ? splitRatio.value + step : e.key === 'Home' ? min : e.key === 'End' ? max : null;
  if (value === null) return;
  e.preventDefault();
  setRatio(value, true);
}
watch(sectionsEl, (el) => {
  resizeObserver?.disconnect();
  if (!el) return;
  resizeObserver = new ResizeObserver(([entry]) => {
    if (entry.contentRect.height && canResize.value) {
      splitHeight.value = Math.max(1, entry.contentRect.height - 7);
      setRatio(splitRatio.value);
    }
  });
  resizeObserver.observe(el);
});
watch(() => [view.panel, canResize.value], () => finishResize());

// 右边的浮动侧栏：文件树 / pi 进程。浮在对话上面，不挤占对话的宽度。
// 打开它的按钮在顶栏右边；点面板外面、按 Esc、再点一次按钮都会关掉。
const base = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const title = computed(() => (view.panel === 'files' ? '文件' : '进程'));
// 顶部有标签栏时往下让一点，别挡住标签栏右边的“关闭全部”
const hasTabs = computed(() => S.tabs.length > 0 || S.terms.length > 0);

// 文件面板顶上那行路径：右键能把当前工作目录收藏起来（树里根节点本身不画，所以给它留个入口）
function cwdMenu(e) {
  openMenu(e.clientX, e.clientY, [
    { label: isFav(S.cwd) ? '取消收藏这个目录' : '收藏这个目录', run: () => toggleFavorite(S.cwd) },
    { label: '复制路径', run: () => navigator.clipboard.writeText(S.cwd) },
    { label: '下载整个目录（ZIP）', run: () => downloadPath(S.cwd, true) },
  ]);
}
onMounted(() => {
  window.addEventListener('blur', finishResize);
});
onUnmounted(() => {
  finishResize();
  resizeObserver?.disconnect();
  window.removeEventListener('blur', finishResize);
});
</script>

<template>
  <FloatingPanel :open="!!view.panel" :low="hasTabs" :title="title" :icon="view.panel === 'files' ? 'folder' : 'cpu'" @close="view.panel = null">
      <template #badge><span v-if="view.panel === 'agents' && S.agents.length" class="cnt">{{ S.agents.length }}</span></template>
      <template #actions>
        <button v-if="view.panel === 'files'" class="ib" title="刷新文件和 Git 状态" @click="S.fsEpoch++"><Icon name="refresh" :size="15" /></button>
      </template>

      <!-- 两个面板都用 v-show 挂着：来回切换不用重新读目录 -->
      <div v-show="view.panel === 'files'" class="pane">
        <div class="sub ellipsis" :title="`${S.cwd}\n右键可以收藏这个目录`" @contextmenu.prevent.stop="cwdMenu($event)">{{ S.cwd }}</div>
        <div v-if="packing.size" class="sub packing">正在打包 {{ packing.size }} 个目录…</div>
        <div ref="sectionsEl" class="file-sections" :class="{ split: canResize, resizing }" :style="splitStyle">
          <GitChanges class="git-section" :class="{ expanded: hasGit }" />
          <div v-if="canResize" class="files-splitter" role="separator" tabindex="0" aria-label="调整更改和文件树的高度" aria-orientation="horizontal" :aria-valuemin="Math.round(bounds().min * 100)" :aria-valuemax="Math.round(bounds().max * 100)" :aria-valuenow="Math.round(splitRatio * 100)" title="上下拖动调整高度，双击恢复默认" @pointerdown.prevent="startResize" @pointermove="moveResize" @pointerup="finishResize" @pointercancel="finishResize" @lostpointercapture="finishResize" @keydown="resizeKey" @dblclick="setRatio(0.42, true)" />
          <div class="files-section" :class="{ collapsed: hasGit && !filesOpen }">
            <button v-if="hasGit" class="files-heading" :aria-expanded="filesOpen" @click="filesOpen = !filesOpen">{{ filesOpen ? '▾' : '▸' }} 文件</button>
            <div v-show="filesOpen || !hasGit" class="list tree">
              <TreeNode v-if="S.cwd" :key="S.cwd" :entry="{ name: base(S.cwd), path: S.cwd, dir: true }" :depth="0" root />
            </div>
          </div>
        </div>
      </div>

      <div v-show="view.panel === 'agents'" class="pane">
        <div class="sub">每个会话一个 pi 进程，切走后会在后台继续跑</div>
        <div class="list">
          <div v-if="!S.agents.length" class="empty">没有运行中的 pi</div>
          <div
            v-for="a in S.agents"
            :key="a.id"
            class="agent"
            :class="{ active: a.id === S.agentId }"
            :title="a.sessionFile || a.cwd"
            @click="a.sessionFile && openSession(a.sessionFile)"
          >
            <span class="dot" :class="a.running ? 'busy' : 'on'" />
            <span class="amain">
              <span class="ellipsis aname">{{ a.sessionName || (a.saved ? '未命名会话' : '新会话') }}</span>
              <span class="ellipsis apath">{{ a.cwd }}</span>
            </span>
            <span class="astate" :class="{ busy: a.running }">{{ a.waitingUi ? '等你操作' : a.running ? '运行中' : sessionStatus(a.sessionFile)?.unread ? '有新回复' : sessionStatus(a.sessionFile)?.elsewhere ? '别的窗口在用' : '空闲' }}</span>
            <button class="ib kill" title="强行关闭这个 pi 进程" @click.stop="killAgent(a)"><Icon name="power" :size="15" /></button>
          </div>
        </div>
      </div>
  </FloatingPanel>
</template>

<style scoped>
.cnt { font-size: 11px; background: var(--active); padding: 0 6px; border-radius: var(--r-pill); color: var(--text-2); }
.ib { width: 30px; height: 30px; border: 0; background: transparent; border-radius: var(--r-sm); color: var(--text-2); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.ib:hover { background: var(--active); color: var(--text); }
.pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.sub { font-size: var(--fs-xs); color: var(--text-3); padding: 8px 14px 4px; flex: none; }
.list { flex: 1; overflow-y: auto; padding: 2px 8px 12px; }
.file-sections { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.file-sections.split { display: grid; }
.git-section.expanded { flex: 1; }
.files-section { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
.files-section.collapsed { flex: none; }
.tree { padding: 2px 6px 12px; min-height: 0; }
.files-splitter { position: relative; cursor: row-resize; touch-action: none; outline: none; }
.files-splitter::after { content: ''; position: absolute; inset: 3px 0; background: var(--line); transition: background .12s; }
.files-splitter:hover::after, .files-splitter:focus-visible::after, .resizing .files-splitter::after { inset: 2px 0; background: var(--accent); }
.files-heading { flex: none; border: 0; background: transparent; color: var(--text-2); text-align: left; padding: 7px 14px 4px; font-size: var(--fs-xs); font-weight: 600; cursor: pointer; }
.packing { color: var(--accent-text); }
.empty { padding: 32px 12px; text-align: center; font-size: var(--fs-sm); color: var(--text-3); }

.agent { display: flex; align-items: center; gap: 8px; padding: 5px 8px 5px 6px; border-radius: var(--r-sm); cursor: pointer; }
.agent:hover { background: var(--active); }
.agent.active { background: var(--accent-softer); }
.agent.active .aname { font-weight: 600; color: var(--accent-text); }
.agent .dot { margin: 0 4px; flex: none; }
/* 左边两行：上面会话名称，下面这个进程的工作目录（太长就省略，悬停看完整路径） */
.amain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.aname { font-size: var(--fs-sm); line-height: 1.35; }
.apath { font-size: var(--fs-xs); color: var(--text-3); line-height: 1.3; }
.astate { flex: none; font-size: var(--fs-xs); color: var(--text-3); }
.astate.busy { color: var(--accent-text); }
/* 强行关闭：点了就直接关（会中断正在跑的回复） */
.kill { width: 26px; height: 26px; opacity: 0.5; }
.kill:hover { background: var(--err); color: #fff; opacity: 1; }

</style>
