<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import { S, openDirPicker, restartExited, viewer } from '../store.js';
import MessageItem from './MessageItem.vue';
import Composer from './Composer.vue';
import ConversationBranches from './ConversationBranches.vue';
import ChatOutline from './ChatOutline.vue';
import { UI, view, openLightbox } from '../settings.js';
import Icon from './Icon.vue';
import { splitAttachments } from '../util.js';

const scroller = ref(null);
const inner = ref(null);
const dockEl = ref(null);
const dockH = ref(0); // 悬浮输入区的真实高度：对话内容底部要留出这么多，最后一条才不会被挡住
const sbw = ref(0); // 滚动条占的宽度：输入框那栏也要让出同样宽度，两边才对得齐
let stick = true;
const away = ref(false); // 离底部比较远时显示回到底部按钮
const shortcutsOpen = ref(false);
// π 图标的“招呼”动画只放给第一次见面的人看：点开过快捷键就写进 localStorage，之后 π 回归静态。
const welcomeSeen = ref((() => { try { return localStorage.getItem('seed-pi-web-welcome-seen') === '1'; } catch { return false; } })());
watch(shortcutsOpen, (open) => {
  if (!open || welcomeSeen.value) return;
  welcomeSeen.value = true;
  try { localStorage.setItem('seed-pi-web-welcome-seen', '1'); } catch {}
});
let ro, roDock;

/** 离底部还剩多少像素 */
function gapOf() {
  const el = scroller.value;
  return el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0;
}
/** 只重算“回到底部”按钮要不要显示。内容一变短（新建会话、切到短会话），scrollTop 会被浏览器
 *  静静夹到有效范围里，这个夹不一定伴随 scroll 事件，光靠 onScroll 会把按钮留在屏幕上 */
function syncAway() {
  away.value = gapOf() > 400;
}
function onScroll() {
  const gap = gapOf();
  stick = gap < 40;
  away.value = gap > 400;
}
const jumpBottom = () => {
  stick = true;
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' });
};
const toBottom = () => {
  const el = scroller.value;
  // nextTick 排队后用户可能已经手动滚走了，执行时再检查，不能用排队时的 stick。
  if (el && stick && !(shortcutsOpen.value && !S.messages.length)) el.scrollTop = el.scrollHeight;
};
const onOutlineJump = () => (stick = false); // 从大纲跳走了，内容再变高也别拽回底部
// Home / End：消息始终按真实高度布局，一次跳转即可，不在后续帧覆盖手动滚动。
function jumpTo(top) {
  const el = scroller.value;
  if (!el) return;
  stick = !top;
  el.scrollTop = top ? 0 : el.scrollHeight;
}
function onKey(e) {
  if (e.key !== 'Home' && e.key !== 'End') return;
  if (S.activeTab !== 'chat' || e.altKey || e.shiftKey || e.defaultPrevented) return;
  if (S.picker || S.dialogs.length || S.dirPicker || view.settingsOpen || view.menu || view.lightbox) return;
  const t = e.target;
  if (t.closest?.('.xterm')) return;
  if (t.closest?.('input, textarea, select, [contenteditable]')) {
    // 输入框里：没字时 Home/End 直接滚对话；有字时 Home/End 留给光标，Ctrl+Home/End 滚对话
    if (!t.classList?.contains('ta')) return;
    if (t.value && !(e.ctrlKey || e.metaKey)) return;
  }
  e.preventDefault();
  jumpTo(e.key === 'Home');
}
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
onMounted(() => {
  // 内容变高时，如果用户本来就在底部，就跟着滚到底；顺便重新量一次滚动条宽度
  ro = new ResizeObserver(() => {
    measureSb();
    stick && toBottom();
    syncAway(); // 先决定要不要跟到底，再看一眼距离：内容变短时按钮该自己消失
  });
  ro.observe(inner.value);
  measureSb();
});
function measureSb() {
  const el = scroller.value;
  if (el) sbw.value = el.offsetWidth - el.clientWidth;
}
onUnmounted(() => ro?.disconnect());
// 输入区高度会变（插话队列、扩展面板、展开状态信息、输入框变高），跟着量
onMounted(() => {
  roDock = new ResizeObserver(() => (dockH.value = dockEl.value?.offsetHeight || 0));
  if (dockEl.value) roDock.observe(dockEl.value);
});
onUnmounted(() => roDock?.disconnect());
// 后台标签页里 ResizeObserver 可能不触发，再用事件计数兜底
watch(
  () => S.tick,
  () => stick && nextTick(toBottom),
);
// 换会话时回到底部。看 S.messages 是不是整个换了一份：新建会话、打开历史、重新载入都算，
// 不像 sessionFile 那样在两种“还没写过盘的新会话”之间切换时一点不变
watch(
  () => S.messages,
  () => {
    const jump = S.branchJump;
    S.branchJump = null;
    if (jump) {
      const old = jump.fromId && scroller.value?.querySelector(`[data-entry="${CSS.escape(jump.fromId)}"]`);
      const offset = old ? old.getBoundingClientRect().top - scroller.value.getBoundingClientRect().top : 12;
      stick = !!jump.bottom;
      nextTick(() => {
        if (jump.bottom) toBottom();
        else jumpEntry(jump.toId, offset);
        syncAway();
      });
      return;
    }
    stick = true;
    away.value = false;
    nextTick(() => {
      toBottom();
      syncAway();
    });
  },
);
function jumpEntry(id, offset = 12) {
  const sc = scroller.value;
  const el = id && sc?.querySelector(`[data-entry="${CSS.escape(id)}"]`);
  if (!sc || !el) return;
  stick = false;
  sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - offset;
  syncAway();
}

// 点对话里的图片：全屏看大图，左右能翻这个会话里的所有图片（markdown 的图和用户发的图都算）
function openImg(img) {
  const all = [...(scroller.value?.querySelectorAll('.md img, .imgs img') || [])].filter((el) => el.complete && el.naturalWidth > 0);
  const i = all.indexOf(img);
  if (i < 0) return;
  openLightbox(
    all.map((el) => ({ src: el.currentSrc || el.src, alt: el.alt || el.title || '' })),
    i,
  );
}

// 点对话里的图片看大图；代码块的“复制”、文件链接由 md-actions.js 统一处理
function onClick(e) {
  const img = e.target.closest?.('img');
  if (img) {
    e.preventDefault(); // 图片外面包着链接时只开灯箱，不跳走
    openImg(img);
  }
}

const widgetsAbove = computed(() => Object.entries(S.widgets).filter(([, w]) => w.placement !== 'belowEditor'));
const widgetsBelow = computed(() => Object.entries(S.widgets).filter(([, w]) => w.placement === 'belowEditor'));
// 排队里的消息不显示附件块原文，只标一下带了几个附件
const qText = (t) => {
  const { text, attachments } = splitAttachments(t);
  return (attachments.length ? `[${attachments.length} 个附件] ` : '') + text.trim();
};
const queued = computed(() => [...S.queue.steering.map((t) => ['插话', qText(t)]), ...S.queue.followUp.map((t) => ['排队', qText(t)])]);
const model = computed(() => S.state?.model);

// 与实际按键处理一致；发送 / 换行提示随设置切换，局部快捷键标明使用场景。
const shortcutGroups = computed(() => [
  { title: '输入与发送', rows: [
    [UI.sendKey === 'ctrlEnter' ? 'Ctrl+Enter' : 'Enter', '发送 / 运行中插话'],
    [UI.sendKey === 'ctrlEnter' ? 'Enter' : 'Shift+Enter', '换行'],
    ['Alt+Enter', '排队发送'],
    ['/', '命令菜单'],
    ['!', '执行 shell'],
    ['!!', '执行 shell（不进上下文）'],
    ['@', '引用文件'],
    ['Ctrl+V', '粘贴文件'],
    ['↑ / ↓', '历史输入（输入框为空时）'],
  ] },
  { title: '会话与界面', rows: [
    ['Alt+N', '新会话'],
    ['Alt+Shift+N', '其他新建'],
    ['Alt+T', '临时会话'],
    ['Ctrl+P', '切换会话'],
    ['Ctrl+L', '切换模型'],
    ['Ctrl+B', '显示 / 隐藏会话侧栏'],
    ['Ctrl+E', '显示 / 隐藏文件侧栏'],
    ['Ctrl+`', '终端 / 对话'],
    ['Ctrl+,', '界面设置'],
    ['Esc', '关闭浮层 / 停止运行'],
  ] },
  { title: '对话与消息编辑', rows: [
    ['Home / End', '对话首尾（输入框为空时）'],
    ['Ctrl+Home / Ctrl+End', '对话首尾（输入文字时）'],
    ['Ctrl+Enter', '发送编辑后的消息'],
    ['Esc', '取消消息编辑'],
  ] },
  { title: '菜单与目录窗口', rows: [
    ['↑ / ↓', '选择菜单项'],
    ['Enter', '确认选择'],
    ['Tab', '补全命令 / 进入引用目录'],
    ['Esc', '关闭菜单'],
    ['Enter', '进入路径 / 创建目录'],
    ['Tab / →', '接受路径补全'],
    ['Home / End', '快捷菜单首项 / 末项'],
  ] },
  { title: '调整高度（先聚焦分隔条）', rows: [
    ['↑ / ↓', '调整输入框 / 文件面板高度'],
    ['Home / End', '最小 / 最大高度'],
  ] },
  { title: '图片查看', rows: [
    ['← / →', '上一张 / 下一张'],
    ['+ / =', '放大'],
    ['−', '缩小'],
    ['0', '还原缩放'],
    ['Esc', '关闭图片'],
  ] },
]);
</script>

<template>
  <div class="chat">
    <div ref="scroller" class="scroll" :class="{ welcoming: !S.messages.length && !S.agentExited }" tabindex="-1" @scroll="onScroll" @click="onClick">
      <div ref="inner" class="inner" :style="{ paddingBottom: dockH ? dockH + 8 + 'px' : null }">
        <div v-if="S.detached" class="banner detach">
          <div class="row">
            <b class="warn">这个会话原来的目录已经不存在了</b>
            <span class="dim ellipsis">{{ S.detached.cwd }}</span>
            <div class="grow" />
            <button class="btn" @click="openDirPicker('new')">选个新目录继续聊…</button>
          </div>
          <div class="detach-hint">现在只能看历史。换到一个新目录后会在那里开一个<b>新会话</b>（原来的对话还在这份历史里，随时能再打开看）。</div>
        </div>

        <div v-if="S.agentExited" class="banner">
          <div class="row">
            <b class="err">pi 进程已退出</b>
            <span class="dim">（退出码 {{ S.agentExited.code ?? '?' }}）</span>
            <div class="grow" />
            <button class="btn" @click="restartExited">重新启动</button>
          </div>
          <pre v-if="S.agentExited.stderr" class="stderr">{{ S.agentExited.stderr }}</pre>
        </div>

        <div v-if="!S.messages.length && !S.agentExited" class="welcome">
          <button type="button" class="big" :class="{ idle: !welcomeSeen }" :aria-expanded="shortcutsOpen" aria-controls="welcome-shortcuts" :aria-label="shortcutsOpen ? '收起快捷键' : '显示快捷键'" :title="shortcutsOpen ? '收起快捷键' : '显示快捷键'" @click="shortcutsOpen = !shortcutsOpen"><Icon name="pi" :size="34" /></button>
          <div class="wtitle">有什么可以帮你</div>
          <div v-if="shortcutsOpen" id="welcome-shortcuts" class="tips">
            <section v-for="group in shortcutGroups" :key="group.title" class="tip-group">
              <h3>{{ group.title }}</h3>
              <div v-for="[key, label] in group.rows" :key="key + label" class="tip">
                <span>{{ label }}</span><kbd>{{ key }}</kbd>
              </div>
            </section>
          </div>
        </div>

        <div
          v-for="(m, i) in S.messages"
          :key="m._k"
          class="mw"
          :class="{
            // 连着好几个助手消息（一次回复里做了好几步工具）算同一条，中间不要留整段间距
            tight: i > 0 && m.role === 'assistant' && S.messages[i - 1]?.role === 'assistant',
          }"
        >
          <MessageItem :m="m" />
        </div>

        <!-- 工作中 / 重试 / 压缩：先文字，后三个跳动的点当省略号；左端跟正文（.ai-bubble 的 --pad-x）对齐 -->
        <div v-if="S.running || S.compacting || S.retry" class="working">
          <span v-if="S.retry">第 {{ S.retry.attempt }}/{{ S.retry.maxAttempts }} 次重试：{{ S.retry.errorMessage }}</span>
          <span v-else-if="S.compacting">正在压缩上下文…</span>
          <span v-else>工作中</span>
          <span class="typing"><i /><i /><i /></span>
          <span v-if="viewer" class="dim">· 另一个窗口在操作</span>
        </div>
      </div>
    </div>

    <ChatOutline v-if="!S.branchesOpen" :scroller="scroller" :style="{ '--sb': sbw + 'px' }" @jump="onOutlineJump" />

    <div ref="dockEl" class="dock" :style="{ '--sb': sbw + 'px' }">
      <button v-show="away" class="tobottom" title="回到底部" @click="jumpBottom"><Icon name="down" :size="18" /></button>
      <div v-for="[k, w] in widgetsAbove" :key="k" class="widget">
        <div v-for="(l, i) in w.lines" :key="i">{{ l }}</div>
      </div>
      <div v-if="queued.length" class="queue">
        <div v-for="([kind, t], i) in queued" :key="i" class="qitem">
          <span class="tag">{{ kind }}</span><span class="ellipsis">{{ t }}</span>
        </div>
      </div>
      <ConversationBranches @jump="jumpEntry" />
      <Composer />
      <div v-for="[k, w] in widgetsBelow" :key="k" class="widget">
        <div v-for="(l, i) in w.lines" :key="i">{{ l }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat { --gut: calc(var(--sp5) + 48px); position: relative; flex: 1; display: flex; flex-direction: column; min-height: 0; background: var(--chat-bg); }
/* 对话铺满整个区域，输入区悬在它上面：对话能从输入框底下滚过去 */
.scroll { position: absolute; inset: 0; overflow-y: auto; outline: none; scrollbar-gutter: stable both-edges; }
.inner { padding: var(--sp5) var(--gut) var(--sp4); max-width: calc(var(--chat-w) + 2 * var(--gut)); margin: 0 auto; }
.scroll.welcoming { display: flex; flex-direction: column; }
.welcoming .inner { width: 100%; flex: 1 0 auto; display: flex; flex-direction: column; }
.welcome { flex: 1; text-align: center; padding: 32px 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; }
.welcome .big { border: 0; padding: 0; cursor: pointer; width: 64px; height: 64px; border-radius: var(--r-xl); background: var(--accent); color: #fff; font-size: 34px; font-weight: 700; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 24px var(--accent-soft); margin-bottom: 10px; position: relative; overflow: hidden; transition: transform 0.15s ease; }
.wtitle { font-size: calc(var(--fs) + 6px); font-weight: 600; }
.welcome .big:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
/* 首次见面时 π 的待机动画：轻轻浮动 + 呼吸光圈示意“这里能点”，π 每几秒歪一下头、一道高光扫过，像在跟你打招呼。
   点开过快捷键后 localStorage 记下来，之后一直是静态图标，不再打扰老用户。 */
.welcome .big.idle { animation: pi-bob 3.2s ease-in-out infinite, pi-glow 3.2s ease-in-out infinite; }
.welcome .big.idle:hover { animation-play-state: paused, running; } /* 悬停时停住浮动让它定住好点，光圈继续呼吸 */
.welcome .big.idle svg { animation: pi-tilt 3.6s ease-in-out infinite; }
.welcome .big.idle::after { content: ''; position: absolute; top: -30%; bottom: -30%; left: -70%; width: 45%; background: linear-gradient(105deg, transparent, color-mix(in srgb, #fff 40%, transparent), transparent); transform: skewX(-18deg); animation: pi-shine 3.6s ease-in-out infinite; }
@keyframes pi-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-7px); } }
@keyframes pi-glow { 0%, 100% { box-shadow: 0 8px 24px var(--accent-soft); } 50% { box-shadow: 0 8px 24px var(--accent-soft), 0 0 0 9px color-mix(in srgb, var(--accent) 14%, transparent); } }
@keyframes pi-tilt { 0%, 58%, 94%, 100% { transform: rotate(0); } 66% { transform: rotate(-10deg); } 76% { transform: rotate(9deg); } 86% { transform: rotate(-4deg); } }
@keyframes pi-shine { 0%, 52%, 100% { left: -70%; } 74% { left: 130%; } }
.welcome .big:not(.idle):hover { transform: scale(1.05); }
.welcome .big:active { animation: none; transform: scale(0.94); } /* 按下的瞬间结束动画（首次点击也是），给个回弹手感 */
@media (prefers-reduced-motion: reduce) {
  .welcome .big.idle, .welcome .big.idle svg, .welcome .big.idle::after { animation: none; }
}
.tips { width: 100%; max-width: 780px; margin-top: 28px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px 32px; font-size: var(--fs-sm); color: var(--text-2); text-align: left; }
.tip-group { min-width: 0; }
.tip-group h3 { margin: 0 0 10px; color: var(--text-3); font-size: var(--fs-xs); font-weight: 500; }
.tip { display: grid; grid-template-columns: minmax(0, 1fr) max-content; align-items: baseline; gap: 12px; padding: 4px 0; }
kbd { font-family: var(--font-code); font-size: var(--fs-xs); color: var(--text-3); text-align: right; white-space: nowrap; }
/* “工作中 + 跳动的点”：不要气泡底（GitHub 主题里气泡色和正文底一个色，只衬出一块阴影框，很脏），
   就是一行灰字配一个会动的省略号；左内边距跟正文一样，两边的字能对齐 */
.working { display: flex; align-items: center; gap: 6px; padding: 6px var(--pad-x); color: var(--text-2); font-size: var(--fs-sm); }
.typing { display: inline-flex; gap: 4px; align-items: center; }
.typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--text-3); animation: bounce 1.2s infinite; }
.typing i:nth-child(2) { animation-delay: 0.15s; }
.typing i:nth-child(3) { animation-delay: 0.3s; }
@keyframes bounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.5; } 30% { transform: translateY(-4px); opacity: 1; } }
.banner { border: 1px solid color-mix(in srgb, var(--err) 40%, transparent); background: var(--err-bg); padding: 12px 16px; margin: 6px 0 16px; border-radius: var(--r-md); }
.stderr { margin: 8px 0 0; max-height: 200px; overflow: auto; font-size: var(--fs-sm); white-space: pre-wrap; font-family: var(--font-code); }
.detach { border-color: color-mix(in srgb, var(--warn) 40%, transparent); background: color-mix(in srgb, var(--warn) 10%, var(--panel)); }
.detach-hint { margin-top: 6px; font-size: var(--fs-xs); color: var(--text-2); line-height: 1.7; }
/* 消息必须始终参与真实布局。content-visibility 的估算高度会在滚动时改变滚动范围，
   与浏览器滚动锚定、自动跟随底部叠加后，长回复可能出现滚动回跳、无法继续下滚。 */
/* 连续的助手消息：上一条的尾巴里本来就带着 24px 的段间距，这里退回去，只留消息内部那种 8px */
.mw.tight { margin-top: calc(var(--sp2) - var(--sp5)); }
/* 从右侧大纲跳过来的那个问题：气泡外面闪一圈强调色 */
.mw.flash :deep(.me-bubble) { animation: q-flash 1.6s ease-out; }
@keyframes q-flash { 0%, 35% { box-shadow: 0 0 0 3px var(--accent-soft), 0 0 0 1px var(--accent); } 100% { box-shadow: 0 0 0 3px transparent, 0 0 0 1px transparent; } }
.tobottom { position: absolute; left: 50%; top: -52px; transform: translateX(-50%); width: 38px; height: 38px; border-radius: var(--r-sm); border: 1px solid var(--line); background: var(--panel); color: var(--text-2); box-shadow: var(--shadow); cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 5; }
.tobottom:hover { color: var(--accent-text); }
/* --sb 是滚动条左右两边预留的总宽度（scrollbar-gutter: stable both-edges），输入框两边各让一半，和对话对齐。
   输入框比对话内容左右各宽 14px（--gut 减掉的量），不那么挤在卡片边上。
   整块悬浮在对话上面，只有砖头以外的地方（widget、队列、按钮、卡片）接鼠标事件 */
.dock { position: absolute; left: 0; right: 0; bottom: 0; max-width: calc(var(--chat-w) + 2 * var(--gut) + var(--sb, 0px)); margin: 0 auto; padding: 0 calc(var(--gut) - 14px + var(--sb, 0px) / 2) calc(var(--sp4) + 8px); pointer-events: none; }
.dock > .widget, .dock > .queue, .dock > .tobottom { pointer-events: auto; }
.widget { background: color-mix(in srgb, var(--warn) 10%, var(--panel)); border: 1px solid var(--line); border-radius: var(--r-md); padding: 8px 12px; margin-bottom: 8px; white-space: pre-wrap; font-size: var(--fs-sm); font-family: var(--font-code); }
.queue { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.qitem { display: flex; align-items: center; gap: 8px; font-size: var(--fs-sm); background: var(--panel); border: 1px dashed var(--line); border-radius: var(--r-sm); padding: 5px 10px; color: var(--text-2); }
.tag { background: var(--accent-soft); color: var(--accent-text); padding: 0 8px; border-radius: var(--r-pill); flex: none; font-size: var(--fs-xs); line-height: 20px; }

/* 和桌面规则放在同一个 scoped 样式块，避免移动端变量被更高优先级的桌面规则覆盖。 */
@media (max-width: 768px) {
  .chat { --gut: 16px; --pad-x: 10px; }
  .scroll { scrollbar-gutter: auto; }
  .chat .inner { padding: 14px var(--gut) 12px; max-width: none; }
  .chat .dock { padding: 0 calc(var(--gut) - 6px) max(8px, env(safe-area-inset-bottom)); max-width: none; }
  .chat .tips { grid-template-columns: minmax(0, 1fr); gap: 20px; }
}
</style>
