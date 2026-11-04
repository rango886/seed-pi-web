<script setup>
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { S, openFile, openDiff, loadFile } from '../store.js';
import { diffNames } from '../git.js';
import SelectMenu from './SelectMenu.vue';

const modeDescriptions = { staged: '上次提交 → 暂存区', working: '暂存区 → 工作区', head: '上次提交 → 工作区' };
const modeOptions = Object.entries(diffNames).map(([value, label]) => ({ value, label, description: modeDescriptions[value] }));

const props = defineProps({ tab: Object });
const box = ref(null);
const split = ref(true);
const narrow = ref(false);
const cursor = ref(-1);
let observer;
const d = computed(() => props.tab.data);
const sideBySide = computed(() => split.value && !narrow.value);
const sections = computed(() => (d.value?.hunks || []).map((h) => {
  let old = h.oldStart, current = h.newStart;
  const unified = h.lines.map((line) => {
    const type = line[0];
    return { type, text: line.slice(1), old: type === '+' || type === '\\' ? '' : old++, current: type === '-' || type === '\\' ? '' : current++ };
  });
  const paired = [];
  for (let i = 0; i < unified.length;) {
    const r = unified[i];
    if (r.type === ' ') { paired.push({ left: r, right: r }); i++; }
    else if (r.type === '\\') { paired.push({ note: r.text }); i++; }
    else {
      const removed = [], added = [];
      while (i < unified.length && ['-', '+'].includes(unified[i].type)) {
        const next = unified[i++];
        (next.type === '-' ? removed : added).push(next);
      }
      for (let n = 0; n < Math.max(removed.length, added.length); n++) paired.push({ left: removed[n], right: added[n] });
    }
  }
  return { ...h, unified, paired };
}));
async function jump(delta) {
  const count = sections.value.length;
  if (!count) return;
  cursor.value = cursor.value < 0 ? (delta > 0 ? 0 : count - 1) : (cursor.value + delta + count) % count;
  await nextTick();
  box.value?.querySelectorAll('.hunk')[cursor.value]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
watch(() => props.tab.data, () => { cursor.value = -1; });
watch(() => [S.activeTab, S.fsEpoch], () => {
  if (S.activeTab === props.tab.id && !props.tab.loading) loadFile(props.tab);
});
onMounted(() => {
  observer = new ResizeObserver(([e]) => { if (e.contentRect.width) narrow.value = e.contentRect.width < 760; });
  observer.observe(box.value);
});
onUnmounted(() => observer?.disconnect());
</script>

<template>
  <div ref="box" class="diff-viewer">
    <div class="diff-bar">
      <span class="ellipsis path" :title="tab.path">{{ tab.path }}</span>
      <button class="btn sm" @click="openFile(tab.path)">文件</button>
      <SelectMenu :model-value="tab.mode" :options="modeOptions" label="对比范围" :disabled="S.activeTab !== tab.id" @update:model-value="openDiff(tab.path, { cwd: tab.cwd, mode: $event })" />
      <button class="btn sm" :disabled="narrow" @click="split = !split">{{ sideBySide ? '合并显示' : '并排显示' }}</button>
      <button class="btn sm" title="上一个修改区块" :disabled="!sections.length" @click="jump(-1)">↑</button>
      <button class="btn sm" title="下一个修改区块" :disabled="!sections.length" @click="jump(1)">↓</button>
      <button class="btn sm" :disabled="tab.loading" @click="loadFile(tab)">{{ tab.loading ? '加载中…' : '刷新' }}</button>
    </div>
    <div v-if="d?.oldLabel" class="diff-labels"><span>{{ d.oldLabel }} · {{ d.oldPath }}</span><span>{{ d.newLabel }} · {{ d.path }}</span></div>
    <div v-if="d?.conflict" class="diff-notice">存在合并冲突：这里比较 ours 与当前工作区，并非三方合并编辑器；冲突标记会原样显示。</div>
    <div class="diff-content">
      <div v-if="tab.error" class="err pad">{{ tab.error }}</div>
      <div v-else-if="!d" class="dim pad">加载中…</div>
      <div v-else-if="d.message" class="dim pad">{{ d.message }}</div>
      <div v-else-if="!sections.length" class="dim pad">没有文本差异（也可能只有路径、权限或文件类型变化）。</div>
      <template v-else>
        <section v-for="(h, hi) in sections" :key="hi" class="hunk">
          <div class="hunk-head">@@ -{{ h.oldStart }},{{ h.oldLines }} +{{ h.newStart }},{{ h.newLines }} @@ <span>{{ hi + 1 }} / {{ sections.length }}</span></div>
          <table v-if="sideBySide" class="diff-table split"><colgroup><col class="num-col" /><col /><col class="num-col" /><col /></colgroup>
            <tbody><tr v-for="(r, i) in h.paired" :key="i">
              <td v-if="r.note" colspan="4" class="note">{{ r.note }}</td>
              <template v-else>
                <td class="num" :class="{ del: r.left?.type === '-', vacant: !r.left }">{{ r.left?.old }}</td>
                <td class="code left" :class="{ del: r.left?.type === '-', vacant: !r.left }"><pre>{{ r.left?.text }}</pre></td>
                <td class="num" :class="{ add: r.right?.type === '+', vacant: !r.right }">{{ r.right?.current }}</td>
                <td class="code" :class="{ add: r.right?.type === '+', vacant: !r.right }"><pre>{{ r.right?.text }}</pre></td>
              </template>
            </tr></tbody>
          </table>
          <table v-else class="diff-table unified"><colgroup><col class="num-col" /><col class="num-col" /><col class="prefix-col" /><col /></colgroup>
            <tbody><tr v-for="(r, i) in h.unified" :key="i" :class="{ del: r.type === '-', add: r.type === '+' }">
              <td class="num">{{ r.old }}</td><td class="num">{{ r.current }}</td><td class="prefix">{{ r.type }}</td><td class="code"><pre>{{ r.text }}</pre></td>
            </tr></tbody>
          </table>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.diff-viewer { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; background: var(--panel); }
.diff-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 14px; border-bottom: 1px solid var(--line); font-size: var(--fs-sm); }
.path { flex: 1; min-width: 120px; color: var(--text-2); }
.diff-labels { display: flex; gap: 12px; padding: 6px 14px; color: var(--text-2); font-size: var(--fs-xs); border-bottom: 1px solid var(--line); }
.diff-labels span { flex: 1; overflow-wrap: anywhere; }
.diff-content { flex: 1; min-height: 0; overflow: auto; }
.pad { padding: 20px; }
.diff-notice { padding: 8px 14px; font-size: var(--fs-sm); color: var(--warn); }
.hunk { scroll-margin-top: 4px; margin-bottom: 12px; }
.hunk-head { padding: 6px 14px; font-family: var(--font-code); font-size: var(--fs-xs); color: var(--text-3); background: var(--panel-2); }
.hunk-head span { float: right; }
.diff-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-family: var(--font-code); font-size: var(--fs-code); line-height: 1.6; }
.num-col { width: 54px; }.prefix-col { width: 20px; }
.num { padding: 0 8px; text-align: right; color: var(--text-3); user-select: none; vertical-align: top; }
.code { padding: 0 10px; vertical-align: top; }
.code pre { margin: 0; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4; min-height: 1.6em; }
.left { border-right: 1px solid var(--line); }
.del { background: color-mix(in srgb, var(--err) 12%, transparent); }
.add { background: color-mix(in srgb, var(--ok) 13%, transparent); }
.vacant { background: var(--panel-2); }
.note { padding: 2px 14px; color: var(--text-3); font-style: italic; }
.prefix { user-select: none; color: var(--text-3); vertical-align: top; }
@media (max-width: 600px) { .path { flex-basis: 100%; }.num-col { width: 38px; }.code { padding: 0 6px; } }
</style>
