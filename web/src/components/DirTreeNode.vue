// 目录选择窗口的树状模式：一层一层展开，懒加载
// 除了自己点，还能被外面接管：auto = 一路展开到这条路径；cmd = 右键菜单的“展开/折叠所有”；
// ver = 新建了目录，展开着的节点重新读一遍子目录
<script setup>
import { ref, watch, onMounted } from 'vue';
import { http } from '../api.js';
import Icon from './Icon.vue';

const props = defineProps({ entry: Object, depth: Number, selected: String, auto: String, cmd: Object, ver: Number });
const emit = defineEmits(['pick', 'open', 'menu']);

const open = ref(false);
const children = ref(null);
const loading = ref(false);
const error = ref('');
const el = ref(null);
// 用户手点展开的：别再让“展开所有”顺着往下溜
const manual = ref(false);

const norm = (p) => (p || '').replace(/[\\/]+$/, '').toLowerCase();
const same = (a, b) => !!a && !!b && norm(a) === norm(b);
/** p 是不是就在 dir 里面（含 dir 自己） */
const inside = (p, dir) => {
  const d = norm(dir);
  if (!d) return true; // 没指定 dir 就是整棵树
  const x = norm(p);
  return x === d || x.startsWith(d + '\\') || x.startsWith(d + '/');
};

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

function expand(v) {
  open.value = v;
  if (v && !children.value) load();
}

function click() {
  emit('pick', props.entry.path);
  manual.value = true;
  expand(!open.value);
}

function scrollToMe() {
  if (same(props.selected, props.entry.path)) el.value?.scrollIntoView({ block: 'nearest' });
}

// 打开窗口 / 点了左边的最近使用：沿目标路径一路展开下来
watch(
  () => props.auto,
  (p) => {
    if (p && !same(p, props.entry.path) && inside(p, props.entry.path)) {
      manual.value = false;
      expand(true);
    }
  },
);
// 右键菜单的展开/折叠：cmd 每次都是新对象，同一个模式再点一次也会生效
watch(
  () => props.cmd,
  (c) => {
    if (!c || !inside(props.entry.path, c.target)) return;
    manual.value = false;
    expand(c.mode === 'expand');
  },
);
// 新建了目录：展开着的节点重新读一遍，新目录才会冒出来
watch(
  () => props.ver,
  () => open.value && load(),
);
// 选中项变了：滚到看得见的位置（展开到很深的目录时不至于跑到屏幕外）
watch(() => props.selected, scrollToMe);

// 新挂上来的节点：正被“展开所有”扫到、或者目标路径要从这一层下去，就直接展开
if (props.cmd?.mode === 'expand' && inside(props.entry.path, props.cmd.target)) expand(true);
if (props.auto && !same(props.auto, props.entry.path) && inside(props.auto, props.entry.path)) expand(true);
onMounted(scrollToMe);
</script>

<template>
  <div
    ref="el"
    class="node"
    :class="{ active: same(selected, entry.path) }"
    :style="{ paddingLeft: depth * 14 + 6 + 'px' }"
    :title="entry.path"
    @click.stop="click"
    @dblclick.stop="emit('open', entry.path)"
    @contextmenu.prevent.stop="emit('menu', $event, entry.path)"
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
      :cmd="manual ? null : cmd"
      :ver="ver"
      @pick="$emit('pick', $event)"
      @open="$emit('open', $event)"
      @menu="(...a) => $emit('menu', ...a)"
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