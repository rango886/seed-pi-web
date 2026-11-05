<script setup>
import { ref, onMounted, nextTick } from 'vue';
import { S, sendEdit, cancelEdit, uploadEditFiles, branchDisabled } from '../store.js';
import { rawUrl } from '../api.js';

const input = ref(null);
const files = ref(null);
onMounted(() => nextTick(() => input.value?.focus()));
function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendEdit(); }
}
function paste(e) {
  if (!e.clipboardData?.files.length) return;
  e.preventDefault();
  uploadEditFiles([...e.clipboardData.files]);
}
function drop(e) {
  e.preventDefault();
  if (e.dataTransfer?.files.length) uploadEditFiles([...e.dataTransfer.files]);
}
</script>

<template>
  <div v-if="S.edit" class="user-editor" @keydown.stop="onKey" @dragover.prevent @drop="drop">
    <div v-if="S.edit.attachments.length || S.edit.images.length" class="edit-atts">
      <div v-for="(a, i) in S.edit.attachments" :key="a.id" class="edit-att" :title="a.path">
        <img v-if="a.kind === 'image' && a.path" :src="rawUrl(a.path)" alt="" />
        <span class="ellipsis">{{ a.name }}{{ a.status === 'uploading' ? ' · 上传中…' : '' }}</span>
        <button type="button" :disabled="S.branchBusy" :aria-label="`移除 ${a.name}`" @click="S.edit.attachments.splice(i, 1)">×</button>
      </div>
      <div v-for="(im, i) in S.edit.images" :key="i" class="edit-att">
        <img :src="`data:${im.mimeType};base64,${im.data}`" alt="原消息图片" />
        <button type="button" :disabled="S.branchBusy" aria-label="移除图片" @click="S.edit.images.splice(i, 1)">×</button>
      </div>
    </div>
    <textarea ref="input" v-model="S.edit.text" rows="5" aria-label="修改用户消息" :disabled="S.branchBusy" @paste="paste" />
    <div v-if="S.edit.error" class="edit-error" role="alert">{{ S.edit.error }}</div>
    <div class="actions">
      <button type="button" class="btn sm" :disabled="S.branchBusy" @click="files.click()">添加附件</button>
      <input ref="files" type="file" multiple hidden @change="uploadEditFiles([...$event.target.files]); $event.target.value = ''" />
      <span class="grow" />
      <button type="button" class="btn sm" :disabled="S.branchBusy" @click="cancelEdit">取消</button>
      <button type="button" class="btn sm primary" :disabled="branchDisabled || S.edit.attachments.some(a => a.status === 'uploading')" title="Ctrl+Enter / ⌘Enter" @click="sendEdit">{{ S.branchBusy ? '发送中…' : '修改并重发' }}</button>
    </div>
  </div>
</template>

<style scoped>
.user-editor { width: min(80%, 720px); border: 1px solid var(--accent); border-radius: var(--r-md); padding: var(--sp3); background: var(--panel); }
textarea { display: block; width: 100%; min-height: 100px; max-height: 55vh; resize: vertical; border: 0; outline: none; background: transparent; color: var(--text); font: inherit; font-family: var(--font-chat); font-size: var(--fs-user); line-height: 1.6; }
.actions { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
.edit-atts { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.edit-att { display: flex; align-items: center; gap: 5px; max-width: 100%; padding: 4px; border: 1px solid var(--line); border-radius: var(--r-sm); font-size: var(--fs-xs); }
.edit-att img { width: 44px; height: 44px; object-fit: cover; }
.edit-att button { flex: none; background: none; border: 0; color: var(--text-3); cursor: pointer; font-size: 18px; }
.edit-error { color: var(--err); white-space: pre-wrap; font-size: var(--fs-sm); }
@media (max-width: 768px) { .user-editor { width: 100%; } }
</style>
