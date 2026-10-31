<script setup>
import { computed, ref } from 'vue';
import { S } from '../store.js';
import { UI } from '../settings.js';
import { renderMarkdown, textOf, imagesOf, stripAnsi, fmtTokens } from '../util.js';
import ToolCard from './ToolCard.vue';

const props = defineProps({ m: Object });
const role = computed(() => props.m.role);
const open = ref(false);

const userText = computed(() => textOf(props.m.content));
const images = computed(() => imagesOf(props.m.content));
const blocks = computed(() => (Array.isArray(props.m.content) ? props.m.content.filter(Boolean) : []));
const streaming = computed(() => props.m.stopReason === 'pending');
const meta = computed(() => {
  const m = props.m;
  if (role.value !== 'assistant' || streaming.value) return '';
  const u = m.usage;
  return [m.model, u ? `↑${fmtTokens(u.input + (u.cacheRead || 0))} ↓${fmtTokens(u.output)}` : '', u?.cost?.total ? `$${u.cost.total.toFixed(4)}` : '']
    .filter(Boolean)
    .join(' · ');
});
const aiText = computed(() =>
  blocks.value
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n'),
);
const customText = computed(() => (typeof props.m.content === 'string' ? props.m.content : textOf(props.m.content)));

const copied = ref(false);
function copy(text) {
  navigator.clipboard.writeText(text);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1200);
}
</script>

<template>
  <!-- 用户：靠右的气泡 -->
  <div v-if="role === 'user'" class="msg me">
    <div v-if="UI.avatars" class="avatar me-av">我</div>
    <div class="col">
      <div class="bubble me-bubble">
        <div class="pre">{{ userText }}</div>
        <div v-if="images.length" class="imgs">
          <img v-for="(im, i) in images" :key="i" :src="`data:${im.mimeType};base64,${im.data}`" />
        </div>
      </div>
      <div class="actions">
        <button class="act" @click="copy(userText)">{{ copied ? '已复制' : '复制' }}</button>
      </div>
    </div>
  </div>

  <!-- 助手：靠左，文字是气泡，思考/工具是轻量的卡片 -->
  <div v-else-if="role === 'assistant'" class="msg ai">
    <div v-if="UI.avatars" class="avatar ai-av">π</div>
    <div class="col">
      <template v-for="(b, i) in blocks" :key="i">
        <!-- 思考过程：和工具调用用同一套 .blk 卡片样式 -->
        <details v-if="b.type === 'thinking'" class="blk" :open="UI.thinkingOpen || (streaming && i === blocks.length - 1)">
          <summary class="blk-head">
            <span class="blk-ic"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" /></svg></span>
            <span class="blk-chip soft">思考过程{{ b.redacted ? '（已隐藏）' : '' }}</span>
            <span class="grow" />
            <span v-if="streaming && i === blocks.length - 1" class="spin" />
            <svg class="blk-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6l6 6-6 6" /></svg>
          </summary>
          <div class="blk-body prose dim">{{ b.thinking }}</div>
        </details>
        <div v-else-if="b.type === 'text' && b.text" class="bubble ai-bubble md" v-html="renderMarkdown(b.text)" />
        <ToolCard v-else-if="b.type === 'toolCall'" :call="b" :exec="S.tools[b.id]" :streaming="streaming" />
      </template>
      <div v-if="m.stopReason === 'error'" class="errbox">出错：{{ stripAnsi(m.errorMessage || '未知错误') }}</div>
      <div v-else-if="m.stopReason === 'aborted'" class="note-sm">已中断</div>
      <div v-else-if="m.stopReason === 'length'" class="note-sm warn">达到输出长度上限，回复被截断</div>
      <div v-if="!streaming && (meta || aiText)" class="actions">
        <button v-if="aiText" class="act" @click="copy(aiText)">{{ copied ? '已复制' : '复制' }}</button>
        <span v-if="meta" class="meta" :class="{ pin: UI.showMeta }">{{ meta }}</span>
      </div>
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
    <pre v-if="m.output" class="out">{{ stripAnsi(m.output) }}</pre>
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
.msg { display: flex; gap: var(--sp3); margin: 0 0 var(--sp5); align-items: flex-start; }
.me { flex-direction: row-reverse; }
.col { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: var(--sp2); }
.me .col { align-items: flex-end; }
.ai .col { align-items: flex-start; }

.avatar { width: 36px; height: 36px; border-radius: 10px; flex: none; display: flex; align-items: center; justify-content: center; font-weight: 700; user-select: none; font-size: var(--fs-sm); }
.ai-av { background: var(--accent); color: #fff; font-size: 18px; }
.me-av { background: var(--panel); color: var(--text-2); border: 1px solid var(--line); }

.bubble { border-radius: var(--radius); padding: calc(var(--sp2) + 2px) calc(var(--sp3) + 2px); line-height: var(--lh); max-width: 100%; }
.me-bubble { background: var(--bubble-me); color: var(--bubble-me-text); max-width: min(80%, 720px); border-top-right-radius: min(var(--radius), 4px); }
.ai-bubble { background: var(--bubble-ai); box-shadow: var(--shadow-sm); border: 1px solid var(--line-2); border-top-left-radius: min(var(--radius), 4px); }
.ai-bubble + .ai-bubble { border-top-left-radius: var(--radius); }
.pre { white-space: pre-wrap; word-break: break-word; }
.imgs { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.imgs img { max-height: 160px; max-width: 260px; border-radius: 8px; display: block; }

.errbox { background: var(--err-bg); color: var(--err); border: 1px solid color-mix(in srgb, var(--err) 30%, transparent); border-radius: var(--r-md); padding: 8px 12px; white-space: pre-wrap; font-size: var(--fs-sm); }
.note-sm { font-size: var(--fs-xs); color: var(--text-3); }

/* 悬停时出现的操作和用量：价格/模型默认不占眼力 */
.actions { display: flex; align-items: center; gap: 10px; min-height: 18px; font-size: var(--fs-xs); color: var(--text-3); margin-top: -2px; }
.act { border: 0; background: transparent; color: var(--text-3); cursor: pointer; padding: 0 2px; font-size: var(--fs-xs); opacity: 0; transition: opacity 0.15s; }
.act:hover { color: var(--accent-text); }
.msg:hover .act { opacity: 1; }
.meta { opacity: 0; transition: opacity 0.15s; }
.msg:hover .meta { opacity: 1; }
.meta.pin { opacity: 1; }

/* 卡片类：shell、系统消息 */
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
.shell { margin: 0 0 var(--sp5); }
.card-head { padding: 8px 12px; font-size: var(--fs-sm); }
.dollar { color: var(--accent-text); font-weight: 700; font-family: var(--font-code); }
.badge { font-size: var(--fs-xs); padding: 0 8px; border-radius: 10px; background: var(--hover); line-height: 20px; flex: none; }
.out { margin: 0; padding: 10px 14px; max-height: 360px; overflow: auto; white-space: pre-wrap; word-break: break-all; font-size: var(--fs-code); font-family: var(--font-code); background: var(--code-bg); border-top: 1px solid var(--line); line-height: 1.55; }
.sys { display: flex; flex-direction: column; align-items: center; gap: 8px; margin: 0 0 var(--sp5); }
.sys-pill { border: 0; cursor: pointer; background: var(--active); color: var(--text-2); font-size: var(--fs-xs); padding: 4px 12px; border-radius: 12px; display: inline-flex; gap: 8px; }
.sys-pill:hover { color: var(--text); }
.caret { color: var(--accent-text); }
.sys-card { width: 100%; padding: 12px 16px; }
.sys-card.out { padding: 10px 14px; }
.sys-tag { font-size: var(--fs-xs); color: var(--text-3); margin-bottom: 6px; }
@media (max-width: 768px) {
  .msg { gap: 8px; margin-bottom: 18px; }
  .avatar { width: 30px; height: 30px; border-radius: 8px; }
  .ai-av { font-size: 15px; }
  .me-bubble { max-width: 88%; }
  .ai-bubble { padding: 10px 12px; }
}
@media (hover: none) {
  .act { opacity: 1; }
  .meta { opacity: 1; }
}
</style>