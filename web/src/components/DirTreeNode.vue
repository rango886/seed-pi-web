// 目录选择窗口的树状模式：一层一层展开，懒加载
<script setup>
import { ref, onMounted } from 'vue';
import { http } from '../api.js';
import Icon from './Icon.vue';

const props = defineProps({ entry: Object, depth: Number, selected: String, auto: String });
const emit = defineEmits(['pick', 'open']);

const open = ref(false);
const children = ref(null);
const loading = ref(false);
const error = ref('');
const el = ref(null);

async function load() {
  loading.value = true;
  try {
    const d = await http.get('/api/fs/list', { path: props.entry.path, dirsOnly: 1 });
    // 根目录（C:\）自带末尾分隔符，直接拼会出现双层反斜杠
    const sep = d.sep;
    children.value = d.entries.map((e) => ({ ...e, path: d.path.endsWith(sep) ? d.path + e.name : d.path + sep + e.name }));
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
  loading.value = false;
}

function click() {
  emit('pick', props.entry.path);
  open.value = !open.value;
  if (open.value && !children.value) load();
}

// 切到树状时，把当前选中的目录一路展开下来（auto 是目标路径）
const norm = (p) => (p || '').replace(/[\\/]+$/, '').toLowerCase();
const onPath = () => !!props.auto && norm(props.auto).startsWith(norm(props.entry.path)) && norm(props.auto) !== norm(props.entry.path);
if (onPath()) {
  open.value = true;
  load();
}
// 选中项挂上来以后滚到可见位置（展开到很深的目录时不至于跑到屏幕外）
onMounted(() => {
  if (props.selected === props.entry.path) el.value?.scrollIntoView({ block: 'nearest' });
});
</script>

<template>
  <div
    ref="el"
    class="node"
    :class="{ active: selected === entry.path }"
    :style="{ paddingLeft: depth * 14 + 6 + 'px' }"
    :title="entry.path"
    @click.stop="click"
    @dblclick.stop="emit('open', entry.path)"
  >
    <span class="arrow" :class="{ open }">
      <span v-if="loading" class="spin" />
      <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 6l6 6-6 6" /></svg>
    </span>
    <Icon name="folder" :size="14" />
    <span class="ellipsis grow">{{ entry.name }}</span>
  </div>
  <template v-if="open">
    <div v-if="error" class="err tiny" :style="{ paddingLeft: depth * 14 + 26 + 'px' }">{{ error }}</div>
    <DirTreeNode
      v-for="c in children || []"
      :key="c.path"
      :entry="c"
      :depth="depth + 1"
      :selected="selected"
      :auto="auto"
      @pick="$emit('pick', $event)"
      @open="$emit('open', $event)"
    />
  </template>
</template>

<style scoped>
.node { display: flex; align-items: center; gap: 6px; height: 28px; border-radius: var(--r-sm); cursor: pointer; padding-right: 8px; font-size: var(--fs-sm); white-space: nowrap; }
.node:hover { background: var(--hover); }
.node.active { background: var(--accent-soft); color: var(--accent-text); font-weight: 600; }
.arrow { width: 16px; height: 16px; flex: none; display: inline-flex; align-items: center; justify-content: center; color: var(--text-3); transition: transform 0.15s; }
.arrow.open { transform: rotate(90deg); }
.arrow .spin { width: 10px; height: 10px; border-width: 1.6px; }
.tiny { font-size: var(--fs-xs); padding: 2px 0; }
</style>
