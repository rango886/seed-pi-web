// 界面设置：保存在 localStorage，改了立刻生效（写到 <html> 的 CSS 变量上）
import { reactive, watch } from 'vue';

export const DEFAULTS = {
  // 外观
  theme: 'light', // light | dark | auto
  accent: '#3b82f6',
  userBubble: 'accent', // accent | soft | green
  radius: 12, // 气泡圆角 px
  avatars: true,
  chatWidth: 920, // 聊天内容最大宽度 px，0 = 铺满
  spacing: 1, // 间距倍率
  // 文字
  font: "'Sarasa Term SC'",
  codeFont: "'Sarasa Term SC'",
  fontSize: 14,
  codeFontSize: 13,
  lineHeight: 1.7,
  letterSpacing: 0.2,
  paraGap: 0.6, // 段落间距 em
  // 行为
  sendKey: 'enter', // enter | ctrlEnter
  thinkingOpen: false,
  toolsOpen: false,
  showMeta: true,
};

export const ACCENTS = ['#3b82f6', '#07c160', '#12b7f5', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#64748b'];

export const FONT_PRESETS = [
  { label: '更纱终端黑体 Sarasa Term SC', value: "'Sarasa Term SC'" },
  { label: '等距更纱黑体 Sarasa Mono SC', value: "'Sarasa Mono SC'" },
  { label: '更纱黑体 Sarasa Gothic SC', value: "'Sarasa Gothic SC'" },
  { label: '更纱黑体 UI Sarasa UI SC', value: "'Sarasa UI SC'" },
  { label: '系统默认 (微软雅黑 / 苹方)', value: "system-ui, 'Microsoft YaHei UI', 'PingFang SC'" },
  { label: 'Cascadia Mono', value: "'Cascadia Mono'" },
];

const KEY = 'pi-web-settings';
let saved = {};
try {
  saved = JSON.parse(localStorage.getItem(KEY) || '{}');
} catch {}

export const UI = reactive({ ...DEFAULTS, ...saved });
export const view = reactive({
  settingsOpen: false,
  dark: false,
  menu: null, // 输入框上方的弹出菜单：'model' | 'thinking'
  side: localStorage.getItem('pi-web-side') !== '0', // 宽屏：侧栏是否展开
  drawer: false, // 窄屏：抽屉是否打开
  mobile: false,
  ctx: null, // 右键菜单 { x, y, items }
});

const narrow = window.matchMedia('(max-width: 768px)');
const onNarrow = () => {
  view.mobile = narrow.matches;
  if (!view.mobile) view.drawer = false;
};
narrow.addEventListener('change', onNarrow);
onNarrow();

/** 侧栏开关：宽屏收起/展开，窄屏开/关抽屉 */
export function toggleSide(v) {
  if (view.mobile) view.drawer = v ?? !view.drawer;
  else {
    view.side = v ?? !view.side;
    localStorage.setItem('pi-web-side', view.side ? '1' : '0');
  }
}
/** 窄屏上点了侧栏里的东西后自动收起抽屉 */
export const closeDrawer = () => view.mobile && (view.drawer = false);

export function openMenu(x, y, items) {
  view.ctx = { x, y, items };
}

export function resetSettings() {
  Object.assign(UI, DEFAULTS);
}

const FALLBACK = "'Sarasa Term SC', 'Microsoft YaHei UI', 'PingFang SC', 'Noto Sans CJK SC', sans-serif";
const MONO_FALLBACK = "'Sarasa Term SC', 'Cascadia Mono', Consolas, monospace";
const mql = window.matchMedia('(prefers-color-scheme: dark)');

function apply() {
  const r = document.documentElement;
  const dark = UI.theme === 'dark' || (UI.theme === 'auto' && mql.matches);
  view.dark = dark;
  r.dataset.theme = dark ? 'dark' : 'light';
  r.dataset.bubble = UI.userBubble;
  const set = (k, v) => r.style.setProperty(k, v);
  set('--accent', UI.accent);
  set('--font', `${UI.font || "'Sarasa Term SC'"}, ${FALLBACK}`);
  set('--font-code', `${UI.codeFont || UI.font || "'Sarasa Term SC'"}, ${MONO_FALLBACK}`);
  set('--fs', UI.fontSize + 'px');
  set('--fs-code', UI.codeFontSize + 'px');
  set('--lh', String(UI.lineHeight));
  set('--ls', UI.letterSpacing + 'px');
  set('--para', UI.paraGap + 'em');
  set('--radius', UI.radius + 'px');
  set('--s', String(UI.spacing));
  set('--chat-w', UI.chatWidth ? UI.chatWidth + 'px' : '100%');
}

watch(UI, () => {
  localStorage.setItem(KEY, JSON.stringify(UI));
  apply();
});
mql.addEventListener('change', apply);
apply();
