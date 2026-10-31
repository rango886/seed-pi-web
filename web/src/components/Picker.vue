<script setup>
import { ref, computed, watch, nextTick } from 'vue';
import { S } from '../store.js';

// 通用的“可搜索列表”弹窗：选模型、选会话、选分叉点都用它
const q = ref('');
const sel = ref(0);
const input = ref(null);
const listEl = ref(null);

const items = computed(() => {
  const p = S.picker;
  if (!p) return [];
  const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
  return p.items.filter((it) => {
    const s = `${it.label} ${it.detail || ''}`.toLowerCase();
    return words.every((w) => s.includes(w));
  });
});

watch(
  () => S.picker,
  (p) => {
    if (!p) return;
    q.value = '';
    const cur = p.items.findIndex((i) => i.current);
    sel.value = Math.max(0, cur);
    nextTick(() => {
      input.value?.focus();
      scrollSel();
    });
  },
);
watch(q, () => (sel.value = 0));

function scrollSel() {
  nextTick(() => listEl.value?.children[sel.value]?.scrollIntoView({ block: 'nearest' }));
}
function choose(it) {
  const p = S.picker;
  S.picker = null;
  if (it) p.onPick(it.value);
}
function onKey(e) {
  const n = items.value.length;
  if (e.key === 'Escape') return e.preventDefault(), e.stopPropagation(), (S.picker = null);
  if (!n) return;
  if (e.key === 'ArrowDown') e.preventDefault(), (sel.value = (sel.value + 1) % n), scrollSel();
  else if (e.key === 'ArrowUp') e.preventDefault(), (sel.value = (sel.value - 1 + n) % n), scrollSel();
  else if (e.key === 'Enter') e.preventDefault(), choose(items.value[sel.value]);
}
</script>

<template>
  <div v-if="S.picker" class="modal-mask" @mousedown.self="S.picker = null">
    <div class="modal picker">
      <div class="modal-title">{{ S.picker.title }}</div>
      <div class="modal-body">
        <input ref="input" v-model="q" class="input" placeholder="输入关键字过滤，↑↓ 选择，Enter 确认" @keydown="onKey" />
        <div ref="listEl" class="list">
          <div
            v-for="(it, i) in items"
            :key="i"
            class="sel"
            :class="{ active: i === sel }"
            @mouseenter="sel = i"
            @click="choose(it)"
          >
            <span class="cur">{{ it.current ? '✓' : '' }}</span>
            <span class="ellipsis grow">{{ it.label }}</span>
            <span v-if="it.detail" class="dim small">{{ it.detail }}</span>
          </div>
          <div v-if="!items.length" class="dim empty">没有匹配的项目</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.picker { width: 640px; }
.modal-body { padding-bottom: 18px; }
.list { max-height: 52vh; overflow: auto; margin: 0 -8px; }
.input { width: 100%; height: 40px; }
.sel { min-height: 38px; }
.cur { width: 16px; color: var(--accent-text); flex: none; font-weight: 700; }
.small { font-size: var(--fs-xs); white-space: nowrap; }
.empty { padding: 20px; text-align: center; }
</style>