<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import Icon from './Icon.vue';

const props = defineProps({ mode: String, settings: Object });
const emit = defineEmits(['change']);
const trigger = ref(null);
const panel = ref(null);
const opened = ref(false);
const position = ref({});
const label = computed(() => props.settings.archive === 'archived' ? '已归档' : props.settings.archive === 'all' ? '全部会话' : '显示');
const sections = computed(() => [
  { label: '归档筛选', key: 'archive', options: [
    { value: 'active', label: '仅未归档' }, { value: 'archived', label: '仅已归档' }, { value: 'all', label: '全部会话' },
  ] },
  ...(props.mode === 'dir' ? [] : [
    { label: '列表布局', key: 'layout', options: [{ value: 'flat', label: '平铺显示' }, { value: 'group', label: '按目录折叠' }] },
    { label: '目录名称', key: 'dirLabel', options: [{ value: 'name', label: '只显示文件夹名称' }, { value: 'path', label: '显示完整路径' }] },
  ]),
  { label: '会话信息', toggle: true, options: [
    { key: 'showCount', label: '显示消息条数' },
    { key: 'showTime', label: '显示更新时间' },
    ...(props.mode === 'dir' ? [] : [{ key: 'showPath', label: '显示路径' }]),
  ] },
]);
const checked = (section, option) => section.toggle ? props.settings[option.key] : props.settings[section.key] === option.value;
function choose(section, option) {
  emit('change', section.toggle ? { [option.key]: !props.settings[option.key] } : { [section.key]: option.value });
}
function close(focus = false) {
  opened.value = false;
  if (focus) trigger.value?.focus();
}
async function open(last = false) {
  opened.value = true;
  await nextTick();
  if (!opened.value || !panel.value || !trigger.value) return;
  const r = trigger.value.getBoundingClientRect();
  const menu = panel.value;
  const below = window.innerHeight - r.bottom - 12;
  const above = r.top - 12;
  const up = below < menu.offsetHeight && above > below;
  position.value = {
    right: Math.max(8, window.innerWidth - r.right) + 'px',
    maxWidth: Math.max(0, Math.min(r.right, window.innerWidth - 8) - 8) + 'px',
    top: (up ? Math.max(8, r.top - Math.min(menu.offsetHeight, above) - 4) : r.bottom + 4) + 'px',
    maxHeight: Math.max(60, up ? above : below) + 'px',
  };
  const buttons = [...menu.querySelectorAll('button')];
  (last ? buttons.at(-1) : menu.querySelector('[aria-checked="true"]') || buttons[0])?.focus();
}
function keydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    close(true);
  } else if (e.key === 'Tab') {
    e.preventDefault();
    close(true);
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
    e.preventDefault();
    const buttons = [...panel.value.querySelectorAll('button')];
    const current = buttons.indexOf(document.activeElement);
    const index = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (current + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[index]?.focus();
  }
}
function outside(e) {
  if (opened.value && !panel.value?.contains(e.target) && !trigger.value?.contains(e.target)) close();
}
const dismiss = () => close();
watch(() => props.mode, dismiss);
onMounted(() => {
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('resize', dismiss);
  window.addEventListener('blur', dismiss);
});
onUnmounted(() => {
  document.removeEventListener('pointerdown', outside, true);
  window.removeEventListener('resize', dismiss);
  window.removeEventListener('blur', dismiss);
});
</script>

<template>
  <button ref="trigger" type="button" class="display-trigger" :class="{ on: opened || settings.archive !== 'active' }" title="会话筛选和显示设置（当前模式单独保存）" aria-label="会话筛选和显示设置" aria-haspopup="menu" :aria-expanded="opened" @click="opened ? close() : open()" @keydown.down.prevent="open()" @keydown.up.prevent="open(true)">
    {{ label }}
  </button>
  <Teleport to="body">
    <div v-if="opened" ref="panel" class="display-menu" :style="position" role="menu" aria-label="会话筛选和显示设置" @keydown="keydown" @contextmenu.prevent.stop>
      <div v-for="section in sections" :key="section.label" class="section" role="group" :aria-label="section.label">
        <div class="section-label">{{ section.label }}</div>
        <button v-for="option in section.options" :key="option.key || option.value" type="button" class="option" :class="{ current: checked(section, option) }" :role="section.toggle ? 'menuitemcheckbox' : 'menuitemradio'" :aria-checked="checked(section, option)" @click="choose(section, option)">
          <span>{{ option.label }}</span><Icon v-if="checked(section, option)" name="check" :size="14" />
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.display-trigger { display: inline-flex; align-items: center; height: 22px; padding: 0 6px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--panel-2); color: var(--text-2); font-size: var(--fs-xs); cursor: pointer; flex: none; white-space: nowrap; }
.display-trigger:hover, .display-trigger.on { border-color: var(--accent); color: var(--accent-text); }
.display-trigger:focus-visible { outline: 2px solid var(--accent-soft); outline-offset: 2px; }
.display-menu { position: fixed; z-index: 75; width: 216px; max-width: calc(100vw - 16px); overflow-y: auto; padding: 5px; background: var(--elev); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow-lg); color: var(--text); font-size: var(--fs-sm); }
.section + .section { border-top: 1px solid var(--line); margin-top: 5px; padding-top: 5px; }
.section-label { padding: 3px 8px; color: var(--text-3); font-size: var(--fs-xs); }
.option { display: flex; align-items: center; justify-content: space-between; gap: 14px; width: 100%; min-height: 29px; padding: 5px 8px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text); text-align: left; cursor: pointer; font: inherit; }
.option:hover, .option:focus-visible { background: var(--hover); outline: none; }
.option.current { color: var(--accent-text); }
</style>
