<script setup>
import { ref, watch, onMounted } from 'vue';
import { S, openFile, insertToComposer } from '../store.js';
import { http } from '../api.js';

const props = defineProps({ entry: Object, depth: Number, root: Boolean });
const open = ref(props.root);
const children = ref(null);
const error = ref(null);

async function load() {
  try {
    const d = await http.get('/api/fs/list', { path: props.entry.path });
    children.value = d.entries.map((e) => ({ ...e, path: d.path + d.sep + e.name }));
    error.value = null;
  } catch (e) {
    error.value = e.message;
  }
}
function click() {
  if (props.entry.dir) {
    open.value = !open.value;
    if (open.value && !children.value) load();
  } else openFile(props.entry.path);
}
// 工具改了文件、手动刷新时，已展开的目录重新读一遍
watch(
  () => S.fsEpoch,
  () => open.value && children.value && load(),
);
onMounted(() => props.root && load());

function rel() {
  const p = props.entry.path;
  const c = S.cwd.replace(/[\\/]+$/, '');
  return p.startsWith(c) ? p.slice(c.length + 1) || '.' : p;
}
</script>

<template>
  <div v-if="!root" class="node sel" :style="{ paddingLeft: depth * 14 + 4 + 'px' }" :title="entry.path" @click="click">
    <span class="arrow" :class="{ open }"><svg v-if="entry.dir" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 6l6 6-6 6" /></svg></span>
    <span class="ellipsis grow" :class="{ dim: entry.name.startsWith('.'), d: entry.dir }">{{ entry.name }}</span>
    <span class="at" title="在输入框里引用这个路径" @click.stop="insertToComposer(rel())">@</span>
  </div>
  <template v-if="open">
    <div v-if="error" class="err small" :style="{ paddingLeft: depth * 14 + 22 + 'px' }">{{ error }}</div>
    <TreeNode v-for="c in children || []" :key="c.path" :entry="c" :depth="root ? 0 : depth + 1" />
  </template>
</template>

<style scoped>
.node { min-height: 28px; padding: 0 6px 0 4px; gap: 4px; white-space: nowrap; font-size: var(--fs-sm); border-radius: 6px; }
.arrow { width: 16px; height: 16px; flex: none; color: var(--text-3); display: inline-flex; align-items: center; justify-content: center; transition: transform 0.15s; }
.arrow.open { transform: rotate(90deg); }
.d { color: var(--text); font-weight: 500; }
.at { opacity: 0; width: 22px; height: 20px; border-radius: 5px; display: inline-flex; align-items: center; justify-content: center; color: var(--accent-text); font-size: var(--fs-xs); flex: none; }
.node:hover .at { opacity: 0.8; }
.at:hover { opacity: 1 !important; background: var(--accent); color: #fff; }
.small { font-size: var(--fs-xs); padding: 4px 0; }
</style>