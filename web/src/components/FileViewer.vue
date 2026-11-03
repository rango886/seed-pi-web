<script setup>
import { computed, ref, watch, nextTick } from 'vue';
import { loadFile, attachFromTree } from '../store.js';
import { openLightbox } from '../settings.js';
import { rawUrl } from '../api.js';
import { highlightFile, renderMarkdown, IMAGE_EXT, fmtSize, mediaKind } from '../util.js';

const props = defineProps({ tab: Object });
const isImage = computed(() => IMAGE_EXT.test(props.tab.path));
// 音视频直接用浏览器自己的播放器（地址走 /api/fs/raw，支持拖进度条）
const media = computed(() => mediaKind(props.tab.path));
const isMd = computed(() => /\.(md|markdown)$/i.test(props.tab.path));
const preview = ref(true);
const d = computed(() => props.tab.data);
// markdown 预览里的相对图片（`![](img/a.png)`）按这个文件所在的目录找
const baseDir = computed(() => String(props.tab.path || '').replace(/[\\/][^\\/]*$/, ''));
// 只有真要显示源码时才高亮（markdown 预览、图片都用不上，大文件高亮一次要好几十毫秒）
const showCode = computed(() => !!d.value && !d.value.binary && !isImage.value && !media.value && !(isMd.value && preview.value));
const html = computed(() => (showCode.value ? highlightFile(props.tab.name, d.value.text) : ''));
const lineCount = computed(() => (d.value?.text ? d.value.text.split('\n').length : 0));
const gutter = computed(() => (showCode.value ? Array.from({ length: lineCount.value }, (_, i) => i + 1).join('\n') : ''));
// 点图片全屏看。预览里有多张就只在这份文件里的图之间翻（灯箱本身不挑来源）
function zoomImage(e) {
  const img = e.target.closest?.('img');
  if (!img) return;
  e.preventDefault();
  const all = [...e.currentTarget.querySelectorAll('img')].filter((el) => el.complete && el.naturalWidth > 0);
  const i = all.indexOf(img);
  if (i < 0) return;
  openLightbox(
    all.map((el) => ({ src: el.currentSrc || el.src, alt: el.alt || '' })),
    i,
  );
}
const size = computed(() => fmtSize(d.value?.size ?? 0));

// 从回复里点 a.js:12 打开：滚到那一行并高亮一下
const contentEl = ref(null);
const srcEl = ref(null);
const hlTop = ref(-1);
watch(
  () => [props.tab.jump, showCode.value, html.value],
  async () => {
    const line = props.tab.line;
    if (!line || !showCode.value) return (hlTop.value = -1);
    await nextTick();
    const pre = srcEl.value;
    const box = contentEl.value;
    if (!pre || !box) return;
    const cs = getComputedStyle(pre);
    const lh = parseFloat(cs.lineHeight) || 20;
    const top = parseFloat(cs.paddingTop) + (Math.min(line, lineCount.value) - 1) * lh;
    hlTop.value = top;
    box.scrollTop = Math.max(0, top - box.clientHeight / 3);
  },
  { immediate: true },
);
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
    <div ref="contentEl" class="content">
      <div v-if="tab.loading && !d" class="dim pad">加载中…</div>
      <div v-else-if="tab.error" class="err pad">{{ tab.error }}</div>
      <div v-else-if="isImage" class="img" @click="zoomImage"><img :src="rawUrl(tab.path) + '&t=' + (d?.mtime || 0)" alt="" /></div>
      <div v-else-if="media" :key="tab.path + (d?.mtime || 0)" class="img media-box">
        <!-- 套一层 .md-media，由 media.js 接管成自绘播放器（整个块按文件 + 修改时间重建，不跟 Vue 的补丁打架） -->
        <span class="md-media">
          <video v-if="media === 'video'" :src="rawUrl(tab.path) + '&t=' + (d?.mtime || 0)" :data-name="tab.name" preload="metadata" playsinline />
          <audio v-else :src="rawUrl(tab.path) + '&t=' + (d?.mtime || 0)" :data-name="tab.name" preload="metadata" />
        </span>
      </div>
      <div v-else-if="d?.binary" class="dim pad">二进制文件，不显示内容</div>
      <div v-else-if="isMd && preview" class="md pad mdview" v-html="renderMarkdown(d?.text, baseDir)" @click="zoomImage" />
      <div v-else-if="d" class="code">
        <pre class="gutter">{{ gutter }}</pre>
        <div class="src-wrap">
          <div v-if="hlTop >= 0" :key="tab.jump" class="line-hl" :style="{ top: hlTop + 'px' }" />
          <pre ref="srcEl" class="src hljs" v-html="html" />
        </div>
      </div>
      <div v-if="d?.truncated && !isImage && !media" class="warn pad">文件太大，只显示了前 2MB</div>
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
/* 图片：直接放在面板底色上居中，不铺棋盘格 */
.img { padding: 16px; min-height: 100%; display: flex; align-items: center; justify-content: center; }
.img img { display: block; max-width: 100%; max-height: calc(100vh - 160px); object-fit: contain; border-radius: var(--r-md); cursor: zoom-in; }
/* 标签页里地方大，视频可以比对话里高不少；音频卡片宽一点 */
.media-box :deep(.mp-video video) { max-height: calc(100vh - 200px); }
.media-box :deep(.mp-audio) { width: min(100%, 560px); }
.code { display: flex; min-width: max-content; font-family: var(--font-code); font-size: var(--fs-code); line-height: 1.6; }
.gutter { margin: 0; padding: 10px 12px 10px 14px; text-align: right; color: var(--text-3); background: var(--panel-2); border-right: 1px solid var(--line); user-select: none; position: sticky; left: 0; z-index: 1; font: inherit; }
.src-wrap { position: relative; flex: 1; }
.src { position: relative; margin: 0; padding: 10px 16px; white-space: pre; font: inherit; }
/* 跳转到的那一行：淡淡的强调色底，过两秒淡掉一些 */
.line-hl { position: absolute; left: 0; right: 0; height: 1.6em; background: var(--accent-soft); animation: hl 2.4s ease-out forwards; pointer-events: none; }
@keyframes hl { 0%, 40% { opacity: 1; } 100% { opacity: 0.45; } }
</style>
