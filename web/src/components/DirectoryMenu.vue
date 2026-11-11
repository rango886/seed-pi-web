<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue';
import { S, newSessionIn, chooseDirectory, openDirPicker } from '../store.js';
import { http } from '../api.js';
import { baseName, normPath } from '../util.js';
import Icon from './Icon.vue';

// variant：side = 侧栏里带文字的按钮；icon = 顶栏那种 30px 图标按钮
// mode：new = 选完目录直接新建会话；compose = 输入前换目录（保留草稿）
const props = defineProps({ mode: { type: String, default: 'new' }, variant: { type: String, default: 'side' } });
const emit = defineEmits(['select']);
const trigger = ref(null);
const panel = ref(null);
const opened = ref(false);
const recent = ref([]);
const loading = ref(false);
const error = ref(false);
const position = ref({});
let request = 0;
// 新建模式下，当前目录由旁边的「新会话」按钮负责，这里只列别的目录
const showCurrent = computed(() => props.mode !== 'new');
const favorites = computed(() => S.favorites.filter((p) => normPath(p) !== normPath(S.cwd)));
const recentDirs = computed(() => {
  const seen = new Set([S.cwd, ...S.favorites].filter(Boolean).map(normPath));
  return recent.value.filter(({ cwd }) => {
    if (!cwd || seen.has(normPath(cwd))) return false;
    seen.add(normPath(cwd));
    return true;
  }).slice(0, 8);
});
function close(focus = false) {
  opened.value = false;
  request++;
  if (focus) trigger.value?.focus();
}
async function align() {
  await nextTick();
  if (!opened.value || !panel.value) return;
  const r = trigger.value.getBoundingClientRect();
  const h = panel.value.offsetHeight;
  const below = window.innerHeight - r.bottom - 12;
  const above = r.top - 12;
  const up = below < h && above > below;
  position.value = {
    left: Math.max(8, Math.min(r.left, window.innerWidth - panel.value.offsetWidth - 8)) + 'px',
    top: (up ? Math.max(8, r.top - Math.min(h, above) - 4) : r.bottom + 4) + 'px',
    maxHeight: Math.max(100, up ? above : below) + 'px',
  };
}
function toggle() {
  if (opened.value) close();
  else open();
}
async function open() {
  if (props.variant === 'side') return browse();
  if (opened.value) {
    panel.value?.querySelector('button')?.focus();
    return;
  }
  opened.value = true;
  loading.value = true;
  error.value = false;
  await align();
  panel.value?.querySelector('button')?.focus();
  const id = ++request;
  try {
    const rows = await http.get('/api/recent-dirs');
    if (id === request) recent.value = rows;
  } catch {
    if (id === request) error.value = true;
  } finally {
    if (id === request) {
      loading.value = false;
      align();
    }
  }
}
defineExpose({ open });

function pick(cwd) {
  close();
  if (props.mode === 'new') newSessionIn(cwd);
  else chooseDirectory(cwd);
  emit('select');
}
function browse() {
  close();
  openDirPicker(props.mode === 'new' ? 'new' : 'compose');
  emit('select');
}
function keydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    close(true);
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
    e.preventDefault();
    const buttons = [...panel.value.querySelectorAll('button')];
    const i = buttons.indexOf(document.activeElement);
    const index = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[index]?.focus();
  }
}
function outside(e) {
  if (opened.value && !panel.value?.contains(e.target) && !trigger.value?.contains(e.target)) close();
}
const dismiss = () => close();
onMounted(() => {
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('resize', dismiss);
  window.addEventListener('blur', dismiss);
});
onUnmounted(() => {
  request++;
  document.removeEventListener('pointerdown', outside, true);
  window.removeEventListener('resize', dismiss);
  window.removeEventListener('blur', dismiss);
});
</script>

<template>
  <button ref="trigger" type="button" class="directory-trigger" :class="[variant, { on: opened }]" title="选择其他目录并新建会话 (Alt+Shift+N)" aria-haspopup="dialog" :aria-expanded="opened" aria-label="选择目录新建会话" @click="toggle">
    <Icon name="folderplus" :size="variant === 'side' ? 16 : 18" />
    <span v-if="variant === 'side'" class="ellipsis">其他</span>
  </button>
  <Teleport to="body">
    <div v-if="opened" ref="panel" class="directory-menu" :style="position" role="dialog" :aria-label="mode === 'new' ? '选择目录并新建会话' : '选择工作目录'" @keydown="keydown">
      <div v-if="mode === 'compose' && S.messages.length" class="notice">选择其他目录会开始新会话，原对话保留。</div>
      <template v-if="showCurrent">
      <div class="section">当前</div>
      <button v-if="S.cwd" type="button" class="entry current" :title="S.cwd" @click="pick(S.cwd)"><Icon name="folder" :size="15" /><span class="entry-text"><b>{{ baseName(S.cwd) || S.cwd }}</b><small>{{ S.cwd }}</small></span><span>✓</span></button>
      <div v-else class="empty-row">尚未选择目录</div>
      </template>
      <div class="section">收藏</div>
      <button v-for="p in favorites" :key="p" type="button" class="entry" :title="p" @click="pick(p)"><Icon name="folder" :size="15" /><span class="entry-text"><b>{{ baseName(p) || p }}</b><small>{{ p }}</small></span></button>
      <div v-if="!favorites.length" class="empty-row">{{ S.favorites.length ? '收藏目录已在当前分组显示' : '暂无收藏目录' }}</div>
      <div class="section">最近</div>
      <button v-for="r in recentDirs" :key="r.cwd" type="button" class="entry" :title="r.cwd" @click="pick(r.cwd)"><Icon name="folder" :size="15" /><span class="entry-text"><b>{{ baseName(r.cwd) || r.cwd }}</b><small>{{ r.cwd }}</small></span></button>
      <div v-if="!recentDirs.length" class="empty-row">{{ loading ? '加载中…' : error ? '最近目录加载失败' : '暂无其他最近目录' }}</div>
      <div class="browse"><button type="button" class="entry" @click="browse"><Icon name="folder" :size="15" /><span>浏览其他目录…</span></button></div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 侧栏：和旁边的「新会话」、下面的搜索框同一套外观（白底细边、小圆角） */
.directory-trigger.side { flex: 1; min-width: 0; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 10px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--panel); color: var(--text-2); font-size: var(--fs-sm); cursor: pointer; transition: background 0.15s, border-color 0.15s, color 0.15s; }
.directory-trigger.side:hover, .directory-trigger.side.on { border-color: var(--accent); color: var(--accent-text); }
/* 顶栏：和顶栏其他图标按钮一样 */
.directory-trigger.icon { width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text-2); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.directory-trigger.icon:hover, .directory-trigger.icon.on { background: var(--active); color: var(--text); }
.directory-menu { position: fixed; z-index: 75; width: min(340px, calc(100vw - 16px)); overflow-y: auto; padding: 6px; background: var(--elev); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow-lg); color: var(--text); font-size: var(--fs-sm); }
.section { padding: 9px 8px 4px; color: var(--text-3); font-size: var(--fs-xs); }
.entry { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text); text-align: left; cursor: pointer; font: inherit; }
.entry:hover, .entry:focus-visible { background: var(--hover); outline: 2px solid var(--accent-soft); outline-offset: -2px; }
.entry.current { color: var(--accent-text); }
.entry-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.entry-text b { font-weight: 500; }
.entry-text b, .entry-text small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.entry-text small, .empty-row, .notice { color: var(--text-3); font-size: var(--fs-xs); }
.empty-row, .notice { padding: 6px 8px; }
.browse { border-top: 1px solid var(--line); margin-top: 6px; padding-top: 5px; }
</style>
