<script setup>
import { computed, watch } from 'vue';
import { S, openFile } from '../store.js';
import { UI } from '../settings.js';
import { useBlockDisplay } from '../block-display.js';
import { toolSummary, toolPath, textOf, imagesOf, imageSrc, stripAnsi, isAbsPath, joinPath } from '../util.js';

const props = defineProps({ call: Object, exec: Object, streaming: Boolean });
const status = computed(() => props.exec?.status || (props.streaming ? 'pending' : 'unknown'));
const { local, open, toggle, expand } = useBlockDisplay(() => UI.toolsDisplay);
// 错误不埋在折叠里；手动收起后，不再被后续流式更新撑开。
watch(status, (s) => {
  if (s === 'error' && local.value === null) expand();
}, { immediate: true });

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
const diffLines = computed(() => (edits.value || []).flatMap((e, i) => [
  ...(i ? [{ kind: 'hunk-sep', text: '' }] : []),
  ...lines(e.oldText).map((l) => ({ kind: 'del', text: '- ' + l })),
  ...lines(e.newText).map((l) => ({ kind: 'add', text: '+ ' + l })),
]));
const argText = computed(() => writeContent.value ?? showArgs.value ?? '');
// 和原来的控件一样：运行中收起时显示最新几行，完成后只留头部摘要。
const preview = computed(() => status.value === 'running' ? resultText.value.split('\n').slice(-6).join('\n') : '');
const hasBody = computed(() => !!(diffLines.value.length || argText.value || resultText.value || resultImages.value.length));
const statusLabel = computed(() => ({ pending: '等待中', running: '执行中', success: '完成', error: '失败', unknown: '' })[status.value] || '');
const dur = computed(() => {
  const ms = props.exec?.durationMs;
  if (ms == null) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
});
function openPath() {
  const p = path.value;
  if (p) openFile(isAbsPath(p) ? p : joinPath(S.cwd, p, S.info.sep));
}
</script>

<template>
  <div class="blk tool-execution" :class="[status, { open }]">
    <div class="blk-head" role="button" tabindex="0" :aria-expanded="open" @click="toggle" @keydown.enter.self.prevent="toggle" @keydown.space.self.prevent="toggle">
      <span class="blk-chip">{{ call.name }}</span>
      <span class="ellipsis grow blk-sum" :title="summary">
        <a v-if="path" href="#" @click.prevent.stop="openPath">{{ summary }}</a>
        <template v-else>{{ summary }}</template>
      </span>
      <span v-if="status === 'running' || status === 'pending'" class="spin" />
      <span class="blk-meta" :class="{ err: status === 'error' }">{{ statusLabel }}</span>
      <span v-if="dur" class="blk-meta">{{ dur }}</span>
      <svg class="blk-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6l6 6-6 6" /></svg>
    </div>
    <pre v-if="!open && preview" class="blk-body out preview">{{ preview }}</pre>
    <div v-if="open && hasBody" class="body">
      <div v-if="edits" class="blk-body diff">
        <div v-for="(line, i) in diffLines" :key="i" :class="line.kind">{{ line.text }}</div>
      </div>
      <pre v-else-if="argText" class="blk-body out args">{{ argText }}</pre>
      <pre v-if="resultText" class="blk-body out" :class="{ errout: status === 'error' }">{{ resultText }}</pre>
      <div v-if="resultImages.length" class="imgs">
        <img v-for="(im, i) in resultImages" :key="i" :src="imageSrc(im)" alt="工具返回的图片" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.error .blk-chip { color: var(--err); }
.blk-sum a { color: var(--text-2); text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; }
.blk-sum a:hover { color: var(--accent-text); text-decoration-color: currentColor; }
.out.args { background: var(--panel-2); }
.errout { color: var(--err); }
.body { max-height: min(440px, 50vh); overflow: auto; overscroll-behavior: contain; }
.blk-body { max-height: none; }
.out.preview { color: var(--text-3); }
.diff { padding: 6px 0; }
.diff > div { white-space: pre-wrap; word-break: break-word; padding: 0 var(--pad-x); }
.hunk-sep { height: 1px; background: var(--line); margin: 6px 0; padding: 0 !important; }
.del { background: var(--del-bg); color: var(--del-fg); }
.add { background: var(--add-bg); color: var(--add-fg); }
.imgs { padding: var(--sp2) var(--pad-x); }
.imgs img { max-width: 100%; max-height: min(320px, 40vh); width: auto; height: auto; object-fit: contain; border-radius: var(--r-md); cursor: zoom-in; }
</style>
