// 界面设置：保存在 localStorage，改了立刻生效（写到 <html> 的 CSS 变量上）
import { reactive, watch } from 'vue';

export const SYSTEM_FONT = "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei UI', 'Noto Sans CJK SC', sans-serif";

export const DEFAULTS = {
  // 外观
  theme: 'light', // light | dark | auto
  accent: '#3b82f6',
  userBubble: 'accent', // accent | soft | green
  radius: 12, // 气泡圆角 px
  chatWidth: 920, // 聊天内容最大宽度 px，0 = 铺满
  spacing: 1, // 间距倍率
  // 文字（默认系统字体：macOS / iOS 上是苹方，Windows 上是微软雅黑）
  font: SYSTEM_FONT,
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
  showMeta: false, // 默认不显示每条回复的模型/用量，鼠标悬停才显示
  showUsage: false, // 输入框上面的花费/token/上下文信息：默认收起，点顶部栏的状态按钮（或右键菜单）展开
};

export const ACCENTS = ['#3b82f6', '#07c160', '#12b7f5', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#64748b'];

export const FONT_PRESETS = [
  { label: '系统默认（苹方 / 微软雅黑）', value: SYSTEM_FONT },
  { label: '更纱终端黑体 Sarasa Term SC', value: "'Sarasa Term SC'" },
  { label: '等距更纱黑体 Sarasa Mono SC', value: "'Sarasa Mono SC'" },
  { label: '更纱黑体 Sarasa Gothic SC', value: "'Sarasa Gothic SC'" },
  { label: '更纱黑体 UI Sarasa UI SC', value: "'Sarasa UI SC'" },
  { label: 'Cascadia Mono', value: "'Cascadia Mono'" },
];

const KEY = 'pi-web-settings';
const VER = 3; // 设置结构版本：<2 的那批默认字体是 Sarasa，升级时跟着换成系统字体；<3 去掉了头像开关
let saved = {};
try {
  saved = JSON.parse(localStorage.getItem(KEY) || '{}');
} catch {}
if ((saved.__v || 1) < 2) {
  if (saved.font === "'Sarasa Term SC'") delete saved.font; // 没改过的，直接用新默认值
  delete saved.showMeta; // v2 起默认改成“悬停才显示”
}
if ((saved.__v || 1) < 3) delete saved.avatars; // 头像去掉了，这个开关也没了
delete saved.__v;

export const UI = reactive({ ...DEFAULTS, ...saved });
export const view = reactive({
  settingsOpen: false,
  dark: false,
  menu: null, // 输入框上方的弹出菜单：'model' | 'thinking'
  side: localStorage.getItem('pi-web-side') !== '0', // 宽屏：侧栏是否展开
  drawer: false, // 窄屏：抽屉是否打开
  mobile: false,
  ctx: null, // 右键菜单 { x, y, items }
  panel: null, // 右边的浮动侧栏：'files' | 'agents' | null
});

/** 右侧浮动侧栏（文件 / 进程）：再点一次同一个就关掉 */
export function togglePanel(name) {
  view.panel = view.panel === name ? null : name;
}

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

const FALLBACK = "'PingFang SC', 'Microsoft YaHei UI', 'Noto Sans CJK SC', sans-serif";
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
  set('--font', `${UI.font || SYSTEM_FONT}, ${FALLBACK}`);
  set('--font-code', `${UI.codeFont || UI.font || SYSTEM_FONT}, ${MONO_FALLBACK}`);
  set('--fs', UI.fontSize + 'px');
  set('--fs-code', UI.codeFontSize + 'px');
  set('--lh', String(UI.lineHeight));
  set('--ls', UI.letterSpacing + 'px');
  set('--para', UI.paraGap + 'em');
  set('--radius', UI.radius + 'px');
  set('--s', String(UI.spacing));
  set('--chat-w', UI.chatWidth ? UI.chatWidth + 'px' : '100%');
  setFavicon();
}

/** 标签页图标：和左上角的 π 方块保持一致，跟着主题色变 */
function setFavicon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${UI.accent}"/><text x="16" y="24.5" font-size="22" font-weight="700" text-anchor="middle" fill="#fff" font-family="system-ui, 'Segoe UI', 'Helvetica Neue', sans-serif">π</text></svg>`;
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}

watch(UI, () => {
  localStorage.setItem(KEY, JSON.stringify({ ...UI, __v: VER }));
  apply();
});
mql.addEventListener('change', apply);
apply();
