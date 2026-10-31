<script setup>
import { ref, computed, onMounted, nextTick } from 'vue';
import { S, loadModels, setModel, toast } from '../store.js';

// 输入框上方弹出的模型菜单：搜索 + 最近使用 + 按 provider 分组
const emit = defineEmits(['close']);
const q = ref('');
const sel = ref(0);
const input = ref(null);
const listEl = ref(null);
const loading = ref(!S.models.length);

onMounted(async () => {
  nextTick(() => input.value?.focus());
  try {
    await loadModels();
  } catch (e) {
    toast(e.message, 'error');
  }
  loading.value = false;
  const i = flat.value.findIndex((x) => isCur(x.m));
  sel.value = Math.max(0, i);
  scrollSel();
});

const key = (m) => `${m.provider}/${m.id}`;
const cur = computed(() => S.state?.model);
const isCur = (m) => cur.value && cur.value.provider === m.provider && cur.value.id === m.id;

const groups = computed(() => {
  const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
  const match = (m) => words.every((w) => `${key(m)} ${m.name || ''}`.toLowerCase().includes(w));
  const list = S.models.filter(match);
  const out = [];
  if (!words.length) {
    const recent = JSON.parse(localStorage.getItem('pi-web-recent-models') || '[]');
    const rs = recent.map((k) => list.find((m) => key(m) === k)).filter(Boolean);
    if (rs.length) out.push({ name: '最近使用', items: rs });
  }
  const by = new Map();
  for (const m of list) {
    if (!by.has(m.provider)) by.set(m.provider, []);
    by.get(m.provider).push(m);
  }
  for (const [name, items] of by) out.push({ name, items });
  return out;
});
// 键盘导航用的扁平列表
const flat = computed(() => groups.value.flatMap((g, gi) => g.items.map((m) => ({ m, gi }))));
const idxOf = (gi, m) => flat.value.findIndex((x) => x.gi === gi && x.m === m);

function scrollSel() {
  nextTick(() => listEl.value?.querySelector('.mi.active')?.scrollIntoView({ block: 'nearest' }));
}
async function choose(m) {
  emit('close');
  if (!isCur(m)) await setModel(m);
}
function onKey(e) {
  const n = flat.value.length;
  if (e.key === 'Escape') return e.preventDefault(), e.stopPropagation(), emit('close');
  if (!n) return;
  if (e.key === 'ArrowDown') e.preventDefault(), (sel.value = (sel.value + 1) % n), scrollSel();
  else if (e.key === 'ArrowUp') e.preventDefault(), (sel.value = (sel.value - 1 + n) % n), scrollSel();
  else if (e.key === 'Enter') e.preventDefault(), choose(flat.value[sel.value].m);
}
const ctxLabel = (m) => (m.contextWindow ? (m.contextWindow >= 1e6 ? `${(m.contextWindow / 1e6).toFixed(1).replace(/\.0$/, '')}M` : `${Math.round(m.contextWindow / 1000)}k`) : '');
</script>

<template>
  <div class="pop mm">
    <div class="search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
      <input ref="input" v-model="q" placeholder="搜索模型…" @keydown="onKey" @input="sel = 0" />
    </div>
    <div ref="listEl" class="list">
      <div v-if="loading" class="empty"><span class="spin" /></div>
      <div v-else-if="!flat.length" class="empty">没有匹配的模型</div>
      <template v-for="(g, gi) in groups" :key="g.name + gi">
        <div class="gname">{{ g.name }}</div>
        <div
          v-for="m in g.items"
          :key="key(m)"
          class="mi"
          :class="{ active: idxOf(gi, m) === sel, cur: isCur(m) }"
          @mouseenter="sel = idxOf(gi, m)"
          @click="choose(m)"
        >
          <span class="check">{{ isCur(m) ? '✓' : '' }}</span>
          <span class="ellipsis grow">{{ m.name || m.id }}<span v-if="gi === 0 && g.name === '最近使用'" class="prov">{{ m.provider }}</span></span>
          <span v-if="m.reasoning" class="tag">思考</span>
          <span v-if="ctxLabel(m)" class="tag">{{ ctxLabel(m) }}</span>
        </div>
      </template>
    </div>
    <div class="foot">↑↓ 选择 · Enter 确认 · Esc 关闭</div>
  </div>
</template>

<style scoped>
.mm { bottom: calc(100% + 8px); left: 0; width: 400px; max-width: calc(100vw - 32px); padding: 0; display: flex; flex-direction: column; overflow: hidden; }
.search { display: flex; align-items: center; gap: 8px; padding: 0 12px; border-bottom: 1px solid var(--line); color: var(--text-3); }
.search input { flex: 1; border: 0; outline: none; background: transparent; height: 42px; color: var(--text); }
.list { max-height: 360px; overflow-y: auto; padding: 4px 6px 6px; }
.gname { font-size: var(--fs-xs); color: var(--text-3); padding: 8px 8px 4px; }
.mi { display: flex; align-items: center; gap: 8px; padding: 0 10px 0 6px; height: 34px; border-radius: var(--r-sm); cursor: pointer; }
.mi.active { background: var(--hover); }
.mi.cur { color: var(--accent-text); font-weight: 600; }
.check { width: 16px; text-align: center; flex: none; }
.prov { color: var(--text-3); font-size: var(--fs-xs); margin-left: 8px; font-weight: normal; }
.tag { font-size: 11px; color: var(--text-3); border: 1px solid var(--line); border-radius: 5px; padding: 0 5px; line-height: 18px; flex: none; font-weight: normal; }
.empty { padding: 24px; text-align: center; color: var(--text-3); }
.foot { font-size: var(--fs-xs); color: var(--text-3); padding: 6px 12px; border-top: 1px solid var(--line); background: var(--panel-2); }
</style>
