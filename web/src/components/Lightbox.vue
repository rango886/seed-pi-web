<script setup>
// 灯箱：全屏看大图。对话里的图片、mermaid 图（右上角“全屏”按钮）都在这里看。
// - 左右按钮（或方向键）翻同一个会话里的其它图片
// - 滚轮 / 双指捏合缩放（以鼠标、手指所在的位置为中心），按住拖动，双击放大/还原
// - + / - / 0 键：放大、缩小、还原
// 状态放在 settings.js 的 view.lightbox 里，谁都能打开；这里只管画。
// 列表里的一项要么是图片 { src, alt }，要么是 svg 图 { svg, w, h, alt, name }（w/h 是图原本的尺寸）
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { view, stepLightbox } from '../settings.js';
import { saveBlob, nameFromUrl } from '../download.js';
import Icon from './Icon.vue';

const lb = computed(() => view.lightbox);
const cur = computed(() => (lb.value ? lb.value.list[lb.value.i] : null));
const many = computed(() => (lb.value?.list.length || 0) > 1);
const close = () => (view.lightbox = null);
const go = (d) => stepLightbox(d);

const mask = ref(null);
const stage = ref(null);

// ---------- 缩放和平移 ----------
// 内容先按“刚好放进窗口”摆好（scale = 1），再在上面叠一层 translate + scale
const MIN = 0.25;
const MAX = 12;
const scale = ref(1);
const tx = ref(0);
const ty = ref(0);
const anim = ref(false); // 按钮、双击这种“一下子”的缩放带个过渡；滚轮、拖动跟手，不要过渡
const transform = computed(() => `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`);
const pct = computed(() => Math.round(scale.value * 100) + '%');

function reset(smooth = true) {
  anim.value = smooth;
  scale.value = 1;
  tx.value = 0;
  ty.value = 0;
}

/** 缩放到 s，并且让屏幕上 (mx, my) 这个点下面的内容保持不动 */
function zoomAt(s, mx, my, smooth = false) {
  const el = stage.value;
  const m = mask.value;
  if (!el || !m) return;
  s = Math.min(MAX, Math.max(MIN, s));
  // 内容没加 transform 时的中心（offset* 不受 transform 影响，也不用等 Vue 把上一帧的 transform 写进 DOM）
  const mr = m.getBoundingClientRect();
  const cx = mr.left + el.offsetLeft + el.offsetWidth / 2 + tx.value;
  const cy = mr.top + el.offsetTop + el.offsetHeight / 2 + ty.value;
  // 缩放中心是内容的中心：鼠标离中心 d，缩放后这段距离也跟着变成 d * s'/s，差多少就平移补回来
  const dx = mx - cx;
  const dy = my - cy;
  const k = s / scale.value;
  tx.value += dx * (1 - k);
  ty.value += dy * (1 - k);
  scale.value = s;
  anim.value = smooth;
}

/** 以窗口中心缩放（按钮、键盘用） */
function zoomBy(f) {
  const r = mask.value?.getBoundingClientRect();
  if (r) zoomAt(scale.value * f, r.left + r.width / 2, r.top + r.height / 2, true);
}

function onWheel(e) {
  if (!stage.value) return;
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  // 触控板捏合会带 ctrlKey，数值小，放大一点灵敏度
  const f = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015));
  zoomAt(scale.value * f, e.clientX, e.clientY);
}

function onDbl(e) {
  if (!downOnStage) return;
  if (scale.value > 1.01 || scale.value < 0.99) reset();
  else zoomAt(2.5, e.clientX, e.clientY, true);
}

// 拖动 + 双指捏合：用 pointer 事件统一处理鼠标、触摸、笔
const pts = new Map(); // pointerId -> { x, y }
let moved = false; // 这次按下以后拖过了：松手时的 click 就别当“点空白处关闭”
let last = null; // 上一帧：单指时是那个点；双指时是 { mid, dist }
// 按下时点在哪：鼠标被遮罩 capture 以后，click / dblclick 的 target 都会变成遮罩自己，不准
let downOnMask = false;
let downOnStage = false;
const grabbing = ref(false);

const pinchInfo = () => {
  const [a, b] = [...pts.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
};

function onDown(e) {
  if (e.target.closest('.lb-btn, .lb-tools')) return void (downOnMask = downOnStage = moved = false);
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (pts.size === 0) {
    moved = false;
    downOnMask = e.target === mask.value;
    downOnStage = !!e.target.closest('.lb-stage');
  }
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  mask.value?.setPointerCapture?.(e.pointerId);
  last = pts.size >= 2 ? pinchInfo() : { x: e.clientX, y: e.clientY };
  anim.value = false;
}

function onMove(e) {
  const p = pts.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX;
  p.y = e.clientY;
  if (pts.size >= 2) {
    const now = pinchInfo();
    tx.value += now.x - last.x;
    ty.value += now.y - last.y;
    zoomAt(scale.value * (now.dist / last.dist), now.x, now.y);
    last = now;
    moved = true;
    grabbing.value = true;
    return;
  }
  const dx = e.clientX - last.x;
  const dy = e.clientY - last.y;
  if (!moved && Math.hypot(dx, dy) < 3) return;
  moved = true;
  grabbing.value = true;
  tx.value += dx;
  ty.value += dy;
  last = { x: e.clientX, y: e.clientY };
}

function onUp(e) {
  if (!pts.delete(e.pointerId)) return;
  // 双指放开一指：剩下那根手指接着拖，起点换成它现在的位置
  const rest = [...pts.values()][0];
  last = rest ? { x: rest.x, y: rest.y } : null;
  if (!rest) grabbing.value = false;
}

function onMaskClick() {
  if (moved) return (moved = false);
  if (downOnMask) close(); // 点空白处关闭；点在图上不关
}

// ---------- svg 图的尺寸：按窗口大小算一个“正好放进去”的宽高 ----------
const svgBox = ref({ w: 0, h: 0 });
function fitSvg() {
  const c = cur.value;
  const m = mask.value;
  if (!c?.svg || !m) return;
  const cs = getComputedStyle(m);
  const pad = 32; // .lb-svg 自己四周的留白
  const aw = m.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - pad;
  const ah = m.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - pad;
  // 矢量图放大不会糊，小图也撑大一些看着舒服，但别大得离谱
  const f = Math.max(0.05, Math.min(aw / c.w, ah / c.h, 3));
  svgBox.value = { w: Math.round(c.w * f), h: Math.round(c.h * f) };
}

watch(cur, () => {
  reset(false);
  pts.clear();
  nextTick(fitSvg);
});

// ---------- 下载 ----------
async function download() {
  const c = cur.value;
  if (!c) return;
  if (c.svg) return saveBlob(new Blob([c.svg], { type: 'image/svg+xml' }), c.name || 'diagram.svg');
  // 图片：先取成 blob 再存，文件名用本地路径的文件名（data: 地址的按 mime 补个后缀）
  let name = c.src.startsWith('data:') ? '' : nameFromUrl(c.src);
  try {
    const blob = await (await fetch(c.src)).blob();
    const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    if (!name) name = `image-${Date.now()}.${ext}`;
    else if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += `.${ext}`;
    saveBlob(blob, name);
  } catch {
    // 取不到（比如跨域）就让浏览器按原地址下
    const a = document.createElement('a');
    a.href = c.src;
    a.download = name || 'image';
    a.target = '_blank';
    a.rel = 'noopener';
    a.click();
  }
}

// keydown 用捕获：页面里别的快捷键（Esc 收菜单、方向键、Home/End）都别抢
function onKey(e) {
  if (!lb.value) return;
  const k = e.key;
  const act = {
    Escape: close,
    ArrowLeft: () => go(-1),
    ArrowRight: () => go(1),
    '+': () => zoomBy(1.5),
    '=': () => zoomBy(1.5),
    '-': () => zoomBy(1 / 1.5),
    '0': () => reset(),
  }[k];
  if (!act || e.ctrlKey || e.metaKey || e.altKey) return;
  e.preventDefault();
  e.stopPropagation();
  act();
}
const onResize = () => fitSvg();
onMounted(() => {
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', onResize);
});
// 开着的时候别让背后的对话跟着滚
watch(lb, (v) => (document.body.style.overflow = v ? 'hidden' : ''), { immediate: true });
onUnmounted(() => (document.body.style.overflow = ''));
</script>

<template>
  <div
    v-if="cur"
    ref="mask"
    class="lb-mask"
    :class="{ grabbing }"
    @click="onMaskClick"
    @dblclick="onDbl"
    @wheel.prevent="onWheel"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
    @contextmenu.prevent.stop
  >
    <div class="lb-tools">
      <button class="lb-btn" title="缩小（-）" @click="zoomBy(1 / 1.5)"><Icon name="minus" :size="18" /></button>
      <button class="lb-btn lb-pct" title="还原（0）" @click="reset()">{{ pct }}</button>
      <button class="lb-btn" title="放大（+）" @click="zoomBy(1.5)"><Icon name="plus" :size="18" /></button>
      <span class="lb-gap" />
      <button class="lb-btn" :title="cur.svg ? '下载这张图（SVG）' : '下载这张图'" @click="download"><Icon name="download" :size="18" /></button>
      <button class="lb-btn" title="关闭（Esc）" @click="close"><Icon name="close" :size="18" /></button>
    </div>
    <button v-if="many" class="lb-btn lb-nav lb-prev" title="上一张（←）" @click="go(-1)"><Icon name="chevron" :size="20" /></button>
    <div ref="stage" class="lb-stage" :class="{ anim }" :style="{ transform }" @transitionend="anim = false">
      <img v-if="!cur.svg" class="lb-img" :src="cur.src" :alt="cur.alt || ''" draggable="false" />
      <div v-else class="lb-svg" :style="{ width: svgBox.w + 'px', height: svgBox.h + 'px' }" v-html="cur.svg" />
    </div>
    <button v-if="many" class="lb-btn lb-nav lb-next" title="下一张（→）" @click="go(1)"><Icon name="chevron" :size="20" /></button>
    <div v-if="many || cur.alt" class="lb-foot">
      <span v-if="many" class="lb-count">{{ lb.i + 1 }} / {{ lb.list.length }}</span>
      <span v-if="cur.alt" class="lb-cap ellipsis">{{ cur.alt }}</span>
    </div>
  </div>
</template>

<style scoped>
.lb-mask { position: fixed; inset: 0; z-index: 90; display: flex; align-items: center; justify-content: center; padding: 56px 76px; overflow: hidden; background: color-mix(in srgb, #000 88%, transparent); backdrop-filter: blur(2px); animation: lbfade 0.15s ease-out; user-select: none; touch-action: none; cursor: grab; }
.lb-mask.grabbing { cursor: grabbing; }
@keyframes lbfade { from { opacity: 0; } }
/* 内容层：缩放、平移都是对它做 transform，图片自己只管“放进窗口” */
.lb-stage { display: flex; align-items: center; justify-content: center; max-width: 100%; max-height: 100%; transform-origin: center center; }
.lb-stage.anim { transition: transform 0.18s ease-out; }
/* 大图：按原比例缩到窗口里（contain），不裁不拉伸 */
.lb-img { display: block; max-width: calc(100vw - 152px); max-height: calc(100vh - 112px); object-fit: contain; border-radius: var(--r-md); box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55); -webkit-user-drag: none; }
/* svg 图：放在主题的面板底色上（图的颜色都跟着主题变量走），尺寸由脚本按窗口算好 */
.lb-svg { box-sizing: content-box; padding: 16px; flex: none; background: var(--panel); border-radius: var(--r-md); box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55); }
.lb-svg :deep(svg) { display: block; width: 100% !important; height: 100% !important; max-width: none !important; }
.lb-tools { position: absolute; top: 16px; right: 16px; z-index: 1; display: flex; align-items: center; gap: 6px; cursor: default; }
.lb-gap { width: 6px; }
.lb-btn { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border: 1px solid rgba(255, 255, 255, 0.18); background: rgba(255, 255, 255, 0.12); color: #fff; border-radius: var(--r-md); cursor: pointer; padding: 0; transition: background 0.15s, border-color 0.15s, transform 0.15s; }
.lb-btn:hover { background: rgba(255, 255, 255, 0.24); border-color: rgba(255, 255, 255, 0.38); }
.lb-pct { width: auto; min-width: 56px; padding: 0 8px; font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.lb-nav { position: absolute; z-index: 1; top: 50%; width: 44px; height: 44px; margin-top: -22px; border-radius: var(--r-md); }
.lb-prev { left: 16px; }
.lb-next { right: 16px; }
.lb-prev :deep(svg) { transform: rotate(180deg); }
.lb-next:hover { transform: translateX(1px); }
.lb-prev:hover { transform: translateX(-1px); }
.lb-foot { position: absolute; left: 0; right: 0; bottom: 16px; display: flex; justify-content: center; align-items: center; gap: 10px; padding: 0 88px; color: rgba(255, 255, 255, 0.72); font-size: var(--fs-sm); pointer-events: none; }
.lb-count { flex: none; padding: 2px 10px; border-radius: var(--r-pill); background: rgba(255, 255, 255, 0.14); font-variant-numeric: tabular-nums; }
.lb-cap { min-width: 0; }
@media (max-width: 768px) {
  .lb-mask { padding: 52px 12px 64px; }
  .lb-img { max-width: calc(100vw - 24px); max-height: calc(100vh - 116px); }
  .lb-tools { top: 10px; right: 10px; gap: 4px; }
  .lb-nav { width: 38px; height: 38px; margin-top: -19px; }
  .lb-prev { left: 8px; }
  .lb-next { right: 8px; }
  .lb-foot { padding: 0 16px; }
}
</style>
