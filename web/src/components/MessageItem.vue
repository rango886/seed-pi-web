<script setup>
import { computed, ref, watchEffect, onUnmounted } from 'vue';
import { S, openFile, beginEdit, forkMessage, switchVersion, conversationNodes, branchDisabled } from '../store.js';
import { UI } from '../settings.js';
import { rawUrl } from '../api.js';
import { renderMarkdown, textOf, imagesOf, imageSrc, stripAnsi, fmtTokens, setMsgText, delMsgText, splitAttachments } from '../util.js';
import { vMarkdownHtml } from '../markdown-html.js';
import ToolCard from './ToolCard.vue';
import ThinkingBlock from './ThinkingBlock.vue';
import AttTooltip from './AttTooltip.vue';
import Icon from './Icon.vue';
import UserMessageEditor from './UserMessageEditor.vue';

const props = defineProps({ m: Object });
const role = computed(() => props.m.role);
const open = ref(false);
const editing = computed(() => !!props.m._entryId && S.edit?.entryId === props.m._entryId);
const node = computed(() => conversationNodes.value.get(props.m._entryId));
const versionIndex = computed(() => node.value?.versions.indexOf(props.m._entryId) ?? 0);

// 用户消息前面的 <attachments> 块：不显示原文，还原成和输入框上一样的附件
const userParts = computed(() => splitAttachments(textOf(props.m.content)));
const userText = computed(() => userParts.value.text);
const atts = computed(() => userParts.value.attachments);
const broken = ref({}); // 文件已经不在的图片，缩略图换成图标
const isImg = (a) => a.kind === 'image' && !broken.value[a.n];
const KIND_LABEL = { image: '图片', file: '文件', dir: '文件夹' };
// 悬停浮层：编号、全名、完整路径都放这（图片附件平时只有一张缩略图）
const tip = ref(null);
function showTip(e, a) {
  tip.value = { anchor: e.currentTarget.getBoundingClientRect(), index: a.n, name: a.name, path: a.path, info: KIND_LABEL[a.kind] || '' };
}
const openAtt = (a) => a.kind !== 'dir' && openFile(a.path);
// 磁贴中间那行：文件夹写“文件夹”，文件写扩展名（消息里没有大小信息，扩展名之外就写“文件”）
function attMeta(a) {
  if (a.kind === 'dir') return '文件夹';
  const dot = a.name.lastIndexOf('.');
  return dot > 0 ? a.name.slice(dot + 1).toLowerCase() : '文件';
}
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
const customText = computed(() => (typeof props.m.content === 'string' ? props.m.content : textOf(props.m.content)));
const copyText = computed(() => (role.value === 'user' ? userText.value : aiText.value));
// 右键菜单统一在 App 层弹，所以只能把文本先存下来，菜单里按 DOM 上的 key 回来取
watchEffect(() => setMsgText(props.m._k, copyText.value));
onUnmounted(() => delMsgText(props.m._k));
// 还在流式输出的最后一段字：渲染结果不进缓存（它每 50ms 就变一次）
const md = (b, i) => renderMarkdown(b.text, undefined, { live: streaming.value && i === blocks.value.length - 1 });
</script>

<template>
  <!-- 用户：靠右的气泡 -->
  <div v-if="role === 'user'" class="msg me" :data-msg="m._k" :data-entry="m._entryId" data-role="user">
    <div class="col">
      <UserMessageEditor v-if="editing" />
      <div v-else class="bubble me-bubble">
        <div v-if="atts.length" class="atts">
          <div
            v-for="a in atts"
            :key="a.n"
            class="att"
            :class="{ link: a.kind !== 'dir', img: isImg(a) }"
            @click="openAtt(a)"
            @mouseenter="showTip($event, a)"
            @mouseleave="tip = null"
          >
            <img v-if="isImg(a)" class="pic" :src="rawUrl(a.path)" alt="" @error="broken[a.n] = true" />
            <span v-else class="atxt">
              <span class="ameta ellipsis">{{ attMeta(a) }}</span>
              <span class="aline">
                <Icon :name="a.kind === 'dir' ? 'folder' : 'file'" :size="12" />
                <span class="aname ellipsis">{{ a.name }}</span>
              </span>
            </span>
          </div>
          <AttTooltip :tip="tip" />
        </div>
        <div v-if="userText.trim()" class="pre">{{ userText }}</div>
        <div v-if="images.length" class="imgs">
          <img v-for="(im, i) in images" :key="i" :src="imageSrc(im)" />
        </div>
      </div>
      <div v-if="m._entryId && !editing && !S.detached" class="user-actions" :class="{ versions: node?.versions.length > 1 }" aria-label="用户消息操作">
        <span class="hover-actions">
          <button type="button" :disabled="branchDisabled" title="修改并在当前会话创建新分支" aria-label="修改消息" @click="beginEdit(m)"><Icon name="edit" :size="15" /></button>
          <button type="button" :disabled="branchDisabled" title="从此处分叉为新会话" aria-label="分叉为新会话" @click="forkMessage(m)"><Icon name="fork" :size="15" /></button>
        </span>
        <template v-if="node?.versions.length > 1">
          <button type="button" :disabled="branchDisabled || versionIndex <= 0" aria-label="上一个提问版本" @click="switchVersion(m, -1)">‹</button>
          <span class="version-count" title="此处分叉的提问版本">{{ versionIndex + 1 }} / {{ node.versions.length }}</span>
          <button type="button" :disabled="branchDisabled || versionIndex >= node.versions.length - 1" aria-label="下一个提问版本" @click="switchVersion(m, 1)">›</button>
        </template>
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
        <ThinkingBlock v-if="showThinking(b)" :block="b" :streaming="streaming && i === blocks.length - 1" />
        <div v-else-if="b.type === 'text' && b.text" class="bubble ai-bubble md" v-markdown-html="md(b, i)" />
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
.me-bubble { background: var(--bubble-me); color: var(--bubble-me-text); border: 1px solid var(--bubble-me-border, transparent); max-width: min(80%, 720px); padding: calc(var(--sp2) - 1px) calc(var(--pad-x) - 2px); font-size: var(--fs-user); line-height: 1.6; }
/* 正文上下都多留些空间，和前后的思考/工具块拉开距离；工具块之间仍保持紧凑 */
/* align-self: stretch：正文铺满整栏，里面的代码块、图、表格才能真正两边填满（否则这块会缩到最长那行文字那么宽） */
.ai-bubble { align-self: stretch; min-width: 0; background: none; border: 0; box-shadow: none; padding: 0 var(--pad-x); margin-block: var(--sp3); }
.user-actions { display: flex; align-items: center; gap: 3px; min-height: 24px; color: var(--text-3); font-size: var(--fs-xs); opacity: 0; }
.me:hover .user-actions, .me:focus-within .user-actions, .user-actions.versions { opacity: 1; }
.hover-actions { display: inline-flex; opacity: 0; }
.me:hover .hover-actions, .me:focus-within .hover-actions { opacity: 1; }
.user-actions button { display: inline-flex; align-items: center; justify-content: center; min-width: 26px; height: 26px; border: 0; border-radius: var(--r-sm); background: transparent; color: inherit; padding: 4px; cursor: pointer; font: inherit; }
.user-actions button:hover:not(:disabled) { background: var(--hover); color: var(--text); }
.user-actions button:disabled { opacity: 0.4; cursor: default; }
.version-count { font-variant-numeric: tabular-nums; }
@media (hover: none) { .user-actions, .hover-actions { opacity: 1; } }
.pre { font-family: var(--font-chat); white-space: pre-wrap; word-break: break-word; }
.imgs { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.imgs img { max-height: 160px; max-width: 260px; border-radius: var(--r-md); display: block; cursor: zoom-in; }
/* 消息里带的附件：和输入框上面那一排长得一样（中间是类型、底部一条淡色横条放图标 + 名字），
   只是不能拖、不能删 */
.atts { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; align-items: flex-start; }
.atts:last-child { margin-bottom: 0; }
.att { display: inline-flex; align-items: center; height: 72px; max-width: 260px; padding: 0; border-radius: var(--r-md); background: color-mix(in srgb, var(--panel) 86%, transparent); color: var(--text-2); border: 1px solid var(--line-2); }
/* 气泡始终是浅底，附件也用浅色卡片和黑字，不继承深色主题的浅字 / 深底。 */
.me-bubble .att { --panel: color-mix(in srgb, var(--bubble-me) 55%, white); --text-2: var(--bubble-me-text); --line-2: var(--bubble-me-border); }
.att.link { cursor: pointer; }
.att.link:hover { border-color: var(--text-3); }
/* 图片附件跟输入框里一个样：只露一张缩略图，文件名和编号都在悬停浮层里 */
.att.img { width: 72px; height: 72px; gap: 0; background: transparent; border-color: transparent; }
.att.img:hover { border-color: var(--line-2); }
.att.img .pic { flex: none; width: 100%; height: 100%; object-fit: cover; border-radius: inherit; border: 1px solid var(--line-2); display: block; }
.att .atxt { display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; }
.att .ameta { flex: 1; display: flex; align-items: center; justify-content: center; min-width: 0; padding: 0 10px; font-size: var(--fs-sm); line-height: 1.25; color: var(--text-2); }
.att .aline { flex: none; display: flex; align-items: center; gap: 5px; min-width: 0; padding: 4px 10px 5px; border-radius: 0 0 var(--r-inner) var(--r-inner); background: var(--accent-soft); font-size: 11px; line-height: 1.3; color: var(--text-2); }
.att .aname { min-width: 0; }

.errbox { margin: 0 var(--pad-x); background: var(--err-bg); color: var(--err); border: 1px solid color-mix(in srgb, var(--err) 30%, transparent); border-radius: var(--r-md); padding: 8px var(--pad-x); white-space: pre-wrap; font-size: var(--fs-sm); }
.note-sm { padding: 0 var(--pad-x); font-size: var(--fs-xs); color: var(--text-3); }
/* 打开后才显示的模型/用量 */
.meta { padding: 0 var(--pad-x); font-size: var(--fs-xs); color: var(--text-3); font-variant-numeric: tabular-nums; }

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
