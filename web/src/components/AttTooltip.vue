<script setup>
// 附件缩略图的悬停浮层：编号 + 全名 + 完整路径 + 一行附加信息（来源/大小之类）。
// 输入框里的附件和发出去的消息里的附件共用这一套，样子和位置算法都不用写两遍。
// 挂在 body 上（Teleport），所以不会被输入框、对话区或者侧栏裁掉。
import { ref, nextTick, watch } from 'vue';

const props = defineProps({
  // null 或 { anchor: DOMRect, index: 序号, name, path, info }
  tip: Object,
});

const el = ref(null);
const pos = ref({ x: 0, y: 0, on: false });

// 先挂上去量一下实际宽高，再摆到缩略图正上方、左右夹在视口里；
// 第一帧是透明的（pos.on 还是 false），所以位置算完之前不会闪一下
watch(
  () => props.tip,
  async (t) => {
    pos.value = { x: 0, y: 0, on: false };
    if (!t) return;
    await nextTick();
    const box = el.value;
    if (!box || !props.tip) return;
    const a = t.anchor;
    const x = Math.round(Math.min(Math.max(8, a.left + a.width / 2 - box.offsetWidth / 2), window.innerWidth - box.offsetWidth - 8));
    const y = Math.round(Math.max(8, a.top - box.offsetHeight - 8));
    pos.value = { x, y, on: true };
  },
);
</script>

<template>
  <Teleport to="body">
    <div v-if="tip" ref="el" class="att-tip" :class="{ on: pos.on }" :style="{ left: pos.x + 'px', top: pos.y + 'px' }">
      <div class="tip-head">
        <span class="tip-no">{{ tip.index }}</span>
        <span class="tip-name">{{ tip.name }}</span>
      </div>
      <div v-if="tip.path" class="tip-path">{{ tip.path }}</div>
      <div v-if="tip.info" class="tip-info">{{ tip.info }}</div>
    </div>
  </Teleport>
</template>

<style scoped>
.att-tip { position: fixed; z-index: 60; max-width: min(420px, calc(100vw - 16px)); padding: 8px 10px; border-radius: var(--r-md); background: var(--elev); border: 1px solid var(--line); box-shadow: var(--shadow-lg); font-size: var(--fs-xs); line-height: 1.55; color: var(--text-2); opacity: 0; transform: translateY(2px); transition: opacity 0.12s, transform 0.12s; pointer-events: none; }
.att-tip.on { opacity: 1; transform: none; }
.tip-head { display: flex; align-items: baseline; gap: 6px; color: var(--text); font-size: var(--fs-sm); }
.tip-no { flex: none; min-width: 17px; height: 17px; padding: 0 5px; border-radius: var(--r-pill); background: var(--accent-soft); color: var(--accent-text); font-size: 11px; font-weight: 600; line-height: 17px; text-align: center; font-variant-numeric: tabular-nums; }
.tip-name { min-width: 0; overflow-wrap: anywhere; }
.tip-path { margin-top: 5px; font-family: var(--font-code); color: var(--text-3); overflow-wrap: anywhere; }
.tip-info { margin-top: 2px; color: var(--text-3); }
</style>
