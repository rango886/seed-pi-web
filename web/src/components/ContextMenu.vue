<script setup>
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { view } from '../settings.js';
import Icon from './Icon.vue';

const el = ref(null);
const pos = ref({ left: 0, top: 0 });
const sub = ref(-1);
const subLeft = ref(false); // 右边放不下时子菜单往左开

watch(
  () => view.ctx,
  (c) => {
    sub.value = -1;
    if (!c) return;
    pos.value = { left: c.x, top: c.y };
    nextTick(() => {
      const r = el.value?.getBoundingClientRect();
      if (!r) return;
      const W = window.innerWidth;
      const H = window.innerHeight;
      pos.value = {
        left: Math.max(8, Math.min(c.x, W - r.width - 8)),
        top: Math.max(8, c.y + r.height > H - 8 ? Math.max(8, c.y - r.height) : c.y),
      };
      subLeft.value = pos.value.left + r.width * 2 + 16 > W;
    });
  },
);

const close = () => (view.ctx = null);
function run(it, i) {
  if (it.disabled) return;
  if (it.children) {
    sub.value = sub.value === i ? -1 : i;
    return;
  }
  close();
  it.run?.();
}
const onDown = (e) => view.ctx && !e.target.closest('.ctxmenu') && close();
const onKey = (e) => view.ctx && e.key === 'Escape' && (e.stopPropagation(), close());
onMounted(() => {
  window.addEventListener('mousedown', onDown, true);
  window.addEventListener('touchstart', onDown, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
});
onUnmounted(() => {
  window.removeEventListener('mousedown', onDown, true);
  window.removeEventListener('touchstart', onDown, true);
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('blur', close);
  window.removeEventListener('resize', close);
});
</script>

<template>
  <div v-if="view.ctx" ref="el" class="ctxmenu" :style="{ left: pos.left + 'px', top: pos.top + 'px' }" @contextmenu.prevent>
    <template v-for="(it, i) in view.ctx.items" :key="i">
      <div v-if="it === '-'" class="sep" />
      <div
        v-else
        class="mi"
        :class="{ dis: it.disabled, danger: it.danger, open: sub === i }"
        @mouseenter="!view.mobile && (sub = it.children ? i : -1)"
        @click="run(it, i)"
      >
        <span class="ic"><Icon v-if="it.check" name="check" :size="16" /><Icon v-else-if="it.icon" :name="it.icon" :size="16" /></span>
        <span class="grow ellipsis">{{ it.label }}</span>
        <span v-if="it.hint" class="key">{{ it.hint }}</span>
        <span v-if="it.key && !view.mobile" class="key">{{ it.key }}</span>
        <Icon v-if="it.children" name="chevron" :size="14" class="chev" />

        <div v-if="it.children && sub === i" class="ctxmenu submenu" :class="{ left: subLeft, inline: view.mobile }" @click.stop>
          <template v-for="(c, j) in it.children" :key="j">
            <div v-if="c === '-'" class="sep" />
            <div v-else class="mi" :class="{ dis: c.disabled, danger: c.danger }" @click="run(c, j)">
              <span class="ic"><Icon v-if="c.check" name="check" :size="16" /><Icon v-else-if="c.icon" :name="c.icon" :size="16" /></span>
              <span class="grow ellipsis">{{ c.label }}</span>
              <span v-if="c.hint" class="key">{{ c.hint }}</span>
            </div>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ctxmenu { position: fixed; z-index: 70; min-width: 240px; max-width: 340px; background: var(--elev); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow-lg); padding: 6px; user-select: none; animation: pop 0.1s ease-out; font-size: var(--fs-sm); }
.submenu { position: absolute; left: calc(100% + 2px); top: -6px; }
.submenu.left { left: auto; right: calc(100% + 2px); }
/* 窄屏：子菜单直接在下面展开 */
.submenu.inline { position: static; box-shadow: none; border: 0; padding: 2px 0 2px 16px; min-width: 0; background: transparent; animation: none; width: 100%; }
.mi { position: relative; display: flex; align-items: center; flex-wrap: wrap; gap: 10px; min-height: 34px; padding: 0 10px 0 8px; border-radius: var(--r-sm); cursor: pointer; color: var(--text); }
.mi:hover, .mi.open { background: var(--hover); }
.mi.dis { opacity: 0.4; cursor: default; }
.mi.dis:hover { background: transparent; }
.mi.danger { color: var(--err); }
.ic { width: 18px; display: inline-flex; justify-content: center; color: var(--text-2); }
.danger .ic { color: var(--err); }
.key { color: var(--text-3); font-size: var(--fs-xs); white-space: nowrap; }
.chev { color: var(--text-3); }
.sep { margin: 5px 6px; }
</style>
