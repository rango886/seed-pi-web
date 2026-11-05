<script setup>
import { computed, ref, watch } from 'vue';
import { UI } from '../settings.js';
import { useBlockDisplay } from '../block-display.js';

const props = defineProps({ block: Object, streaming: Boolean });
const { open, toggle } = useBlockDisplay(() => UI.thinkingDisplay);
const text = computed(() => (props.block.thinking || '').trim());
const preview = computed(() => text.value.replace(/\s+/g, ' ').slice(0, 200));
const tailEl = ref(null);
// 生成时只保留末尾六行；单个长段落也限制长度，再通过滚动跟到折行后的最底部。
const livePreview = computed(() => props.streaming ? text.value.slice(-2400).split('\n').slice(-6).join('\n') : '');
watch(
  [livePreview, tailEl, open, () => props.streaming, () => UI.thinkingFontSize, () => UI.lineHeight],
  () => {
    const el = tailEl.value;
    if (el && props.streaming && !open.value) el.scrollTop = el.scrollHeight;
  },
  { flush: 'post' },
);
</script>

<template>
  <div class="blk prose thinking-block" :class="{ open }">
    <div class="blk-head" role="button" tabindex="0" :aria-expanded="open" @click="toggle" @keydown.enter.self.prevent="toggle" @keydown.space.self.prevent="toggle">
      <span class="blk-chip">Thinking{{ block.redacted ? ' (hidden)' : '' }}</span>
      <span v-if="!open && !streaming && preview" class="ellipsis grow blk-sum think-prev" :title="preview">{{ preview }}</span>
      <span v-if="streaming" class="spin" />
      <svg class="blk-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6l6 6-6 6" /></svg>
    </div>
    <div v-if="!open && livePreview" ref="tailEl" class="blk-body prose thinking-tail">{{ livePreview }}</div>
    <div v-if="open && text" class="blk-body prose thinking-text">{{ text }}</div>
  </div>
</template>
