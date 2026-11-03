<script setup>
// 对话右侧的问题大纲：平时只是一列淡淡的短横线（一条 = 用户问的一个问题），
// 鼠标移上去才浮出问题列表，点一下滚到那个问题。当前读到的那个问题会高亮。
import { computed, ref, watch, onUnmounted, nextTick } from 'vue';
import { S } from '../store.js';
import { textOf, splitAttachments } from '../util.js';

const props = defineProps({ scroller: Object });
const emit = defineEmits(['jump']);

const PREVIEW = 300; // 列表里最多放这么多字（再多也只显示两行，没必要塞进 DOM）
const TITLE_MAX = 800; // 悬停原生提示里放的全文上限

// 用户问的每一个问题：去掉附件块、把换行抹平；只发了图/附件的给个说明
const items = computed(() => {
  const out = [];
  for (const m of S.messages) {
    if (m.role !== 'user') continue;
    const { text, attachments } = splitAttachments(textOf(m.content));
    let t = text.replace(/\s+/g, ' ').trim();
    const pics = Array.isArray(m.content) ? m.content.filter((c) => c?.type === 'image').length : 0;
    if (!t) t = attachments.length ? `[${attachments.length} 个附件]` : pics ? `[${pics} 张图片]` : '[空消息]';
    out.push({
      k: String(m._k),
      text: t.length > PREVIEW ? t.slice(0, PREVIEW) + '…' : t,
      // 只有长到可能被截断的才挂原生提示，短的不用
      title: t.length > 60 ? (t.length > TITLE_MAX ? t.slice(0, TITLE_MAX) + '…' : t) : null,
    });
  }
  return out;
});
const n = computed(() => items.value.length);
// 横线沿着竖条均匀排开：问题再多也不会把竖条撑得比屏幕还高
const tickTop = (i) => (n.value <= 1 ? 50 : (i / (n.value - 1)) * 100) + '%';

// ---------- 当前读到哪个问题 ----------
// 视口上面 30% 那条线以上、最靠下的那个用户问题就算“当前”
const active = ref(null);
let raf = 0;
function update() {
  raf = 0;
  const sc = props.scroller;
  if (!sc) return;
  const line = sc.getBoundingClientRect().top + sc.clientHeight * 0.3;
  let cur = null;
  for (const el of sc.querySelectorAll('.msg[data-role="user"]')) {
    if (el.getBoundingClientRect().top > line) break;
    cur = el.dataset.msg;
  }
  active.value = cur ?? items.value[0]?.k ?? null;
}
const schedule = () => raf || (raf = requestAnimationFrame(update));
watch(
  () => props.scroller,
  (el, old) => {
    old?.removeEventListener('scroll', schedule);
    el?.addEventListener('scroll', schedule, { passive: true });
    schedule();
  },
  { immediate: true },
);
watch(n, () => nextTick(schedule));
onUnmounted(() => {
  props.scroller?.removeEventListener('scroll', schedule);
  cancelAnimationFrame(raf);
});

// ---------- 跳转 ----------
const frame = () => new Promise((r) => requestAnimationFrame(r));
async function jump(k) {
  const sc = props.scroller;
  const el = sc?.querySelector(`.msg[data-msg="${CSS.escape(k)}"]`)?.closest('.mw');
  if (!el) return;
  emit('jump'); // 让对话别再“贴着底部”，不然内容一变高又被拽回底部
  const target = () => el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 12;
  // 离得远的：先瞬移到目标附近，再平滑滚最后一小段（又快又有方向感）。
  // 消息用了 content-visibility，没显示过的高度是估的，瞬移后要多量几次才准
  if (Math.abs(target() - sc.scrollTop) > sc.clientHeight * 1.5) {
    const dir = target() > sc.scrollTop ? 1 : -1;
    for (let i = 0; i < 3; i++) {
      sc.scrollTop = target() - dir * sc.clientHeight * 0.4;
      await frame();
    }
  }
  sc.scrollTo({ top: target(), behavior: 'smooth' });
  // 平滑滚完再校准一次（滚的过程中上面的消息可能刚算出真实高度）
  let done = false;
  const fix = () => {
    if (done) return;
    done = true;
    sc.removeEventListener('scrollend', fix);
    const t = target();
    if (Math.abs(sc.scrollTop - t) > 4) sc.scrollTop = t;
  };
  sc.addEventListener('scrollend', fix);
  setTimeout(fix, 700);
  // 闪一下，告诉用户跳到的是哪条
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  clearTimeout(el._flashT);
  el._flashT = setTimeout(() => el.classList.remove('flash'), 1600);
}

// 列表打开时，把当前那条滚进可视范围
const listEl = ref(null);
function onEnter() {
  nextTick(() => {
    const box = listEl.value;
    const on = box?.querySelector('.on');
    if (!box || !on) return;
    if (on.offsetTop < box.scrollTop || on.offsetTop + on.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = on.offsetTop - box.clientHeight / 2 + on.offsetHeight / 2;
    }
  });
}
</script>

<template>
  <nav v-if="n >= 2" class="outline" aria-label="本会话的问题" @mouseenter="onEnter">
    <div class="rail" :style="{ height: `min(${n * 12}px, 40vh)` }">
      <i v-for="(it, i) in items" :key="it.k" class="tick" :class="{ on: it.k === active }" :style="{ top: tickTop(i) }" />
    </div>
    <div ref="listEl" class="list">
      <div class="head">本会话的问题 · {{ n }}</div>
      <button v-for="(it, i) in items" :key="it.k" class="item" :class="{ on: it.k === active }" :title="it.title" @click="jump(it.k)">
        <span class="no">{{ i + 1 }}</span>
        <span class="txt">{{ it.text }}</span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
/* 整块贴在对话区右边（让开滚动条），竖直方向稍微偏上，避开底下的输入框 */
.outline { position: absolute; top: 42%; right: calc(var(--sb, 0px) + 2px); transform: translateY(-50%); z-index: 6; padding: 10px 8px; }
.rail { position: relative; width: 18px; min-height: 24px; opacity: 0.55; transition: opacity 0.15s; }
.outline:hover .rail { opacity: 1; }
/* 一条横线 = 一个问题；当前的那条变长、变成强调色 */
.tick { position: absolute; right: 0; width: 10px; height: 2px; margin-top: -1px; border-radius: 2px; background: var(--text-3); transition: width 0.15s, background 0.15s; }
.tick.on { width: 18px; background: var(--accent); }

/* 悬停才出现的问题列表：从竖条左边浮出来 */
.list {
  position: absolute; right: 100%; top: 50%; transform: translate(6px, -50%);
  width: 300px; max-height: min(60vh, 520px); overflow-y: auto; overscroll-behavior: contain;
  padding: 4px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-md); box-shadow: var(--shadow);
  opacity: 0; visibility: hidden; pointer-events: none;
  transition: opacity 0.15s, transform 0.15s, visibility 0s linear 0.15s;
}
.outline:hover .list { opacity: 1; visibility: visible; pointer-events: auto; transform: translate(0, -50%); transition-delay: 0.08s, 0.08s, 0s; }
.head { padding: 4px 8px 6px; font-size: var(--fs-xs); color: var(--text-3); }
.item { display: flex; gap: 8px; width: 100%; padding: 6px 8px; border: 0; border-radius: var(--r-sm); background: none; text-align: left; cursor: pointer; color: var(--text-2); font: inherit; font-size: var(--fs-sm); line-height: 1.45; }
.item:hover { background: var(--hover); color: var(--text); }
.item.on { color: var(--accent-text); background: var(--accent-softer, var(--hover)); }
.no { flex: none; min-width: 1.4em; text-align: right; color: var(--text-3); font-variant-numeric: tabular-nums; }
/* 长问题只显示两行，超出用省略号；超长的一个“单词”（URL、路径）也要能断开 */
.txt { min-width: 0; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; word-break: break-word; overflow-wrap: anywhere; }
@media (max-width: 768px), (hover: none) {
  .outline { display: none; }
}
</style>
