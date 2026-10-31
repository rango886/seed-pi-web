<script setup>
import { ref, watch, nextTick } from 'vue';
import { S, openDir } from '../store.js';
import { http } from '../api.js';
import { relTime } from '../util.js';
const path = ref('');
const list = ref({ path: '', parent: null, entries: [] });
const error = ref('');
const recent = ref([]);
const filter = ref('');
const input = ref(null);

async function browse(p) {
  try {
    const d = await http.get('/api/fs/list', { path: p, dirsOnly: 1 });
    list.value = d;
    path.value = d.path;
    filter.value = '';
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
}

watch(
  () => S.dirPicker,
  async (v) => {
    if (!v) return;
    browse(S.cwd || S.info.home);
    recent.value = await http.get('/api/recent-dirs').catch(() => []);
    nextTick(() => input.value?.focus());
  },
);

function go(p) {
  S.dirPicker = false;
  openDir(p);
}
const shown = () => list.value.entries.filter((e) => !filter.value || e.name.toLowerCase().includes(filter.value.toLowerCase()));
const base = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
function onKey(e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    S.dirPicker = false;
  }
}
</script>

<template>
  <div v-if="S.dirPicker" class="modal-mask" @mousedown.self="S.dirPicker = false" @keydown="onKey">
    <div class="modal dirs">
      <div class="modal-title">切换工作目录</div>
      <div class="modal-body">
        <div class="row">
          <input ref="input" v-model="path" class="input grow" placeholder="输入路径后回车" @keydown.enter="browse(path)" />
          <button class="btn primary" @click="go(path)">打开这个目录</button>
        </div>
        <div v-if="error" class="err">{{ error }}</div>
        <div class="cols">
          <div class="col">
            <div class="head dim">运行中的 pi</div>
            <div v-for="a in S.agents" :key="a.id" class="sel" :title="a.cwd" @click="go(a.cwd)">
              <span class="dot" :class="a.running ? 'busy' : 'on'" />
              <span class="ellipsis">{{ base(a.cwd) }}</span>
            </div>
            <div v-if="!S.agents.length" class="dim pad">无</div>
            <div class="head dim">最近使用</div>
            <div v-for="r in recent" :key="r.cwd" class="sel" :title="r.cwd" @click="go(r.cwd)">
              <span class="ellipsis grow">{{ base(r.cwd) }}</span>
              <span class="dim small">{{ relTime(r.modified) }}</span>
            </div>
          </div>
          <div class="col browser">
            <div class="row head">
              <input v-model="filter" class="input grow" placeholder="过滤子目录" />
            </div>
            <div class="items">
              <div v-if="list.parent" class="sel" @click="browse(list.parent)">..</div>
              <div v-for="e in shown()" :key="e.name" class="sel" @click="browse(list.path + list.sep + e.name)" @dblclick="go(list.path + list.sep + e.name)">
                <span class="d ellipsis" :class="{ dim: e.name.startsWith('.') }">{{ e.name }}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="dim small">单击进入子目录，双击直接打开。每个目录有自己的 pi 进程，切走后原来的会在后台继续运行。</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dirs { width: 780px; }
.modal-body { padding-bottom: 18px; }
.cols { display: flex; gap: 10px; height: 46vh; }
.col { border: 1px solid var(--line); border-radius: var(--r-md); background: var(--panel); overflow: auto; width: 240px; flex: none; padding: 4px; }
.browser { flex: 1; width: auto; display: flex; flex-direction: column; }
.items { flex: 1; overflow: auto; }
.head { padding: 8px 8px 4px; font-size: var(--fs-xs); }
.browser .head { padding: 4px; }
.d { color: var(--text); }
.small { font-size: var(--fs-xs); white-space: nowrap; }
.pad { padding: 4px 10px; font-size: var(--fs-sm); }
@media (max-width: 768px) {
  .cols { flex-direction: column; height: 58vh; }
  .col { width: auto; flex: 0 0 34%; }
  .browser { flex: 1; }
}
</style>
