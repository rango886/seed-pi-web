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
const resultText = computed(() => stripAnsi(textOf(result.value?.content)).replace(/\r\n/g, '\n').replace(/\s+$/, ''));
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
  <div class="blk" :class="[status, { open }]">
    <div class="blk-head" @click="open = !open">
      <span class="blk-chip">{{ call.name }}</span>
      <span class="ellipsis grow blk-sum" :title="summary">
        <a v-if="path" href="#" @click.prevent.stop="openPath">{{ summary }}</a>
        <template v-else>{{ summary }}</template>
      </span>
      <span v-if="dur" class="blk-meta">{{ dur }}</span>
      <svg class="blk-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6l6 6-6 6" /></svg>
    </div>
    <pre v-if="!open && preview" class="blk-body out preview">{{ preview }}</pre>
    <div v-if="open" class="body">
      <div v-if="edits" class="blk-body diff">
        <template v-for="(e, i) in edits" :key="i">
          <div v-if="i" class="hunk-sep" />
          <div v-for="(l, j) in lines(e.oldText)" :key="'o' + j" class="del">- {{ l }}</div>
          <div v-for="(l, j) in lines(e.newText)" :key="'n' + j" class="add">+ {{ l }}</div>
        </template>
      </div>
      <pre v-else-if="writeContent != null" class="blk-body out args">{{ writeContent }}</pre>
      <pre v-else-if="showArgs" class="blk-body out args">{{ showArgs }}</pre>
      <template v-if="result">
        <pre v-if="resultText" class="blk-body out" :class="{ errout: status === 'error' }">{{ shownResult }}</pre>
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
/* 卡片框、头部、展开箭头的样式在 style.css 的 .blk-* 里，这里只管工具特有的部分 */
/* 出错：已经没有卡片边框可以染红了，把工具名和输出的头一行标红 */
.error .blk-chip { color: var(--err); }
.blk-sum a { color: var(--text-2); text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; }
.blk-sum a:hover { color: var(--accent-text); text-decoration-color: currentColor; }
.out.preview { max-height: none; color: var(--text-3); }
.out.args { background: var(--panel-2); }
.errout { color: var(--err); }
.diff { padding: 6px 0; max-height: 440px; }
.diff > div { white-space: pre-wrap; word-break: break-all; padding: 0 var(--pad-x); }
.hunk-sep { height: 1px; background: var(--line); margin: 6px 0; padding: 0 !important; }
.del { background: var(--del-bg); color: var(--del-fg); }
.add { background: var(--add-bg); color: var(--add-fg); }
.more { padding: 4px 10px; }
.imgs { padding: var(--sp2) var(--pad-x); }
.imgs img { max-width: 100%; max-height: 320px; border-radius: var(--r-sm); }
</style>
