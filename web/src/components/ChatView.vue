<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import { S, openDir } from '../store.js';
import MessageItem from './MessageItem.vue';
import Composer from './Composer.vue';
import { UI } from '../settings.js';
import Icon from './Icon.vue';

const scroller = ref(null);
const inner = ref(null);
const sbw = ref(0); // 滚动条占的宽度：输入框那栏也要让出同样宽度，两边才对得齐
let stick = true;
const away = ref(false); // 离底部比较远时显示回到底部按钮
let ro;

function onScroll() {
  const el = scroller.value;
  const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
  stick = gap < 40;
  away.value = gap > 400;
}
const jumpBottom = () => {
  stick = true;
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' });
};
const toBottom = () => {
  const el = scroller.value;
  if (el) el.scrollTop = el.scrollHeight;
};
onMounted(() => {
  // 内容变高时，如果用户本来就在底部，就跟着滚到底；顺便重新量一次滚动条宽度
  ro = new ResizeObserver(() => {
    measureSb();
    stick && toBottom();
  });
  ro.observe(inner.value);
  measureSb();
});
function measureSb() {
  const el = scroller.value;
  if (el) sbw.value = el.offsetWidth - el.clientWidth;
}
onUnmounted(() => ro?.disconnect());
// 后台标签页里 ResizeObserver 可能不触发，再用事件计数兜底
watch(
  () => S.tick,
  () => stick && nextTick(toBottom),
);
// 切换会话时回到底部
watch(
  () => S.agent?.sessionFile,
  () => {
    stick = true;
    nextTick(toBottom);
  },
);

// 代码块的“复制”按钮
function onClick(e) {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const code = btn.closest('pre')?.querySelector('code');
  if (code) {
    navigator.clipboard.writeText(code.innerText);
    btn.textContent = '已复制';
    setTimeout(() => (btn.textContent = '复制'), 1200);
  }
}

const widgetsAbove = computed(() => Object.entries(S.widgets).filter(([, w]) => w.placement !== 'belowEditor'));
const widgetsBelow = computed(() => Object.entries(S.widgets).filter(([, w]) => w.placement === 'belowEditor'));
const queued = computed(() => [...S.queue.steering.map((t) => ['插话', t]), ...S.queue.followUp.map((t) => ['排队', t])]);
const model = computed(() => S.state?.model);
</script>

<template>
  <div class="chat">
    <div ref="scroller" class="scroll" @scroll="onScroll" @click="onClick">
      <div ref="inner" class="inner">
        <div v-if="S.detached" class="banner detach">
          <div class="row">
            <b class="warn">这个会话原来的目录已经不存在了</b>
            <span class="dim ellipsis">{{ S.detached.cwd }}</span>
            <div class="grow" />
            <button class="btn" @click="S.dirPicker = true">选个新目录继续聊…</button>
          </div>
          <div class="detach-hint">现在只能看历史。换到一个新目录后会在那里开一个<b>新会话</b>（原来的对话还在这份历史里，随时能再打开看）。</div>
        </div>

        <div v-if="S.agentExited" class="banner">
          <div class="row">
            <b class="err">pi 进程已退出</b>
            <span class="dim">（退出码 {{ S.agentExited.code ?? '?' }}）</span>
            <div class="grow" />
            <button class="btn" @click="openDir(S.cwd, true)">重新启动</button>
          </div>
          <pre v-if="S.agentExited.stderr" class="stderr">{{ S.agentExited.stderr }}</pre>
        </div>

        <div v-if="!S.messages.length && !S.agentExited" class="welcome">
          <div class="big">π</div>
          <div class="wtitle">有什么可以帮你？</div>
          <div class="dim wcwd">{{ S.cwd }}</div>
          <div class="tips">
            <div class="tip"><kbd>/</kbd><span>命令菜单</span></div>
            <div class="tip"><kbd>!</kbd><span>执行 shell</span></div>
            <div class="tip"><kbd>@</kbd><span>侧栏文件点 @ 引用</span></div>
            <div class="tip"><kbd>Ctrl V</kbd><span>粘贴图片</span></div>
            <div class="tip"><kbd>Esc</kbd><span>停止</span></div>
            <div class="tip"><kbd>Ctrl P</kbd><span>切换会话</span></div>
          </div>
        </div>

        <div v-for="(m, i) in S.messages" :key="m._k" class="mw" :class="{ live: i >= S.messages.length - 2 }"><MessageItem :m="m" /></div>

        <div v-if="S.running || S.compacting || S.retry" class="working">
          <span class="typing"><i /><i /><i /></span>
          <span v-if="S.retry">第 {{ S.retry.attempt }}/{{ S.retry.maxAttempts }} 次重试：{{ S.retry.errorMessage }}</span>
          <span v-else-if="S.compacting">正在压缩上下文…</span>
          <span v-else>工作中</span>
          <span class="dim">· Esc 停止</span>
        </div>
      </div>
    </div>

    <div class="dock" :style="{ '--sb': sbw + 'px' }">
      <button v-show="away" class="tobottom" title="回到底部" @click="jumpBottom"><Icon name="down" :size="18" /></button>
      <div v-for="[k, w] in widgetsAbove" :key="k" class="widget">
        <div v-for="(l, i) in w.lines" :key="i">{{ l }}</div>
      </div>
      <div v-if="queued.length" class="queue">
        <div v-for="([kind, t], i) in queued" :key="i" class="qitem">
          <span class="tag">{{ kind }}</span><span class="ellipsis">{{ t }}</span>
        </div>
      </div>
      <Composer />
      <div v-for="[k, w] in widgetsBelow" :key="k" class="widget">
        <div v-for="(l, i) in w.lines" :key="i">{{ l }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat { flex: 1; display: flex; flex-direction: column; min-height: 0; background: var(--chat-bg); }
.scroll { flex: 1; overflow-y: auto; }
.inner { padding: var(--sp5) calc(var(--sp5) + 48px) var(--sp4); max-width: calc(var(--chat-w) + 144px); margin: 0 auto; }
.welcome { text-align: center; padding: 12vh 0 20px; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.welcome .big { width: 64px; height: 64px; border-radius: 18px; background: var(--accent); color: #fff; font-size: 34px; font-weight: 700; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 24px var(--accent-soft); margin-bottom: 10px; }
.wtitle { font-size: calc(var(--fs) + 6px); font-weight: 600; }
.wcwd { font-size: var(--fs-sm); }
.tips { margin-top: 28px; display: grid; grid-template-columns: repeat(3, auto); gap: 10px 26px; font-size: var(--fs-sm); color: var(--text-2); }
.tip { display: flex; align-items: center; gap: 8px; }
kbd { font-family: var(--font-code); font-size: var(--fs-xs); background: var(--panel); border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 5px; padding: 1px 7px; color: var(--text); min-width: 24px; text-align: center; }
.working { display: flex; align-items: center; gap: 8px; padding: 6px 0; color: var(--text-2); font-size: var(--fs-sm); }
.typing { display: inline-flex; gap: 3px; background: var(--bubble-ai); padding: 8px 10px; border-radius: 12px; box-shadow: var(--shadow-sm); }
.typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--text-3); animation: bounce 1.2s infinite; }
.typing i:nth-child(2) { animation-delay: 0.15s; }
.typing i:nth-child(3) { animation-delay: 0.3s; }
@keyframes bounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.5; } 30% { transform: translateY(-4px); opacity: 1; } }
.banner { border: 1px solid color-mix(in srgb, var(--err) 40%, transparent); background: var(--err-bg); padding: 12px 16px; margin: 6px 0 16px; border-radius: var(--r-md); }
.stderr { margin: 8px 0 0; max-height: 200px; overflow: auto; font-size: var(--fs-sm); white-space: pre-wrap; font-family: var(--font-code); }
.detach { border-color: color-mix(in srgb, var(--warn) 40%, transparent); background: color-mix(in srgb, var(--warn) 10%, var(--panel)); }
.detach-hint { margin-top: 6px; font-size: var(--fs-xs); color: var(--text-2); line-height: 1.7; }
.mw { content-visibility: auto; contain-intrinsic-size: auto 160px; }
.mw.live { content-visibility: visible; }
.tobottom { position: absolute; left: 50%; top: -52px; transform: translateX(-50%); width: 38px; height: 38px; border-radius: 50%; border: 1px solid var(--line); background: var(--panel); color: var(--text-2); box-shadow: var(--shadow); cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 5; }
.tobottom:hover { color: var(--accent-text); }
.dock { position: relative; flex: none; max-width: calc(var(--chat-w) + 144px + var(--sb, 0px)); width: 100%; margin: 0 auto; padding: 0 calc(var(--sp5) + 48px) var(--sp4); padding-right: calc(var(--sp5) + 48px + var(--sb, 0px)); }
.widget { background: color-mix(in srgb, var(--warn) 10%, var(--panel)); border: 1px solid var(--line); border-radius: var(--r-md); padding: 8px 12px; margin-bottom: 8px; white-space: pre-wrap; font-size: var(--fs-sm); font-family: var(--font-code); }
.queue { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.qitem { display: flex; align-items: center; gap: 8px; font-size: var(--fs-sm); background: var(--panel); border: 1px dashed var(--line); border-radius: var(--r-sm); padding: 5px 10px; color: var(--text-2); }
.tag { background: var(--accent-soft); color: var(--accent-text); padding: 0 8px; border-radius: 10px; flex: none; font-size: var(--fs-xs); line-height: 20px; }
</style>

<style>
@media (max-width: 768px) {
  .chat .inner { padding: 16px 12px 12px; max-width: none; }
  .chat .dock { padding: 0 12px max(8px, env(safe-area-inset-bottom)); max-width: none; }
  /* 手机上横向空间金贵，头像就不摆了 */
  .chat .msg .avatar { display: none; }
  .chat .welcome { padding-top: 8vh; }
  .chat .tips { grid-template-columns: repeat(2, auto); gap: 10px 18px; }
}
</style>
