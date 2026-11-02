<script setup>
import { computed, ref } from 'vue';
import { loadFile, attachFromTree } from '../store.js';
import { rawUrl } from '../api.js';
import { highlightFile, renderMarkdown, IMAGE_EXT } from '../util.js';

const props = defineProps({ tab: Object });
const isImage = computed(() => IMAGE_EXT.test(props.tab.path));
const isMd = computed(() => /\.(md|markdown)$/i.test(props.tab.path));
const preview = ref(true);
const d = computed(() => props.tab.data);
const html = computed(() => (d.value && !d.value.binary ? highlightFile(props.tab.name, d.value.text) : ''));
const lineCount = computed(() => (d.value?.text ? d.value.text.split('\n').length : 0));
const size = computed(() => {
  const s = d.value?.size ?? 0;
  return s < 1024 ? `${s} B` : s < 1048576 ? `${(s / 1024).toFixed(1)} KB` : `${(s / 1048576).toFixed(1)} MB`;
});
</script>

<template>
  <div class="viewer">
    <div class="bar row">
      <span class="ellipsis grow" :title="tab.path">{{ tab.path }}</span>
      <span v-if="d" class="dim">{{ size }}<template v-if="lineCount"> · {{ lineCount }} 行</template></span>
      <label v-if="isMd" class="row chk"><input v-model="preview" type="checkbox" />预览</label>
      <button class="btn sm" title="把这个文件加到输入框的附件里" @click="attachFromTree(tab.path)">@ 引用</button>
      <button class="btn sm" @click="loadFile(tab)">刷新</button>
    </div>
    <div class="content">
      <div v-if="tab.loading && !d" class="dim pad">加载中…</div>
      <div v-else-if="tab.error" class="err pad">{{ tab.error }}</div>
      <div v-else-if="isImage" class="img"><img :src="rawUrl(tab.path) + '&t=' + (d?.mtime || 0)" /></div>
      <div v-else-if="d?.binary" class="dim pad">二进制文件，不显示内容</div>
      <div v-else-if="isMd && preview" class="md pad mdview" v-html="renderMarkdown(d?.text)" />
      <div v-else-if="d" class="code">
        <pre class="gutter">{{ Array.from({ length: lineCount }, (_, i) => i + 1).join('\n') }}</pre>
        <pre class="src hljs" v-html="html" />
      </div>
      <div v-if="d?.truncated" class="warn pad">文件太大，只显示了前 2MB</div>
    </div>
  </div>
</template>

<style scoped>
.viewer { flex: 1; display: flex; flex-direction: column; min-height: 0; background: var(--panel); }
.bar { padding: 8px 14px; border-bottom: 1px solid var(--line); font-size: var(--fs-sm); min-height: 46px; color: var(--text-2); }
.chk { gap: 6px; cursor: pointer; }
.chk input { margin: 0; accent-color: var(--accent); }
.content { flex: 1; overflow: auto; background: var(--panel); }
.pad { padding: 16px 24px; }
.mdview { max-width: 900px; margin: 0 auto; line-height: var(--lh); }
.img { padding: 16px; background: repeating-conic-gradient(var(--line-2) 0 25%, var(--panel) 0 50%) 0 0 / 16px 16px; min-height: 100%; }
.img img { max-width: 100%; border-radius: var(--r-sm); }
.code { display: flex; min-width: max-content; font-family: var(--font-code); font-size: var(--fs-code); line-height: 1.6; }
.gutter { margin: 0; padding: 10px 12px 10px 14px; text-align: right; color: var(--text-3); background: var(--panel-2); border-right: 1px solid var(--line); user-select: none; position: sticky; left: 0; font: inherit; }
.src { margin: 0; padding: 10px 16px; white-space: pre; font: inherit; }
</style>
