<script setup>
import { S } from '../store.js';
import Icon from './Icon.vue';

function dismiss(id) {
  S.toasts = S.toasts.filter((t) => t.id !== id);
}
</script>

<template>
  <TransitionGroup name="notice" tag="div" class="toasts" aria-label="通知">
    <div v-for="t in S.toasts" :key="t.id" class="toast" :class="t.kind" :role="t.kind === 'error' ? 'alert' : 'status'" aria-atomic="true" @click="dismiss(t.id)">
      <Icon class="toast-icon" :name="t.kind === 'error' ? 'close' : t.kind === 'success' ? 'check' : 'info'" :size="16" aria-hidden="true" />
      <div class="toast-content">
        <div class="toast-text">{{ t.text }}</div>
        <a v-if="t.action?.href" class="toast-action" :href="t.action.href" target="_blank" rel="noopener noreferrer" @click.stop="dismiss(t.id)">{{ t.action.label }}</a>
        <button v-else-if="t.action" type="button" class="toast-action" @click.stop="dismiss(t.id); t.action.run()">{{ t.action.label }}</button>
      </div>
      <button type="button" class="toast-close" title="关闭通知" aria-label="关闭通知" @click.stop="dismiss(t.id)"><Icon name="close" :size="14" /></button>
    </div>
  </TransitionGroup>
</template>

<style scoped>
/* 顶栏下方的右上角通知区；空白区域不挡点击，窄屏和安全区内也不会溢出。
   显式隐藏横向溢出，避免 translateX 入场 / 退场时短暂出现底部横向滚动条。 */
.toasts { position: fixed; top: calc(56px + env(safe-area-inset-top, 0px)); right: calc(16px + env(safe-area-inset-right, 0px)); width: min(380px, calc(100vw - 32px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px))); max-height: calc(100dvh - 72px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)); display: flex; flex-direction: column; gap: var(--sp2); padding: 4px; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; z-index: 60; pointer-events: none; }
.toast { --notice-color: var(--accent-text); display: flex; align-items: flex-start; gap: 10px; flex: none; background: var(--elev); color: var(--text); border: 1px solid var(--line); border-radius: var(--r-md); padding: 12px; box-shadow: var(--shadow); cursor: pointer; font-family: var(--font); font-size: var(--fs-sm); line-height: 1.6; pointer-events: auto; }
.toast-icon { color: var(--notice-color); margin-top: 2px; }
.toast-content { flex: 1; min-width: 0; }
.toast-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.toast-action { display: inline-block; margin-top: 6px; padding: 0; border: 0; background: transparent; color: var(--accent-text); font: inherit; cursor: pointer; text-decoration: none; }
.toast-close { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 24px; height: 24px; margin: -2px -2px 0 0; padding: 0; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text-3); cursor: pointer; }
.toast-close:hover { background: var(--hover); color: var(--text); }
.toast-close:focus-visible, .toast-action:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.toast.error { --notice-color: var(--err); }
.toast.warning { --notice-color: var(--warn); }
.toast.success { --notice-color: var(--ok); }
.notice-enter-active, .notice-leave-active { transition: opacity 0.18s ease, transform 0.18s ease; }
.notice-enter-from, .notice-leave-to { opacity: 0; transform: translateX(12px); }
@media (prefers-reduced-motion: reduce) {
  .notice-enter-active, .notice-leave-active { transition: none; }
  .notice-enter-from, .notice-leave-to { transform: none; }
}
</style>