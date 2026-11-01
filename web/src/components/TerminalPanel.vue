<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick, markRaw } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { S, termListeners, termInput, termResize, termAttach, termIdOf } from '../store.js';
import { UI, view } from '../settings.js';

// 终端显示成顶部的标签页：这个组件一直挂着，只显示当前标签对应的那个终端
const activeId = computed(() => termIdOf(S.activeTab));

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
  for (const [id, x] of inst) x.el.style.display = id === activeId.value ? 'block' : 'none';
  nextTick(fitActive);
}
function fitActive() {
  const id = activeId.value;
  const x = inst.get(id);
  if (!x || !host.value?.offsetHeight) return;
  try {
    x.fit.fit();
    termResize(id, x.term.cols, x.term.rows);
  } catch {}
}

let ro;
onMounted(() => {
  sync();
  ro = new ResizeObserver(() => fitActive());
  ro.observe(host.value);
});
onUnmounted(() => ro?.disconnect());
watch(() => S.terms, sync, { deep: true });
watch(activeId, (id) => {
  if (id) S.activeTerm = id;
  show();
  nextTick(() => inst.get(id)?.term.focus());
});
// 断线重连后重新挂上终端，补回错过的输出
watch(
  () => S.connEpoch,
  () => inst.forEach((_, id) => attach(id)),
);
</script>

<template>
  <div class="win termwin">
    <div ref="host" class="hosts" />
  </div>
</template>

<style scoped>
.termwin { flex: 1; }
.hosts { flex: 1; min-height: 0; position: relative; background: var(--term-bg); }
.hosts :deep(.term-host) { position: absolute; inset: 8px 4px 4px 12px; }
</style>