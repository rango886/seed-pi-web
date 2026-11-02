<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { S, closeTab, closeAllTabs, pickSession, pickModel, stop, renameSession, newSession, sessionTitle, toggleTerminal, openTerminal, termTab, termIdOf } from './store.js';
import { view, toggleSide, openMenu, togglePanel, UI } from './settings.js';
import { mainMenu, contextExtras, openModelMenu } from './menus.js';
import SidePanel from './components/SidePanel.vue';
import RightPanel from './components/RightPanel.vue';
import ChatView from './components/ChatView.vue';
import FileViewer from './components/FileViewer.vue';
import TerminalPanel from './components/TerminalPanel.vue';
import Dialogs from './components/Dialogs.vue';
import Picker from './components/Picker.vue';
import DirPicker from './components/DirPicker.vue';
import Toasts from './components/Toasts.vue';
import Settings from './components/Settings.vue';
import ContextMenu from './components/ContextMenu.vue';
import Icon from './components/Icon.vue';

const sideW = ref(Number(localStorage.getItem('pi-web-side-w')) || 272);
const dragging = ref(false);

function drag(e) {
  const start = e.clientX;
  const init = sideW.value;
  dragging.value = true;
  const move = (ev) => (sideW.value = Math.max(220, Math.min(480, init + ev.clientX - start)));
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.style.cursor = '';
    dragging.value = false;
    localStorage.setItem('pi-web-side-w', sideW.value);
  };
  document.body.style.cursor = 'col-resize';
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

// 顶部标签页：对话 + 打开的文件 + 终端
const inTerm = computed(() => !!termIdOf(S.activeTab));
const hasTabs = computed(() => S.tabs.length > 0 || S.terms.length > 0);
function tabMenu(e, key) {
  openMenu(e.clientX, e.clientY, [
    { label: '关闭', run: () => closeTab(key) },
    { label: '关闭其他标签页', run: () => closeAllTabs(key) },
    { label: '关闭全部标签页', run: () => closeAllTabs() },
    ...(S.info.terminal ? ['-', { label: '新终端', run: () => openTerminal() }] : []),
  ]);
}

const sideOpen = computed(() => (view.mobile ? view.drawer : view.side));
const title = computed(() => sessionTitle());

// 页面窄的时候顶栏挤不下：把右边那一排按钮收进“⋯”里（菜单里本来就有这些项）
const topEl = ref(null);
const compact = ref(false);
let roTop;
onMounted(() => {
  roTop = new ResizeObserver(([e]) => (compact.value = e.contentRect.width < 560));
  if (topEl.value) roTop.observe(topEl.value);
});
onUnmounted(() => roTop?.disconnect());

// 右键菜单：输入框、终端里保留浏览器自己的菜单（方便粘贴）；按住 Shift 也是原生菜单
function onContext(e) {
  if (e.shiftKey || e.target.closest('textarea, input, .xterm, .ctxmenu')) return;
  e.preventDefault();
  openMenu(e.clientX, e.clientY, mainMenu(contextExtras(e.target)));
}
function moreMenu(e) {
  const r = e.currentTarget.getBoundingClientRect();
  // 菜单宽度随内容变，x 直接给按钮右边：ContextMenu 会拿实测宽度把它夹到窗口里，右边缘就和“⋯”对齐了
  openMenu(r.right, r.bottom + 6, mainMenu());
}

function onKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  const inTerm = !!e.target.closest?.('.xterm');
  if (mod && e.key === ',') {
    e.preventDefault();
    view.settingsOpen = !view.settingsOpen;
    return;
  }
  if (e.key === 'Escape') {
    if (view.menu) return e.preventDefault(), (view.menu = null);
    if (view.settingsOpen) return e.preventDefault(), (view.settingsOpen = false);
    if (view.drawer) return e.preventDefault(), (view.drawer = false);
    if (view.panel && !S.picker && !S.dialogs.length) return e.preventDefault(), (view.panel = null);
  }
  if (mod && e.key === '`') {
    e.preventDefault();
    if (S.info.terminal) toggleTerminal();
  } else if (inTerm) {
    return; // 其他快捷键留给终端自己用
  } else if (mod && e.key.toLowerCase() === 'e' && !e.shiftKey) {
    e.preventDefault();
    togglePanel('files');
  } else if (mod && e.key.toLowerCase() === 'p' && !e.shiftKey) {
    e.preventDefault();
    pickSession();
  } else if (mod && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    if (S.agentId && !S.agentExited) view.menu === 'model' ? (view.menu = null) : openModelMenu();
    else pickModel();
  } else if (mod && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    toggleSide();
  } else if (e.key === 'Escape' && !S.picker && !S.dialogs.length && !S.dirPicker && (S.running || S.bashLive)) {
    e.preventDefault();
    stop();
  }
}

// 窄屏：从屏幕左边缘往右滑打开侧栏，在侧栏上往左滑关闭
let touch = null;
function onTouchStart(e) {
  if (!view.mobile || e.touches.length !== 1) return;
  const t = e.touches[0];
  touch = { x: t.clientX, y: t.clientY, edge: t.clientX < 24, inSide: !!e.target.closest('.side-wrap') };
}
function onTouchEnd(e) {
  if (!touch) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touch.x;
  const dy = Math.abs(t.clientY - touch.y);
  if (dy < 60) {
    if (touch.edge && !view.drawer && dx > 60) view.drawer = true;
    else if (view.drawer && dx < -60) view.drawer = false;
  }
  touch = null;
}

onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="app" :class="{ mobile: view.mobile, dragging }" @contextmenu="onContext" @touchstart.passive="onTouchStart" @touchend.passive="onTouchEnd">
    <!-- 侧栏：宽屏是可收起的一栏，窄屏是从左边滑出来的抽屉 -->
    <div v-if="view.mobile" class="mask" :class="{ show: view.drawer }" @click="view.drawer = false" />
    <div class="side-wrap" :class="{ open: sideOpen }" :style="view.mobile ? null : { width: (view.side ? sideW : 0) + 'px' }">
      <SidePanel :style="view.mobile ? null : { width: sideW + 'px' }" />
    </div>
    <div v-if="!view.mobile && view.side" class="split-v" @mousedown.prevent="drag($event)" />

    <div class="center">
      <header ref="topEl" class="top">
        <template v-if="!sideOpen || view.mobile">
          <button class="ib" title="侧栏 (Ctrl+B)" @click="toggleSide(true)"><Icon name="sidebar" /></button>
          <button class="ib" title="新会话" @click="newSession"><Icon name="newchat" /></button>
        </template>
        <div class="ttl" :title="`${S.cwd}\n点击重命名`" @click="renameSession()">
          <div class="t1 ellipsis">{{ title }}</div>
        </div>
        <!-- 顶栏只留文件 / 终端 / ⋯；进程、状态信息都收在“⋯”菜单里 -->
        <template v-if="!compact">
          <button class="ib panel-btn" :class="{ on: view.panel === 'files' }" title="文件 (Ctrl+E)" @click="togglePanel('files')"><Icon name="folder" /></button>
          <button v-if="S.info.terminal" class="ib" :class="{ on: inTerm }" title="终端 (Ctrl+`)" @click="toggleTerminal"><Icon name="terminal" /></button>
        </template>
        <button class="ib" title="更多（也可以在页面上点右键）" @click.stop="moreMenu"><Icon name="more" /></button>
      </header>

      <div v-if="hasTabs" class="tabbar">
        <div class="tab" :class="{ active: S.activeTab === 'chat' }" @click="S.activeTab = 'chat'">
          <span v-if="S.running" class="spin" /><Icon v-else name="chat" :size="15" />对话
        </div>
        <div
          v-for="t in S.tabs"
          :key="t.path"
          class="tab"
          :class="{ active: S.activeTab === t.path }"
          :title="t.path"
          @click="S.activeTab = t.path"
          @mousedown.middle.prevent="closeTab(t.path)"
          @contextmenu.prevent.stop="tabMenu($event, t.path)"
        >
          <Icon name="file" :size="15" />
          <span class="ellipsis">{{ t.name }}</span>
          <span class="x" @click.stop="closeTab(t.path)">✕</span>
        </div>
        <div
          v-for="t in S.terms"
          :key="t.id"
          class="tab"
          :class="{ active: S.activeTab === termTab(t.id) }"
          :title="t.cwd"
          @click="S.activeTab = termTab(t.id)"
          @mousedown.middle.prevent="closeTab(termTab(t.id))"
          @contextmenu.prevent.stop="tabMenu($event, termTab(t.id))"
        >
          <Icon name="terminal" :size="15" />
          <span class="ellipsis">{{ t.title }}</span>
          <span class="x" @click.stop="closeTab(termTab(t.id))">✕</span>
        </div>
        <div v-if="S.info.terminal" class="tab add" title="在当前目录开新终端" @click="openTerminal()"><Icon name="plus" :size="15" /></div>
        <div class="grow" />
        <button class="ib sm" title="关闭全部标签页" @click="closeAllTabs()"><Icon name="closeall" :size="16" /></button>
      </div>

      <ChatView v-show="S.activeTab === 'chat'" />
      <!-- 文件标签页也一直挂着，来回切不用重新高亮 -->
      <FileViewer v-for="t in S.tabs" v-show="S.activeTab === t.path" :key="t.path" :tab="t" />
      <!-- 终端一直挂着（隐藏不销毁），切标签不会丢内容 -->
      <TerminalPanel v-if="S.info.terminal" v-show="inTerm" />
      <RightPanel />
    </div>

    <Dialogs />
    <Picker />
    <DirPicker />
    <Toasts />
    <Settings />
    <ContextMenu />
  </div>
</template>

<style scoped>
.app { height: 100%; display: flex; min-height: 0; }
.center { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--chat-bg); position: relative; }

/* 侧栏 */
.side-wrap { flex: none; overflow: hidden; display: flex; transition: width 0.22s ease; border-right: 1px solid var(--line); }
.side-wrap:not(.open) { border-right: 0; }
.side-wrap > * { flex: none; height: 100%; }
.dragging .side-wrap { transition: none; }
.split-v { width: 5px; margin-left: -3px; cursor: col-resize; flex: none; position: relative; z-index: 5; }
.split-v:hover { background: color-mix(in srgb, var(--accent) 40%, transparent); }
.mobile .side-wrap { position: fixed; z-index: 45; top: 0; bottom: 0; left: 0; width: min(304px, 86vw); transform: translateX(-100%); transition: transform 0.25s ease; border-right: 0; box-shadow: var(--shadow-lg); }
.mobile .side-wrap > * { width: 100%; }
.mobile .side-wrap.open { transform: none; }
.mobile .side-wrap:not(.open) { box-shadow: none; }
.mask { position: fixed; inset: 0; z-index: 44; background: rgba(15, 23, 42, 0.35); opacity: 0; pointer-events: none; transition: opacity 0.25s; }
.mask.show { opacity: 1; pointer-events: auto; }

/* 顶部标题栏 */
.top { height: 52px; flex: none; display: flex; align-items: center; gap: 2px; padding: 0 8px 0 10px; border-bottom: 1px solid var(--line); background: var(--chat-bg); }
.ttl { flex: 1; min-width: 0; text-align: center; cursor: pointer; padding: 0 8px; }
.t1 { font-weight: 600; line-height: 1.3; }
.ib { width: 36px; height: 36px; border: 0; background: transparent; border-radius: var(--r-sm); color: var(--text-2); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.ib:hover { background: var(--active); color: var(--text); }
.ib.on { color: var(--accent-text); background: var(--accent-soft); }
.ib:disabled { opacity: 0.4; pointer-events: none; }
.ib.sm { width: 28px; height: 28px; border-radius: var(--r-sm); }

.tabbar { background: var(--chat-bg); padding: 6px 10px; }
.tab { height: 28px; font-size: var(--fs-sm); }
.tab.add { padding: 0 8px; color: var(--text-3); }
</style>
