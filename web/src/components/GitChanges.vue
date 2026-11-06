<script setup>
import { computed, reactive, ref } from 'vue';
import { S, openDiff, openFile } from '../store.js';
import { G, changeGroups, repoPath, statusNames } from '../git.js';
import { openMenu } from '../settings.js';
import { downloadPath } from '../file-download.js';
import { iconOf } from '../util.js';
import Icon from './Icon.vue';

const tree = ref(localStorage.getItem('seed-pi-web-git-tree') === '1');
const closed = reactive(new Set());
function toggleLayout() {
  tree.value = !tree.value;
  localStorage.setItem('seed-pi-web-git-tree', tree.value ? '1' : '0');
}
function toggle(key) { closed.has(key) ? closed.delete(key) : closed.add(key); }
const groups = computed(() => changeGroups.value.map((g) => {
  if (!tree.value) return { ...g, rows: g.entries.map((e) => ({ entry: e, key: e.path, depth: 0 })) };
  const root = { children: new Map() };
  for (const entry of g.entries) {
    const parts = entry.path.split('/');
    let node = root, prefix = '';
    for (let i = 0; i < parts.length; i++) {
      prefix += (prefix ? '/' : '') + parts[i];
      if (!node.children.has(parts[i])) node.children.set(parts[i], { name: parts[i], key: prefix, children: new Map() });
      node = node.children.get(parts[i]);
      if (i === parts.length - 1) node.entry = entry;
    }
  }
  const rows = [];
  function walk(node, depth) {
    const children = [...node.children.values()].sort((a, b) => Number(!a.children.size) - Number(!b.children.size) || a.name.localeCompare(b.name));
    for (const child of children) {
      rows.push({ ...child, depth, dir: child.children.size > 0 && !child.entry });
      if (!closed.has(g.key + ':' + child.key)) walk(child, depth + 1);
    }
  }
  walk(root, 0);
  return { ...g, rows };
}));
const base = (p) => p.split('/').pop();
const parent = (p) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
function open(entry, group) { openDiff(repoPath(entry.path), { cwd: G.data.root, mode: group.mode }); }
function context(e, entry, group) {
  const p = repoPath(entry.path);
  openMenu(e.clientX, e.clientY, [
    { label: '查看对比', run: () => open(entry, group) },
    ...(entry.code !== 'D' ? [{ label: '打开文件', run: () => openFile(p) }, { label: '下载文件', run: () => downloadPath(p) }] : []),
    { label: '复制路径', run: () => navigator.clipboard.writeText(p) },
  ]);
}
</script>

<template>
  <div v-if="G.cwd === S.cwd" class="git-changes">
    <div v-if="G.error" class="git-error">Git 状态读取失败：{{ G.error }}</div>
    <div v-else-if="G.data?.message" class="git-message">{{ G.data.message }}</div>
    <template v-if="G.data?.available">
      <div class="branch" :title="`仓库：${G.data.root}\n变更列表覆盖整个仓库`">
        <Icon class="branch-symbol" name="branching" :size="16" /><span class="ellipsis grow">{{ G.data.branch || '未命名分支' }}</span>
        <span v-if="G.data.ahead || G.data.behind" class="dim">↑{{ G.data.ahead }} ↓{{ G.data.behind }}</span>
        <span class="total">{{ G.data.entries.length }}</span>
        <button class="layout" :title="tree ? '切换为列表' : '切换为树形'" @click="toggleLayout"><Icon :name="tree ? 'list' : 'branching'" :size="16" /></button>
      </div>
      <div v-if="!groups.length" class="clean">工作区干净，没有变更</div>
      <div v-else class="changes-list">
        <section v-for="g in groups" :key="g.key">
          <button class="group" :aria-expanded="!closed.has(g.key)" @click="toggle(g.key)"><Icon class="fold-icon" name="chevron" :size="14" :class="{ open: !closed.has(g.key) }" /><span class="grow">{{ g.title }}</span><span class="total">{{ g.entries.length }}</span></button>
          <template v-if="!closed.has(g.key)">
            <template v-for="row in g.rows" :key="row.key">
              <button v-if="row.dir" class="change directory" :style="{ paddingLeft: 12 + row.depth * 12 + 'px' }" :aria-expanded="!closed.has(g.key + ':' + row.key)" @click="toggle(g.key + ':' + row.key)"><Icon class="fold-icon" name="chevron" :size="14" :class="{ open: !closed.has(g.key + ':' + row.key) }" /><Icon name="folder" :size="16" /><span class="ellipsis">{{ row.name }}</span></button>
              <button v-else class="change" :class="'git-' + row.entry.code" :style="{ paddingLeft: 12 + row.depth * 12 + 'px' }" :title="`${statusNames[row.entry.code] || '已修改'} · ${row.entry.path}${row.entry.oldPath ? '\n原路径：' + row.entry.oldPath : ''}${row.entry.sub?.startsWith('S') ? '\n子模块' : ''}`" @click="open(row.entry, g)" @contextmenu.prevent.stop="context($event, row.entry, g)">
                <span v-if="tree" class="fold-spacer" aria-hidden="true" />
                <Icon :name="iconOf(row.entry.path)" :size="16" />
                <span class="ellipsis filename">{{ base(row.entry.path) }}</span>
                <span v-if="!tree" class="ellipsis parent">{{ parent(row.entry.path) }}</span>
                <span v-if="row.entry.oldPath" class="rename" :title="row.entry.oldPath + ' → ' + row.entry.path">← {{ base(row.entry.oldPath) }}</span>
                <span class="grow" /><span class="git-badge">{{ row.entry.code }}</span>
              </button>
            </template>
          </template>
        </section>
      </div>
    </template>
    <div v-else-if="G.loading && !G.data" class="git-message">正在读取 Git 状态…</div>
  </div>
</template>

<style scoped>
.git-changes { flex: none; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.branch { flex: none; display: flex; align-items: center; gap: 7px; padding: 6px 12px; color: var(--text-2); font-size: var(--fs-sm); }
.branch-symbol { color: var(--text-2); }
.total { flex: none; border-radius: var(--r-pill); padding: 0 6px; background: var(--active); font-size: var(--fs-xs); color: var(--text-2); }
.layout { display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; background: transparent; border: 0; border-radius: var(--r-sm); color: var(--text-3); cursor: pointer; }
.layout:hover { background: var(--active); }
.changes-list { flex: 1; min-height: 0; overflow: auto; padding: 0 6px 6px; }
.group, .change { display: flex; align-items: center; gap: 6px; width: 100%; border: 0; background: transparent; text-align: left; cursor: pointer; border-radius: var(--r-sm); color: var(--text-2); font: inherit; }
.group { padding: 5px 8px; font-size: var(--fs-xs); font-weight: 600; }
.change { min-height: 27px; padding: 3px 9px; font-size: var(--fs-sm); }
.change:hover, .group:hover { background: var(--active); }
.change svg { flex: none; color: var(--text-2); }
.fold-icon { color: var(--text-3); transition: transform 0.15s; }
.change .fold-icon { color: var(--text-3); }
.fold-icon.open { transform: rotate(90deg); }
.fold-spacer { width: 14px; flex: none; }
.filename { flex-shrink: 0; max-width: 65%; }.parent { font-size: var(--fs-xs); color: var(--text-3); }.rename { font-size: var(--fs-xs); max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .8; }
.directory { color: var(--text-2); }
.clean, .git-message, .git-error { padding: 6px 14px 10px; font-size: var(--fs-xs); color: var(--text-3); }
.git-error { color: var(--warn); overflow-wrap: anywhere; }
</style>
