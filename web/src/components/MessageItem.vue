<script setup>
import { computed, ref, watchEffect } from 'vue';
import { S, openFile } from '../store.js';
import { UI } from '../settings.js';
import { rawUrl } from '../api.js';
import { renderMarkdown, textOf, imagesOf, stripAnsi, fmtTokens, setMsgText, splitAttachments } from '../util.js';
import ToolCard from './ToolCard.vue';
import Icon from './Icon.vue';

const props = defineProps({ m: Object });
const role = computed(() => props.m.role);
const open = ref(false);

// 用户消息前面的 <attachments> 块：不显示原文，还原成和输入框上一样的附件
const userParts = computed(() => splitAttachments(textOf(props.m.content)));
const userText = computed(() => userParts.value.text);
const atts = computed(() => userParts.value.attachments);
const broken = ref({}); // 文件已经不在的图片，缩略图换成图标
const attTitle = (a) => `${a.path}\n${a.kind === 'dir' ? '点击不会打开目录' : '点击打开'}`;
const openAtt = (a) => a.kind !== 'dir' && openFile(a.path);
const images = computed(() => imagesOf(props.m.content));
const blocks = computed(() => (Array.isArray(props.m.content) ? props.m.content.filter(Boolean) : []));
// 空内容的思考块直接不画（有的模型只会发一个空的 thinking 块，比如 opus 系列），
// 留个空框在那里没意义，还占地方
const showThinking = (b) => b.type === 'thinking' && (!!b.redacted || !!(b.thinking || '').trim());
const streaming = computed(() => props.m.stopReason === 'pending');
// 消息的时间：今天只显示 HH:MM，不是今天的再带上月/日
const clock = (t) => {
  const d = new Date(typeof t === 'number' ? t : Date.parse(t || ''));
  if (isNaN(d.getTime())) return '';
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};
const time = computed(() => clock(props.m.timestamp));
const meta = computed(() => {
  const m = props.m;
  if (role.value !== 'assistant' || streaming.value) return '';
  const u = m.usage;
  return [m.model, u ? `↑${fmtTokens(u.input + (u.cacheRead || 0))} ↓${fmtTokens(u.output)}` : '', u?.cost?.total ? `$${u.cost.total.toFixed(4)}` : '', time.value]
    .filter(Boolean)
    .join(' · ');
});
const aiText = computed(() =>
  blocks.value
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n'),
);
// 折叠时的单行预览：把思考里的换行都抹平，只留一段（太长就交给 CSS 截断）
const thinkPrev = (b) => (b.thinking || '').trim().replace(/\s+/g, ' ').slice(0, 200);
const customText = computed(() => (typeof props.m.content === 'string' ? props.m.content : textOf(props.m.content)));
const copyText = computed(() => (role.value === 'user' ? userText.value : aiText.value));
// 右键菜单统一在 App 层弹，所以只能把文本先存下来，菜单里按 DOM 上的 key 回来取
watchEffect(() => setMsgText(props.m._k, copyText.value));
</script>

<template>
  <!-- 用户：靠右的气泡 -->
  <div v-if="role === 'user'" class="msg me" :data-msg="m._k" data-role="user">
    <div class="col">
      <div class="bubble me-bubble">
        <div v-if="atts.length" class="atts">
          <div v-for="a in atts" :key="a.n" class="att" :class="{ link: a.kind !== 'dir' }" :title="attTitle(a)" @click="openAtt(a)">
            <span class="no">{{ a.n }}</span>
            <img v-if="a.kind === 'image' && !broken[a.n]" class="pic" :src="rawUrl(a.path)" alt="" @error="broken[a.n] = true" />
            <span v-else class="fic"><Icon :name="a.kind === 'dir' ? 'folder' : 'file'" :size="14" /></span>
            <span class="aname ellipsis">{{ a.name }}</span>
          </div>
        </div>
        <div v-if="userText.trim()" class="pre">{{ userText }}</div>
        <div v-if="images.length" class="imgs">
          <img v-for="(im, i) in images" :key="i" :src="`data:${im.mimeType};base64,${im.data}`" />
        </div>
      </div>
      <!-- 消息底部的小字（模型/用量/时间）：默认不显示，右键菜单里手动打开才出现 -->
      <div v-if="UI.showMeta && time" class="meta">{{ time }}</div>
    </div>
  </div>

  <!-- 助手：靠左，直接铺在背景上（不带头像、没有气泡底），思考/工具是轻量的卡片 -->
  <div v-else-if="role === 'assistant'" class="msg ai" :data-msg="m._k" data-role="assistant">
    <div class="col">
      <template v-for="(b, i) in blocks" :key="i">
        <!-- 思考过程：和工具调用用同一套 .blk 卡片样式 -->
        <details v-if="showThinking(b)" class="blk" :open="UI.thinkingOpen || (streaming && i === blocks.length - 1)">
          <summary class="blk-head">
            <span class="blk-chip soft">Thinking{{ b.redacted ? ' (hidden)' : '' }}</span>
            <!-- 折叠时像工具调用那样在后面跟一行灰字预览；展开了由 CSS 藏起来，免得和下面的内容重复 -->
            <span v-if="thinkPrev(b)" class="ellipsis grow blk-sum think-prev" :title="thinkPrev(b)">{{ thinkPrev(b) }}</span>
            <span v-if="streaming && i === blocks.length - 1" class="spin" />
            <svg class="blk-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6l6 6-6 6" /></svg>
          </summary>
          <div class="blk-body prose dim">{{ (b.thinking || '').trim() }}</div>
        </details>
        <div v-else-if="b.type === 'text' && b.text" class="bubble ai-bubble md" :class="{ boxed: UI.hoverBox }" v-html="renderMarkdown(b.text)" />
        <ToolCard v-else-if="b.type === 'toolCall'" :call="b" :exec="S.tools[b.id]" :streaming="streaming" />
      </template>
      <div v-if="m.stopReason === 'error'" class="errbox">出错：{{ stripAnsi(m.errorMessage || '未知错误') }}</div>
      <div v-else-if="m.stopReason === 'aborted'" class="note-sm">已中断</div>
      <div v-else-if="m.stopReason === 'length'" class="note-sm warn">达到输出长度上限，回复被截断</div>
      <!-- 模型/token/价格/时间：默认不显示，右键菜单里手动打开才出现 -->
      <div v-if="UI.showMeta && meta" class="meta">{{ meta }}</div>
    </div>
  </div>

  <!-- ! 执行的 shell 命令 -->
  <div v-else-if="role === 'bashExecution'" class="card shell">
    <div class="card-head row">
      <span class="dollar">$</span>
      <span class="ellipsis grow mono">{{ m.command }}</span>
      <span v-if="m.running" class="spin" />
      <span v-else-if="m.cancelled" class="badge warn">已取消</span>
      <span v-else class="badge" :class="m.exitCode === 0 ? 'ok' : 'err'">exit {{ m.exitCode ?? '?' }}</span>
      <span v-if="m.excludeFromContext" class="badge">不进上下文</span>
    </div>
    <pre v-if="m.output" class="out">{{ stripAnsi(m.output).trimEnd() }}</pre>
  </div>

  <!-- 上下文压缩 / 分支摘要：像聊天软件里居中的系统提示 -->
  <div v-else-if="role === 'compactionSummary' || role === 'branchSummary'" class="sys">
    <button class="sys-pill" @click="open = !open">
      <span v-if="role === 'compactionSummary'">上下文已压缩 · 之前 {{ fmtTokens(m.tokensBefore) }} tokens</span>
      <span v-else>分支摘要</span>
      <span class="caret">{{ open ? '收起' : '查看' }}</span>
    </button>
    <div v-if="open" class="card sys-card md" v-html="renderMarkdown(m.summary)" />
  </div>

  <!-- 扩展插入的消息 -->
  <div v-else-if="role === 'custom'" v-show="m.display !== false" class="sys">
    <div class="card sys-card">
      <div class="sys-tag">{{ m.customType }}</div>
      <div class="md" v-html="renderMarkdown(customText)" />
    </div>
  </div>

  <!-- 不认识的消息类型：原样显示，保证 pi 新增类型时不会崩 -->
  <div v-else class="sys">
    <button class="sys-pill" @click="open = !open">
      <span>{{ role || '未知消息' }}</span><span class="caret">{{ open ? '收起' : '查看' }}</span>
    </button>
    <pre v-if="open" class="card sys-card out">{{ JSON.stringify(m, null, 2) }}</pre>
  </div>
</template>

<style scoped>
.msg { display: flex; margin: 0 0 var(--sp5); align-items: flex-start; position: relative; }
/* 助手回答直接铺在背景上，没有头像也没有气泡底；思考/工具是轻量卡片。
   卡片的左右内边距和正文一致（都是 --pad-x），文字左边缘能对成一条线 */
.col { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: var(--sp2); }
.me .col { align-items: flex-end; }
.ai .col { align-items: flex-start; }

.bubble { border-radius: var(--r-bubble); padding: calc(var(--sp2) + 2px) var(--pad-x); line-height: var(--lh); max-width: 100%; }
.me-bubble { background: var(--bubble-me); color: var(--bubble-me-text); border: 1px solid var(--bubble-me-border, transparent); max-width: min(80%, 720px); border-top-right-radius: min(var(--r-bubble), 4px); }
.ai-bubble { background: none; border: 0; box-shadow: none; padding: 0 var(--pad-x); }
/* 正文一直带个框，和思考/工具卡片一个样子，一眼能看出这块属于哪条回复。设置里能关 */
.ai-bubble.boxed { align-self: stretch; padding: calc(var(--sp2) - 1px) var(--pad-x); border: 1px solid color-mix(in srgb, var(--text-3) 45%, var(--line)); border-radius: var(--r-md); }
.pre { white-space: pre-wrap; word-break: break-word; }
.imgs { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.imgs img { max-height: 160px; max-width: 260px; border-radius: var(--r-sm); display: block; }
/* 消息里带的附件：和输入框上面那一排长得一样，只是不能拖、不能删 */
.atts { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.atts:last-child { margin-bottom: 0; }
.att { display: inline-flex; align-items: center; gap: 6px; height: 34px; max-width: 220px; padding: 0 10px 0 4px; border-radius: var(--r-md); background: color-mix(in srgb, var(--panel) 82%, transparent); color: var(--text-2); border: 1px solid var(--line-2); font-size: var(--fs-sm); }
.att.link { cursor: pointer; }
.att.link:hover { color: var(--text); border-color: var(--text-3); }
.att .no { flex: none; min-width: 18px; height: 18px; padding: 0 4px; border-radius: var(--r-pill); background: var(--accent-soft); color: var(--accent-text); font-size: 11px; font-weight: 600; line-height: 18px; text-align: center; }
.att .pic { flex: none; width: 26px; height: 26px; object-fit: cover; border-radius: var(--r-xs); display: block; }
.att .fic { flex: none; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-3); }
.att .aname { min-width: 0; }

.errbox { margin: 0 var(--pad-x); background: var(--err-bg); color: var(--err); border: 1px solid color-mix(in srgb, var(--err) 30%, transparent); border-radius: var(--r-md); padding: 8px var(--pad-x); white-space: pre-wrap; font-size: var(--fs-sm); }
.note-sm { padding: 0 var(--pad-x); font-size: var(--fs-xs); color: var(--text-3); }
/* 打开后才显示的模型/用量 */
.meta { padding: 0 var(--pad-x); font-size: var(--fs-xs); color: var(--text-3); font-variant-numeric: tabular-nums; }
/* 思考折叠时那一行预览：跟工具调用的摘要同色，但用正文字体 */
.think-prev { font-family: var(--font); }
.blk[open] .think-prev { display: none; }

/* 卡片类：shell、系统消息 */
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
.shell { margin: 0 0 var(--sp5); }
.card-head { padding: var(--sp2) var(--pad-x); font-size: var(--fs-sm); }
.dollar { color: var(--accent-text); font-weight: 700; font-family: var(--font-code); }
.badge { font-size: var(--fs-xs); padding: 0 8px; border-radius: var(--r-pill); background: var(--hover); line-height: 20px; flex: none; }
.out { margin: 0; padding: var(--sp2) var(--pad-x); max-height: 360px; overflow: auto; white-space: pre-wrap; word-break: break-all; font-size: var(--fs-code); font-family: var(--font-code); background: var(--code-bg); border-top: 1px solid var(--line); line-height: 1.55; }
.sys { display: flex; flex-direction: column; align-items: center; gap: 8px; margin: 0 0 var(--sp5); }
.sys-pill { border: 0; cursor: pointer; background: var(--active); color: var(--text-2); font-size: var(--fs-xs); padding: 4px 12px; border-radius: var(--r-pill); display: inline-flex; gap: 8px; }
.sys-pill:hover { color: var(--text); }
.caret { color: var(--accent-text); }
.sys-card { width: 100%; padding: var(--sp3) var(--pad-x); }
.sys-card.out { padding: var(--sp2) var(--pad-x); }
.sys-tag { font-size: var(--fs-xs); color: var(--text-3); margin-bottom: 6px; }
@media (max-width: 768px) {
  .msg { margin-bottom: 18px; }
  .me-bubble { max-width: 88%; }
}
</style>
