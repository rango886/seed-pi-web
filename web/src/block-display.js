import { computed, ref, watch } from 'vue';

export const DISPLAY_MODES = [
  { value: 'collapsed', label: '折叠' },
  { value: 'expanded', label: '展开' },
];

/** 默认设置变化时立即生效；单块操作只保存在组件里，不写入设置。 */
export function useBlockDisplay(getDefault) {
  const local = ref(null);
  const mode = computed(() => local.value || getDefault() || 'collapsed');
  const open = computed(() => mode.value === 'expanded');
  watch(getDefault, () => { local.value = null; });
  const toggle = () => { local.value = open.value ? 'collapsed' : 'expanded'; };
  const expand = () => { local.value = 'expanded'; };
  const collapse = () => { local.value = 'collapsed'; };
  return { local, mode, open, toggle, expand, collapse };
}
