<script setup>
// 图片灯箱：点对话里的图片就全屏看大图，左右按钮（或者方向键）翻同一个会话里的其它图片。
// 状态放在 settings.js 的 view.lightbox 里，谁都能打开；这里只管画。
import { computed, watch, onMounted, onUnmounted } from 'vue';
import { view, stepLightbox } from '../settings.js';
import Icon from './Icon.vue';

const lb = computed(() => view.lightbox);
const cur = computed(() => (lb.value ? lb.value.list[lb.value.i] : null));
const many = computed(() => (lb.value?.list.length || 0) > 1);
const close = () => (view.lightbox = null);
const go = (d) => stepLightbox(d);

// 下载当前这张图：先取成 blob 再存，文件名用本地路径的文件名（data: 地址的按 mime 补个后缀）
async function download() {
  const c = cur.value;
  if (!c) return;
  let name = '';
  try {
    // 本地图片的地址是 /api/fs/raw?path=C:\Users\…\out\x.png，把 path 里的文件名拿出来
    const p = new URL(c.src, location.href).searchParams.get('path');
    if (p) name = p.split(/[\\/]/).pop() || '';
  } catch {}
  try {
    const blob = await (await fetch(c.src)).blob();
    const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    if (!name) name = `image-${Date.now()}.${ext}`;
    else if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += `.${ext}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
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
  if (k !== 'Escape' && k !== 'ArrowLeft' && k !== 'ArrowRight') return;
  e.preventDefault();
  e.stopPropagation();
  if (k === 'Escape') close();
  else go(k === 'ArrowLeft' ? -1 : 1);
}
onMounted(() => window.addEventListener('keydown', onKey, true));
onUnmounted(() => window.removeEventListener('keydown', onKey, true));
// 开着的时候别让背后的对话跟着滚
watch(lb, (v) => (document.body.style.overflow = v ? 'hidden' : ''), { immediate: true });
onUnmounted(() => (document.body.style.overflow = ''));
</script>

<template>
  <div v-if="cur" class="lb-mask" @click.self="close" @contextmenu.prevent.stop>
    <button class="lb-btn lb-dl" title="下载这张图" @click="download"><Icon name="download" :size="18" /></button>
    <button class="lb-btn lb-close" title="关闭（Esc）" @click="close"><Icon name="close" :size="18" /></button>
    <button v-if="many" class="lb-btn lb-nav lb-prev" title="上一张（←）" @click="go(-1)"><Icon name="chevron" :size="20" /></button>
    <img class="lb-img" :src="cur.src" :alt="cur.alt || ''" />
    <button v-if="many" class="lb-btn lb-nav lb-next" title="下一张（→）" @click="go(1)"><Icon name="chevron" :size="20" /></button>
    <div v-if="many || cur.alt" class="lb-foot">
      <span v-if="many" class="lb-count">{{ lb.i + 1 }} / {{ lb.list.length }}</span>
      <span v-if="cur.alt" class="lb-cap ellipsis">{{ cur.alt }}</span>
    </div>
  </div>
</template>

<style scoped>
.lb-mask { position: fixed; inset: 0; z-index: 90; display: flex; align-items: center; justify-content: center; padding: 56px 76px; background: color-mix(in srgb, #000 88%, transparent); backdrop-filter: blur(2px); animation: lbfade 0.15s ease-out; user-select: none; }
@keyframes lbfade { from { opacity: 0; } }
/* 大图：按原比例缩到窗口里（contain），不裁不拉伸 */
.lb-img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: var(--r-md); box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55); }
.lb-btn { position: absolute; display: inline-flex; align-items: center; justify-content: center; border: 1px solid rgba(255, 255, 255, 0.18); background: rgba(255, 255, 255, 0.12); color: #fff; border-radius: var(--r-md); cursor: pointer; padding: 0; transition: background 0.15s, border-color 0.15s, transform 0.15s; }
.lb-btn:hover { background: rgba(255, 255, 255, 0.24); border-color: rgba(255, 255, 255, 0.38); }
.lb-close { top: 16px; right: 16px; width: 34px; height: 34px; }
.lb-dl { top: 16px; right: 58px; width: 34px; height: 34px; }
.lb-nav { top: 50%; width: 44px; height: 44px; margin-top: -22px; border-radius: 50%; }
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
  .lb-nav { width: 38px; height: 38px; margin-top: -19px; }
  .lb-prev { left: 8px; }
  .lb-next { right: 8px; }
  .lb-foot { padding: 0 16px; }
}
</style>
