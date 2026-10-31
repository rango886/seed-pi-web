<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick, markRaw } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { S, termListeners, termInput, termResize, termAttach, termClose, openTerminal } from '../store.js';
import { UI, view } from '../settings.js';

const host = ref(null);
const inst = new Map(); // id -> { term, fit, el, attached }

const LIGHT = {
  background: '#ffffff',
  foreground: '#1f2329',
  cursor: '#3b82f6',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(59,130,246,0.25)',
  black: '#000000', red: '#c91b00', green: '#00a600', yellow: '#a68a00', blue: '#0b55c4', magenta: '#a626a4', cyan: '#0184bc', white: '#a0a0a0',
  brightBlack: '#666666', brightRed: '#e45649', brightGreen: '#2e9e44', brightYellow: '#c18401', brightBlue: '#4296fa', brightMagenta: '#c050c0', brightCyan: '#26a6c6', brightWhite: '#d0d0d0',
};
const DARK = {
  background: '#16171a',
  foreground: '#e4e6eb',
  cursor: '#60a5fa',
  cursorAccent: '#16171a',
  selectionBackground: 'rgba(96,165,250,0.3)',
  black: '#1e1e1e', red: '#f87171', green: '#4ade80', yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#d4d4d4',
  brightBlack: '#6b7280', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde047', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#ffffff',
};
const theme = () => ({ ...(view.dark ? DARK : LIGHT), cursor: UI.accent });
const font = () => getComputedStyle(document.documentElement).getPropertyValue('--font-code');
watch(
  () => [view.dark, UI.accent, UI.codeFont, UI.codeFontSize],
  () =>
    nextTick(() => {
      for (const x of inst.values()) {
        x.term.options.theme = theme();
        x.term.options.fontFamily = font();
        x.term.options.fontSize = UI.codeFontSize;
      }
      fitActive();
    }),
);
async function attach(id) {
  const x = inst.get(id);
  if (!x) return;
  x.attached = false;
  try {
    const { buffer } = await termAttach(id);
    x.term.reset();
    x.term.write(buffer);
    x.attached = true;
  } catch {}
}

function create(id) {
  const el = document.createElement('div');
  el.className = 'term-host';
  host.value.appendChild(el);
  const term = new Terminal({
    fontFamily: font(),
    fontSize: UI.codeFontSize,
    theme: theme(),
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  const x = markRaw({ term, fit, el, attached: false });
  inst.set(id, x);
  term.onData((d) => termInput(id, d));
  term.onResize(({ cols, rows }) => termResize(id, cols, rows));
  termListeners.set(id, (msg) => {
    if (msg.t === 'term_data' && x.attached) term.write(msg.data);
    if (msg.t === 'term_exit') term.write('\r\n\x1b[90m[进程已退出]\x1b[0m\r\n');
  });
  attach(id);
}

function sync() {
  const ids = new Set(S.terms.map((t) => t.id));
  for (const t of S.terms) if (!inst.has(t.id)) create(t.id);
  for (const [id, x] of inst) {
    if (!ids.has(id)) {
      x.term.dispose();
      x.el.remove();
      inst.delete(id);
      termListeners.delete(id);
    }
  }
  if (!S.activeTerm || !ids.has(S.activeTerm)) S.activeTerm = S.terms[0]?.id || null;
  show();
}

function show() {
  for (const [id, x] of inst) x.el.style.display = id === S.activeTerm ? 'block' : 'none';
  nextTick(fitActive);
}
function fitActive() {
  const x = inst.get(S.activeTerm);
  if (!x || !host.value?.offsetHeight) return;
  try {
    x.fit.fit();
    termResize(S.activeTerm, x.term.cols, x.term.rows);
  } catch {}
}

let ro;
onMounted(() => {
  sync();
  if (!S.terms.length && S.info.terminal) openTerminal();
  ro = new ResizeObserver(() => fitActive());
  ro.observe(host.value);
});
onUnmounted(() => ro?.disconnect());
watch(() => S.terms, sync, { deep: true });
watch(
  () => S.activeTerm,
  () => {
    show();
    nextTick(() => inst.get(S.activeTerm)?.term.focus());
  },
);
watch(
  () => S.showTerm,
  (v) => {
    if (!v) return;
    if (!S.terms.length && S.info.terminal) openTerminal();
    nextTick(() => {
      fitActive();
      inst.get(S.activeTerm)?.term.focus();
    });
  },
);
// 断线重连后重新挂上终端，补回错过的输出
watch(
  () => S.connEpoch,
  () => inst.forEach((_, id) => attach(id)),
);
</script>

<template>
  <div class="win termwin">
    <div class="tabbar">
      <div v-for="t in S.terms" :key="t.id" class="tab" :class="{ active: t.id === S.activeTerm }" :title="t.cwd" @click="S.activeTerm = t.id">
        <span class="ellipsis">{{ t.title }}</span>
        <span class="x" @click.stop="termClose(t.id)">×</span>
      </div>
      <div class="tab" title="在当前目录开新终端" @click="openTerminal()">＋</div>
      <div class="grow" />
      <div class="tab" title="隐藏终端（Ctrl+`）" @click="S.showTerm = false">▾</div>
    </div>
    <div ref="host" class="hosts">
      <div v-if="!S.info.terminal" class="dim pad">后端没有可用的 node-pty，终端不可用。</div>
      <div v-else-if="!S.terms.length" class="dim pad">没有终端。<a href="#" @click.prevent="openTerminal()">新建一个</a></div>
    </div>
  </div>
</template>

<style scoped>
.termwin { flex: none; }
.termwin .tabbar { padding: 6px 10px; }
.termwin .tab { height: 26px; font-size: var(--fs-sm); }
.hosts { flex: 1; min-height: 0; position: relative; background: var(--term-bg); }
.hosts :deep(.term-host) { position: absolute; inset: 6px 4px 4px 12px; }
.pad { padding: 12px; }
</style>