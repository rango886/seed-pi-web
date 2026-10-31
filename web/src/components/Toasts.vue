<script setup>
import { S } from '../store.js';
</script>

<template>
  <div class="toasts">
    <div v-for="t in S.toasts" :key="t.id" class="toast" :class="t.kind" @click="S.toasts = S.toasts.filter((x) => x.id !== t.id)">
      {{ t.text }}
    </div>
  </div>
</template>

<style scoped>
.toasts { position: fixed; right: 20px; bottom: 40px; display: flex; flex-direction: column; gap: 8px; z-index: 60; max-width: 420px; }
.toast { background: var(--elev); color: var(--text); border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: var(--r-md); padding: 10px 14px; box-shadow: var(--shadow-lg); white-space: pre-wrap; word-break: break-word; cursor: pointer; font-size: var(--fs-sm); line-height: 1.6; animation: slide 0.2s ease-out; }
.toast.error { border-left-color: var(--err); }
.toast.warning { border-left-color: var(--warn); }
@keyframes slide { from { opacity: 0; transform: translateX(16px); } }
</style>