<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { S, closeTab, pickSession, pickModel, stop, renameSession, newSession, sessionTitle } from './store.js';
import { view, toggleSide, openMenu } from './settings.js';
import { mainMenu, contextExtras, openModelMenu } from './menus.js';
import SidePanel from './components/SidePanel.vue';
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
const termH = ref(Number(localStorage.getItem('pi-web-term-h')) || 260);
const dragging = ref(false);
// 终端第一次打开后就一直挂着（隐藏不销毁），这样切换显示不会丢内容
const termEver = ref(false);
watch(
  () => S.showTerm,
  (v) => v && (termEver.value = true),
  { immediate: true },
);

function drag(e, kind) {
  const start = kind === 'side' ? e.clientX : e.clientY;
  const init = kind === 'side' ? sideW.value : termH.value;
  dragging.value = true;
  const move = (ev) => {
    if (kind === 'side') sideW.value = Math.max(220, Math.min(480, init + ev.clientX - start));
    else termH.value = Math.max(100, Math.min(window.innerHeight - 200, init - (ev.clientY - start)));
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.style.cursor = '';
    dragging.value = false;
    localStorage.setItem('pi-web-side-w', sideW.value);
    localStorage.setItem('pi-web-term-h', termH.value);
  };
  document.body.style.cursor = kind === 'side' ? 'col-resize' : 'row-resize';
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

const sideOpen = computed(() => (view.mobile ? view.drawer : view.side));
const title = computed(() => sessionTitle());
const subtitle = computed(() => {
  const dir = (S.cwd || '').split(/[\\/]/).filter(Boolean).pop() || S.cwd;
  const m = S.state?.model;
  return [dir, m ? m.name || m.id : ''].filter(Boolean).join(' · ');
});

// 右键菜单：输入框、终端里保留浏览器自己的菜单（方便粘贴）；按住 Shift 也是原生菜单
function onContext(e) {
  if (e.shiftKey || e.target.closest('textarea, input, .xterm, .ctxmenu')) return;
  e.preventDefault();
  openMenu(e.clientX, e.clientY, mainMenu(contextExtras(e.target)));
}
function moreMenu(e) {
  const r = e.currentTarget.getBoundingClientRect();
  openMenu(r.right - 260, r.bottom + 6, mainMenu());
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
  }
  if (mod && e.key === '`') {
    e.preventDefault();
    S.showTerm = !S.showTerm;
  } else if (inTerm) {
    return; // 其他快捷键留给终端自己用
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
    <div v-if="!view.mobile && view.side" class="split-v" @mousedown.prevent="drag($event, 'side')" />

    <div class="center">
      <header class="top">
        <template v-if="!sideOpen || view.mobile">
          <button class="ib" title="侧栏 (Ctrl+B)" @click="toggleSide(true)"><Icon name="sidebar" /></button>
          <button class="ib" title="新会话" :disabled="S.running" @click="newSession"><Icon name="newchat" /></button>
        </template>
        <div class="ttl" title="点击重命名" @click="renameSession()">
          <div class="t1 ellipsis">{{ title }}</div>
          <div class="t2 ellipsis">{{ subtitle }}</div>
        </div>
        <button v-if="S.info.terminal" class="ib" :class="{ on: S.showTerm }" title="终端 (Ctrl+`)" @click="S.showTerm = !S.showTerm"><Icon name="terminal" /></button>
        <button class="ib" title="更多（也可以在页面上点右键）" @click.stop="moreMenu"><Icon name="more" /></button>
      </header>

      <div v-if="S.tabs.length" class="tabbar">
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
        >
          <Icon name="file" :size="15" />
          <span class="ellipsis">{{ t.name }}</span>
          <span class="x" @click.stop="closeTab(t.path)">✕</span>
        </div>
      </div>

      <ChatView v-show="S.activeTab === 'chat'" />
      <!-- 文件标签页也一直挂着，来回切不用重新高亮 -->
      <FileViewer v-for="t in S.tabs" v-show="S.activeTab === t.path" :key="t.path" :tab="t" />

      <template v-if="termEver">
        <div v-show="S.showTerm" class="split-h" @mousedown.prevent="drag($event, 'term')" />
        <TerminalPanel v-show="S.showTerm" :style="{ height: termH + 'px' }" />
      </template>
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
.center { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--chat-bg); }

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
.t2 { font-size: 11px; color: var(--text-3); line-height: 1.4; }
.ib { width: 36px; height: 36px; border: 0; background: transparent; border-radius: 9px; color: var(--text-2); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.ib:hover { background: var(--active); color: var(--text); }
.ib.on { color: var(--accent-text); background: var(--accent-soft); }
.ib:disabled { opacity: 0.4; pointer-events: none; }

.tabbar { background: var(--chat-bg); padding: 6px 10px; }
.tab { height: 28px; font-size: var(--fs-sm); }
.split-h { height: 5px; margin-top: -2px; cursor: row-resize; flex: none; border-top: 1px solid var(--line); }
.split-h:hover { background: color-mix(in srgb, var(--accent) 40%, transparent); }
</style>
