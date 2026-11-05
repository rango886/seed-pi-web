<script setup>
import { computed } from 'vue';
import { UI } from '../settings.js';
import { useBlockDisplay } from '../block-display.js';

const props = defineProps({ block: Object, streaming: Boolean });
const { open, toggle } = useBlockDisplay(() => UI.thinkingDisplay);
const text = computed(() => (props.block.thinking || '').trim());
const preview = computed(() => text.value.replace(/\s+/g, ' ').slice(0, 200));
</script>

<template>
  <div class="blk prose thinking-block" :class="{ open }">
    <div class="blk-head" role="button" tabindex="0" :aria-expanded="open" @click="toggle" @keydown.enter.self.prevent="toggle" @keydown.space.self.prevent="toggle">
      <span class="blk-chip">Thinking{{ block.redacted ? ' (hidden)' : '' }}</span>
      <span v-if="!open && preview" class="ellipsis grow blk-sum think-prev" :title="preview">{{ preview }}</span>
      <span v-if="streaming" class="spin" />
      <svg class="blk-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6l6 6-6 6" /></svg>
    </div>
    <div v-if="open && text" class="blk-body prose thinking-text">{{ text }}</div>
  </div>
</template>
