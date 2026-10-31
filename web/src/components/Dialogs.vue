<script setup>
import { ref, computed, watch, nextTick } from 'vue';
import { S, answerDialog } from '../store.js';

// 一次只显示一个：扩展的 select/confirm/input/editor，以及网页自己的 info/confirm/input
const d = computed(() => S.dialogs[0] || null);
const value = ref('');
const sel = ref(0);
const box = ref(null);
const left = ref(0);
let timer;

watch(
  d,
  (v) => {
    clearInterval(timer);
    if (!v) return;
    value.value = v.prefill ?? '';
    sel.value = 0;
    if (v.timeout) {
      const end = Date.now() + v.timeout;
      left.value = Math.ceil(v.timeout / 1000);
      timer = setInterval(() => (left.value = Math.max(0, Math.ceil((end - Date.now()) / 1000))), 250);
    } else left.value = 0;
    nextTick(() => box.value?.querySelector('input, textarea, .focus')?.focus());
  },
  { immediate: true },
);

const ok = () => {
  const v = d.value;
  if (v.method === 'confirm') answerDialog(v, { confirmed: true });
  else if (v.method === 'select') answerDialog(v, { value: v.options[sel.value] });
  else if (v.method === 'info') answerDialog(v, {});
  else answerDialog(v, { value: value.value });
};
const cancel = () => {
  const v = d.value;
  if (v.method === 'confirm') answerDialog(v, { confirmed: false });
  else answerDialog(v, { cancelled: true });
};

function onKey(e) {
  const v = d.value;
  if (e.key === 'Escape') return e.preventDefault(), e.stopPropagation(), cancel();
  if (v.method === 'select') {
    if (e.key === 'ArrowDown') return e.preventDefault(), (sel.value = (sel.value + 1) % v.options.length);
    if (e.key === 'ArrowUp') return e.preventDefault(), (sel.value = (sel.value - 1 + v.options.length) % v.options.length);
  }
  if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && (v.method !== 'editor' || e.ctrlKey)) {
    e.preventDefault();
    ok();
  }
}
</script>

<template>
  <div v-if="d" class="modal-mask" @mousedown.self="cancel">
    <div ref="box" class="modal" tabindex="-1" @keydown="onKey">
      <div class="modal-title">
        <span class="grow ellipsis">{{ d.title || '请确认' }}</span>
        <span v-if="left" class="badge">{{ left }}s</span>
        <span v-if="S.dialogs.length > 1" class="badge">还有 {{ S.dialogs.length - 1 }} 个</span>
      </div>
      <div class="modal-body">
        <div v-if="d.message" class="pre">{{ d.message }}</div>

        <template v-if="d.method === 'select'">
          <div class="list focus" tabindex="0">
            <div v-for="(o, i) in d.options" :key="i" class="sel" :class="{ active: i === sel }" @mouseenter="sel = i" @click="ok">{{ o }}</div>
          </div>
        </template>

        <input v-else-if="d.method === 'input'" v-model="value" class="input" :placeholder="d.placeholder || ''" />

        <textarea v-else-if="d.method === 'editor'" v-model="value" class="input editor" spellcheck="false" />

        <table v-else-if="d.method === 'info'" class="info">
          <tr v-for="([k, v], i) in d.rows" :key="i">
            <td class="dim">{{ k }}</td>
            <td>{{ v }}</td>
          </tr>
        </table>
      </div>
      <div class="modal-foot">
        <span v-if="d.method === 'editor'" class="dim small grow">Ctrl+Enter 确认</span>
        <template v-if="d.method === 'info'">
          <button class="btn primary focus" @click="ok">好的</button>
        </template>
        <template v-else>
          <button class="btn" @click="cancel">取消</button>
          <button class="btn primary" :class="{ focus: d.method === 'confirm' }" @click="ok">{{ d.method === 'confirm' ? '确定' : '确认' }}</button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal:focus { outline: none; }
.pre { white-space: pre-wrap; line-height: var(--lh); color: var(--text-2); }
.list { border: 1px solid var(--line); border-radius: var(--r-md); padding: 4px; max-height: 50vh; overflow: auto; outline: none; }
.input { width: 100%; }
.editor { height: 40vh; min-width: 560px; padding: 10px 12px; resize: vertical; font-family: var(--font-code); line-height: 1.6; }
.info { border-collapse: collapse; }
.info td { padding: 7px 16px 7px 0; vertical-align: top; word-break: break-all; border-bottom: 1px solid var(--line-2); }
.info tr:last-child td { border-bottom: 0; }
.info td:first-child { white-space: nowrap; }
.small { font-size: var(--fs-xs); }
.badge { font-size: var(--fs-xs); font-weight: normal; color: var(--text-3); background: var(--hover); padding: 1px 8px; border-radius: 10px; }
.editor { min-width: min(560px, 84vw); }
</style>
