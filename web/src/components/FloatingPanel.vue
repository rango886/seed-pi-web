<script setup>
import { onMounted, onUnmounted } from 'vue';
import Icon from './Icon.vue';

const props = defineProps({ open: Boolean, low: Boolean, inline: Boolean, title: String, icon: String });
const emit = defineEmits(['close']);
function onDown(e) {
  if (!props.open || props.inline || e.target.closest('.floating-panel, .panel-btn, .ctxmenu, .modal-mask')) return;
  emit('close');
}
onMounted(() => window.addEventListener('mousedown', onDown));
onUnmounted(() => window.removeEventListener('mousedown', onDown));
</script>

<template>
  <Transition name="fp">
    <aside v-if="open" class="floating-panel" :class="{ low, inline }" :aria-label="title" @keydown.esc.stop="emit('close')">
      <header class="panel-head">
        <Icon :name="icon" :size="16" />
        <span class="panel-title">{{ title }}</span>
        <slot name="badge" />
        <div class="grow" />
        <slot name="actions" />
        <button class="ib" title="关闭 (Esc)" :aria-label="`关闭${title}面板`" @click="emit('close')"><Icon name="close" :size="15" /></button>
      </header>
      <slot />
    </aside>
  </Transition>
</template>

<style scoped>
.floating-panel { position: absolute; z-index: 30; top: 58px; right: 8px; bottom: 8px; width: min(340px, calc(100% - 16px)); display: flex; flex-direction: column; background: var(--elev); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow-lg); overflow: hidden; user-select: none; }
.floating-panel.low { top: 86px; }
.floating-panel.inline { position: relative; inset: auto; width: 100%; min-height: 0; max-height: min(420px, 45vh); margin-bottom: 8px; overflow: auto; pointer-events: auto; }
.panel-head { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 6px 0 14px; flex: none; color: var(--text-2); border-bottom: 1px solid var(--line-2); }
.panel-title { font-weight: 600; color: var(--text); }
.ib { width: 30px; height: 30px; border: 0; background: transparent; border-radius: var(--r-sm); color: var(--text-2); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.ib:hover { background: var(--active); color: var(--text); }
.fp-enter-active, .fp-leave-active { transition: opacity 0.15s, transform 0.15s; }
.fp-enter-from, .fp-leave-to { opacity: 0; transform: translateX(12px); }
.inline.fp-enter-from, .inline.fp-leave-to { transform: translateY(8px); }
</style>
