<script setup>
import { computed, ref, watch } from 'vue';
import { S, conversationNodes, switchBranch, labelBranch, branchDisabled, restoreBranchSelection, toast } from '../store.js';
import { openMenu } from '../settings.js';
import Icon from './Icon.vue';
import FloatingPanel from './FloatingPanel.vue';

const emit = defineEmits(['jump']);
const query = ref('');
const preparedId = ref(null);
const folded = ref(new Set());
const expandedChains = ref(new Set());
const nodes = computed(() => S.conversation?.nodes || []);
const children = computed(() => {
  const map = new Map();
  for (const n of nodes.value) {
    const p = conversationNodes.value.has(n.parentId) ? n.parentId : null;
    if (!map.has(p)) map.set(p, []);
    map.get(p).push(n);
  }
  return map;
});
const currentId = computed(() => preparedId.value || nodes.value.filter(n => n.active).at(-1)?.id);
const historical = computed(() => S.conversation?.historicalSelection);
const canRestore = computed(() => historical.value?.model && (historical.value.model.provider !== S.state?.model?.provider || historical.value.model.id !== S.state?.model?.id || historical.value.thinkingLevel !== S.state?.thinkingLevel));
const rows = computed(() => {
  const q = query.value.trim().toLowerCase();
  const visible = new Set();
  if (q) for (const n of nodes.value) {
    if (!`${n.label} ${n.text}`.toLowerCase().includes(q)) continue;
    for (let cur = n; cur && !visible.has(cur.id); cur = conversationNodes.value.get(cur.parentId)) visible.add(cur.id);
  }
  const out = [], seen = new Set();
  const stack = [...(children.value.get(null) || [])].reverse().map(n => ({ n, depth: 0 }));
  while (stack.length) {
    const { n, depth } = stack.pop();
    if (seen.has(n.id) || (q && !visible.has(n.id))) continue;
    seen.add(n.id);
    const kids = children.value.get(n.id) || [];
    out.push({ n, depth, kids: kids.length });
    if (!q && folded.value.has(n.id)) continue;
    if (!q && !expandedChains.value.has(n.id)) {
      const chain = [];
      let next = kids;
      const chainSeen = new Set([n.id]);
      while (next.length === 1 && !next[0].label && next[0].versions.length === 1 && !chainSeen.has(next[0].id)) {
        chain.push(next[0]);
        chainSeen.add(next[0].id);
        if (next[0].id === currentId.value) break;
        next = children.value.get(next[0].id) || [];
      }
      if (chain.length > 5) {
        out.push({ chain: n.id, count: chain.length - 1, depth: depth + 1, active: chain.some(it => it.active) });
        stack.push({ n: chain.at(-1), depth: depth + 1 });
        continue;
      }
    }
    for (const child of [...kids].reverse()) stack.push({ n: child, depth: depth + 1 });
  }
  return out;
});
const nodeTitle = n => n.text + (n.label ? ` · ${n.label}` : '');
const canJump = n => S.messages.some(m => m._entryId === n.id);
function jump(n) {
  if (canJump(n)) emit('jump', n.id);
  else toast('这条消息不在当前对话中，可通过右键菜单切换分支', 'info');
}
async function navigate(n) {
  if (branchDisabled.value) return;
  const ok = await switchBranch(n.id, { toId: n.id, prepare: true });
  if (ok) preparedId.value = n.id;
  return ok;
}
function nodeMenu(e, n) {
  openMenu(e.clientX, e.clientY, [
    { label: '切换到这里', disabled: branchDisabled.value, run: () => navigate(n) },
    { label: '命名', disabled: branchDisabled.value, run: () => labelBranch(n) },
    { label: '跳转到消息', disabled: !canJump(n), run: () => jump(n) },
  ]);
}
function toggle(id) {
  const s = new Set(folded.value);
  s.has(id) ? s.delete(id) : s.add(id);
  folded.value = s;
}
function expandChain(id) {
  const expanded = new Set(expandedChains.value), seen = new Set();
  for (let cur = conversationNodes.value.get(id); cur && !seen.has(cur.id);) {
    seen.add(cur.id);
    expanded.add(cur.id);
    const next = children.value.get(cur.id) || [];
    cur = next.length === 1 && !next[0].label && next[0].versions.length === 1 ? next[0] : null;
  }
  expandedChains.value = expanded;
}
watch(() => S.conversation?.leafId, () => { preparedId.value = null; });
watch(() => S.agent?.sessionFile, () => { preparedId.value = null; folded.value = new Set(); expandedChains.value = new Set(); });
</script>

<template>
  <FloatingPanel :open="S.branchesOpen" inline title="对话分支" icon="branch" @close="S.branchesOpen = false">
    <div class="search">
      <Icon name="search" :size="15" />
      <input v-model="query" aria-label="搜索所有分支" placeholder="搜索问题或分支名称…" />
    </div>
    <div v-if="canRestore" class="restore">
      <span>此前：{{ historical.model.id }} / {{ historical.thinkingLevel }}</span>
      <button class="btn sm" :disabled="branchDisabled" @click="restoreBranchSelection">恢复此分支设置</button>
    </div>
    <div class="tree-list">
      <div v-if="!nodes.length" class="empty">{{ S.agentId && !S.conversation ? '暂时无法读取分支，请重新加载 pi' : '还没有对话分支' }}</div>
      <div v-else-if="!rows.length" class="empty">没有匹配的问题</div>
      <template v-for="row in rows" :key="row.chain ? `chain:${row.chain}` : row.n.id">
        <button v-if="row.chain" class="chain" :style="{ paddingLeft: Math.min(row.depth, 10) * 28 + 6 + 'px' }" @click="expandChain(row.chain)"><span class="arrow"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 6l6 6-6 6" /></svg></span><span>展开后续 {{ row.count }} 轮</span></button>
        <div v-else class="tree-row" :class="{ active: row.n.id === currentId }" :style="{ paddingLeft: Math.min(row.depth, 10) * 28 + 6 + 'px' }" :data-current="row.n.id === currentId" @contextmenu.prevent.stop="nodeMenu($event, row.n)">
          <button v-if="row.kids" class="fold arrow" :class="{ open: !folded.has(row.n.id) }" :aria-expanded="!folded.has(row.n.id)" :aria-label="folded.has(row.n.id) ? '展开后续' : '折叠后续'" @click.stop="toggle(row.n.id)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 6l6 6-6 6" /></svg></button>
          <span v-else class="arrow" aria-hidden="true" />
          <button class="node" :title="nodeTitle(row.n)" @click="jump(row.n)">
            <span class="node-text ellipsis">{{ row.n.text }}</span>
            <span v-if="row.n.label" class="node-label ellipsis" :title="row.n.label">· {{ row.n.label }}</span>
            <small v-if="row.n.id === preparedId">待发送</small>
            <small v-else-if="row.n.id === currentId">当前</small>
            <small v-else-if="!row.kids">终点</small>
            <small v-else-if="row.n.versions.length > 1">版本 {{ row.n.versions.indexOf(row.n.id) + 1 }}/{{ row.n.versions.length }}</small>
          </button>
        </div>
      </template>
    </div>
  </FloatingPanel>
</template>

<style scoped>
.search { display: flex; align-items: center; gap: 6px; margin: 16px 14px; padding: 0 8px; height: 34px; flex: none; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--panel); color: var(--text-3); }
.search:focus-within { border-color: var(--accent); }
.search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--text); font-size: var(--fs-sm); }
.restore { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 14px 8px; font-size: var(--fs-xs); color: var(--text-3); }
.tree-list { flex: 1; min-height: 80px; overflow: auto; padding: 0 8px 12px; }
.tree-row { display: flex; align-items: center; gap: 8px; height: 28px; padding-right: 8px; border-radius: var(--r-sm); font-size: var(--fs-sm); white-space: nowrap; }
.tree-row:hover { background: var(--hover); }
.tree-row.active { background: var(--accent-soft); color: var(--accent-text); font-weight: 600; }
.fold, .node, .chain { border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; }
.arrow { width: 20px; height: 16px; flex: none; display: inline-flex; align-items: center; justify-content: center; padding: 0; color: var(--text-3); transition: transform 0.15s; }
.arrow.open { transform: rotate(90deg); }
.node { flex: 1; display: flex; align-items: center; gap: 6px; min-width: 0; height: 100%; padding: 0; text-align: left; }
.node-text { flex: 0 1 auto; min-width: 0; }
.node-label { flex: 0 0 auto; max-width: 40%; color: var(--text-3); font-size: var(--fs-xs); font-weight: 400; }
.node:focus-visible, .fold:focus-visible, .chain:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: var(--r-sm); }
small { flex: none; margin-left: auto; color: var(--text-3); font-size: var(--fs-xs); font-weight: 400; }
.chain { display: flex; align-items: center; gap: 8px; width: 100%; height: 28px; text-align: left; color: var(--text-3); font-size: var(--fs-xs); }
.chain:hover { background: var(--hover); }
.empty { padding: 20px 12px; color: var(--text-3); font-size: var(--fs-sm); }
</style>
