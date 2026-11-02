<script setup>
import { ref, watch, onMounted } from 'vue';
import { S, openFile, attachFromTree } from '../store.js';
import { http } from '../api.js';
import { iconOf } from '../util.js';
import Icon from './Icon.vue';

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

// 拖到输入框上：带上真实路径，输入框那边直接当附件，不用上传
function onDragStart(e) {
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData('application/x-pi-path', JSON.stringify([{ path: props.entry.path, dir: !!props.entry.dir }]));
  e.dataTransfer.setData('text/plain', props.entry.path);
}
</script>

<template>
  <div v-if="!root" class="node sel" :style="{ paddingLeft: depth * 14 + 4 + 'px' }" :title="entry.path" draggable="true" @dragstart="onDragStart" @click="click">
    <span class="arrow" :class="{ open }"><svg v-if="entry.dir" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 6l6 6-6 6" /></svg></span>
    <span class="fic" :class="{ dir: entry.dir }"><Icon :name="iconOf(entry.name, entry.dir)" :size="14" /></span>
    <span class="ellipsis grow" :class="{ dim: entry.name.startsWith('.'), d: entry.dir }">{{ entry.name }}</span>
    <span class="at" title="加到输入框的附件里（也可以直接拖过去）" @click.stop="attachFromTree(entry.path, entry.dir)">@</span>
  </div>
  <template v-if="open">
    <div v-if="error" class="err small" :style="{ paddingLeft: depth * 14 + 22 + 'px' }">{{ error }}</div>
    <TreeNode v-for="c in children || []" :key="c.path" :entry="c" :depth="root ? 0 : depth + 1" />
  </template>
</template>

<style scoped>
.node { min-height: 28px; padding: 0 6px 0 4px; gap: 4px; white-space: nowrap; font-size: var(--fs-sm); border-radius: var(--r-sm); }
.arrow { width: 16px; height: 16px; flex: none; color: var(--text-3); display: inline-flex; align-items: center; justify-content: center; transition: transform 0.15s; }
/* 文件类型图标：目录用主题色偏暗一点，文件统一浅灰，免得每个图标都在抢注意力 */
.fic { width: 16px; flex: none; display: inline-flex; align-items: center; justify-content: center; color: var(--text-3); }
.fic.dir { color: var(--accent-text); opacity: 0.85; }
.arrow.open { transform: rotate(90deg); }
.d { color: var(--text); font-weight: 500; }
.at { opacity: 0; width: 22px; height: 20px; border-radius: var(--r-xs); display: inline-flex; align-items: center; justify-content: center; color: var(--accent-text); font-size: var(--fs-xs); flex: none; }
.node:hover .at { opacity: 0.8; }
.at:hover { opacity: 1 !important; background: var(--accent); color: #fff; }
.small { font-size: var(--fs-xs); padding: 4px 0; }
</style>
