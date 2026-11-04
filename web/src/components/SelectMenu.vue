<script setup>
// 小型单选下拉：使用页面主题，不调用系统原生 select 弹层。
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import Icon from './Icon.vue';

const props = defineProps({ modelValue: String, options: Array, label: String, disabled: Boolean });
const emit = defineEmits(['update:modelValue']);
const trigger = ref(null);
const panel = ref(null);
const opened = ref(false);
const position = ref({});
function close(focus = false) {
  opened.value = false;
  if (focus) trigger.value?.focus();
}
async function open(last = false) {
  if (props.disabled) return;
  opened.value = true;
  await nextTick();
  if (!opened.value || !panel.value || !trigger.value) return;
  const r = trigger.value.getBoundingClientRect();
  const menu = panel.value;
  const below = window.innerHeight - r.bottom - 12;
  const above = r.top - 12;
  const up = below < menu.offsetHeight && above > below;
  position.value = {
    left: Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px',
    top: (up ? Math.max(8, r.top - Math.min(menu.offsetHeight, above) - 4) : r.bottom + 4) + 'px',
    maxHeight: Math.max(60, up ? above : below) + 'px',
  };
  const buttons = [...menu.querySelectorAll('button')];
  const selected = props.options.findIndex((o) => o.value === props.modelValue);
  buttons[last ? buttons.length - 1 : Math.max(0, selected)]?.focus();
}
function choose(value) {
  close(true);
  if (value !== props.modelValue) emit('update:modelValue', value);
}
function keydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    close(true);
  } else if (e.key === 'Tab') close();
  else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    const button = document.activeElement;
    if (panel.value?.contains(button) && button.matches('.select-option')) button.click();
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
watch(() => props.disabled, (disabled) => { if (disabled) close(); });
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
  <button ref="trigger" type="button" class="btn sm select-trigger" :class="{ on: opened }" :disabled="disabled" :aria-label="label" aria-haspopup="menu" :aria-expanded="opened" @click="opened ? close() : open()" @keydown.down.prevent="open()" @keydown.up.prevent="open(true)">
    <span>{{ options.find(o => o.value === modelValue)?.label || modelValue }}</span><Icon name="caret" :size="12" />
  </button>
  <Teleport to="body">
    <div v-if="opened" ref="panel" class="select-menu" :style="position" role="menu" :aria-label="label" @keydown="keydown" @contextmenu.prevent.stop>
      <button v-for="option in options" :key="option.value" type="button" class="select-option" :class="{ current: option.value === modelValue }" role="menuitemradio" :aria-checked="option.value === modelValue" @click="choose(option.value)">
        <span class="option-text"><span>{{ option.label }}</span><small v-if="option.description">{{ option.description }}</small></span>
        <Icon v-if="option.value === modelValue" name="check" :size="14" />
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.select-trigger { display: inline-flex; align-items: center; gap: 6px; }
.select-trigger.on { border-color: var(--accent); color: var(--accent-text); background: var(--accent-softer); }
.select-trigger:focus-visible { outline: 2px solid var(--accent-soft); outline-offset: 2px; }
.select-menu { position: fixed; z-index: 75; min-width: 200px; max-width: calc(100vw - 16px); overflow-y: auto; padding: 5px; background: var(--elev); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow-lg); color: var(--text); font-size: var(--fs-sm); }
.select-option { display: flex; align-items: center; gap: 14px; width: 100%; min-height: 32px; padding: 6px 8px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text); text-align: left; cursor: pointer; }
.select-option:hover, .select-option:focus-visible { background: var(--hover); outline: none; }
.select-option.current { color: var(--accent-text); }
.option-text { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.option-text small { color: var(--text-3); font-size: var(--fs-xs); }
</style>
