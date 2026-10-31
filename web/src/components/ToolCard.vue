<script setup>
import { computed, ref, watch } from 'vue';
import { S, openFile } from '../store.js';
import { UI } from '../settings.js';
import { toolSummary, toolPath, textOf, imagesOf, stripAnsi, isAbsPath, joinPath } from '../util.js';

const props = defineProps({ call: Object, exec: Object, streaming: Boolean });

const status = computed(() => props.exec?.status || (props.streaming ? 'pending' : 'unknown'));
const open = ref(UI.toolsOpen);
// 出错时自动展开，方便看原因
watch(
  status,
  (s) => {
    if (s === 'error') open.value = true;
  },
  { immediate: true },
);

const args = computed(() => {
  const a = props.call.arguments;
  if (a && Object.keys(a).length) return a;
  return props.exec?.args || a || {};
});
const summary = computed(() => {
  const s = toolSummary(args.value);
  if (s) return s.split('\n')[0];
  return props.call._raw ? props.call._raw.slice(-120) : '';
});
const path = computed(() => toolPath(args.value));

const result = computed(() => props.exec?.result || props.exec?.partial || null);
const resultText = computed(() => stripAnsi(textOf(result.value?.content)).replace(/\r\n/g, '\n'));
const resultImages = computed(() => imagesOf(result.value?.content));
const preview = computed(() => {
  if (status.value !== 'running' || !resultText.value) return '';
  return resultText.value.trimEnd().split('\n').slice(-6).join('\n');
});

// edit 工具：画个简单的 diff
const edits = computed(() => {
  const a = args.value;
  if (Array.isArray(a.edits)) return a.edits.filter((e) => e && (e.oldText != null || e.newText != null));
  if (a.oldText != null || a.newText != null) return [{ oldText: a.oldText, newText: a.newText }];
  if (a.old_string != null || a.new_string != null) return [{ oldText: a.old_string, newText: a.new_string }];
  return null;
});
const writeContent = computed(() => (typeof args.value.content === 'string' && !edits.value ? args.value.content : null));
const showArgs = computed(() => {
  if (edits.value || writeContent.value != null) return null;
  const keys = Object.keys(args.value);
  if (!keys.length) return props.call._raw || null;
  const s = toolSummary(args.value);
  if (keys.length === 1 && typeof args.value[keys[0]] === 'string' && args.value[keys[0]] === s && !s.includes('\n')) return null;
  return JSON.stringify(args.value, null, 2);
});
const lines = (t) => (t ?? '').replace(/\r\n/g, '\n').split('\n');

const LIMIT = 400;
const showAll = ref(false);
const shownResult = computed(() => {
  const ls = resultText.value.split('\n');
  if (showAll.value || ls.length <= LIMIT) return resultText.value;
  return ls.slice(0, LIMIT).join('\n');
});
const hiddenLines = computed(() => Math.max(0, resultText.value.split('\n').length - LIMIT));

function openPath() {
  const p = path.value;
  if (p) openFile(isAbsPath(p) ? p : joinPath(S.cwd, p, S.info.sep));
}
const dur = computed(() => {
  const ms = props.exec?.durationMs;
  if (ms == null) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
});
</script>

<template>
  <div class="tool" :class="[status, { open }]">
    <div class="head" @click="open = !open">
      <span class="st">
        <span v-if="status === 'running' || status === 'pending'" class="spin" />
        <svg v-else-if="status === 'done'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        <svg v-else-if="status === 'error'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        <span v-else class="dot" />
      </span>
      <span class="name">{{ call.name }}</span>
      <span class="ellipsis grow sum" :title="summary">
        <a v-if="path" href="#" @click.prevent.stop="openPath">{{ summary }}</a>
        <template v-else>{{ summary }}</template>
      </span>
      <span v-if="dur" class="dur">{{ dur }}</span>
      <svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6l6 6-6 6" /></svg>
    </div>
    <pre v-if="!open && preview" class="out preview">{{ preview }}</pre>
    <div v-if="open" class="body">
      <div v-if="edits" class="diff">
        <template v-for="(e, i) in edits" :key="i">
          <div v-if="i" class="hunk-sep" />
          <div v-for="(l, j) in lines(e.oldText)" :key="'o' + j" class="del">- {{ l }}</div>
          <div v-for="(l, j) in lines(e.newText)" :key="'n' + j" class="add">+ {{ l }}</div>
        </template>
      </div>
      <pre v-else-if="writeContent != null" class="out args">{{ writeContent }}</pre>
      <pre v-else-if="showArgs" class="out args">{{ showArgs }}</pre>
      <template v-if="result">
        <pre v-if="resultText" class="out" :class="{ errout: status === 'error' }">{{ shownResult }}</pre>
        <div v-if="hiddenLines && !showAll" class="more">
          <button class="btn sm flat" @click="showAll = true">还有 {{ hiddenLines }} 行，全部显示</button>
        </div>
        <div v-if="resultImages.length" class="imgs">
          <img v-for="(im, i) in resultImages" :key="i" :src="`data:${im.mimeType};base64,${im.data}`" />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tool { align-self: stretch; border: 1px solid var(--line); background: var(--panel); border-radius: var(--r-md); overflow: hidden; font-size: var(--fs-sm); transition: border-color 0.15s; }
.tool:hover { border-color: color-mix(in srgb, var(--text-3) 50%, var(--line)); }
.tool.error { border-color: color-mix(in srgb, var(--err) 40%, transparent); }
.head { display: flex; align-items: center; gap: 8px; padding: 7px 12px; cursor: pointer; user-select: none; }
.head:hover { background: var(--hover); }
.st { width: 18px; height: 18px; flex: none; display: inline-flex; align-items: center; justify-content: center; }
.done .st { color: var(--ok); }
.error .st { color: var(--err); }
.st .spin { width: 11px; height: 11px; }
.name { flex: none; font-family: var(--font-code); font-size: var(--fs-xs); background: var(--accent-soft); color: var(--accent-text); padding: 1px 8px; border-radius: 6px; }
.sum { color: var(--text-2); font-family: var(--font-code); font-size: var(--fs-sm); }
.sum a { color: var(--text-2); text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; }
.sum a:hover { color: var(--accent-text); text-decoration-color: currentColor; }
.dur { color: var(--text-3); font-size: var(--fs-xs); flex: none; }
.chev { color: var(--text-3); flex: none; transition: transform 0.15s; }
.open .chev { transform: rotate(90deg); }
.out { margin: 0; padding: 10px 14px; max-height: 380px; overflow: auto; white-space: pre-wrap; word-break: break-all; font-size: var(--fs-code); font-family: var(--font-code); line-height: 1.55; border-top: 1px solid var(--line-2); background: var(--code-bg); }
.out.args { background: var(--panel-2); }
.out.preview { max-height: none; color: var(--text-3); }
.errout { color: var(--err); }
.diff { font-size: var(--fs-code); font-family: var(--font-code); line-height: 1.55; max-height: 440px; overflow: auto; border-top: 1px solid var(--line-2); padding: 6px 0; background: var(--code-bg); }
.diff > div { white-space: pre-wrap; word-break: break-all; padding: 0 14px; }
.hunk-sep { height: 1px; background: var(--line); margin: 6px 0; padding: 0 !important; }
.del { background: var(--del-bg); color: var(--del-fg); }
.add { background: var(--add-bg); color: var(--add-fg); }
.more { padding: 4px 10px; border-top: 1px solid var(--line-2); }
.imgs { padding: 10px 14px; border-top: 1px solid var(--line-2); }
.imgs img { max-width: 100%; max-height: 320px; border-radius: 6px; }
</style>
