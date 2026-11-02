// 界面设置：保存在 localStorage，改了立刻生效（写到 <html> 的 CSS 变量上）
import { reactive, watch } from 'vue';

// “系统默认字体”这一串：真实字体名写在前面，system-ui 这类通用关键字只留最后兜底。
// -apple-system / BlinkMacSystemFont 不是字体名，是 macOS / iOS 上的“系统字体暗号”，
// 别的系统不认，会往后落到 Segoe UI（拉丁）+ 后面的中文字体。
// 中文首选霞鹜文楷屏幕阅读版：装了就用，没装就自动往后落到苹方 / 微软雅黑 UI，跟以前一模一样。
// Windows 上这个字体注册的名字是中文的“霞鹜文楷 屏幕阅读版”，macOS / Linux 那边发布的叫 LXGW WenKai Screen，两个都写上。
export const WENKAI_SCREEN = "'LXGW WenKai Screen', '霞鹜文楷 屏幕阅读版'";
export const SYSTEM_FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', ${WENKAI_SCREEN}, 'PingFang SC', 'Microsoft YaHei UI', 'Noto Sans CJK SC', system-ui, sans-serif`;
export const GITHUB_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
// 等宽字体同理：拉丁字符还是前面的 Cascadia / Consolas（对齐不乱），
// 只有这些字体里没有的汉字落到霞鹜文楷等宽屏幕阅读版；没装则照旧落到系统 monospace。
export const WENKAI_MONO_SCREEN = "'LXGW WenKai Mono Screen', '霞鹜文楷等宽 屏幕阅读版'";
export const GITHUB_MONO = `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', ${WENKAI_MONO_SCREEN}, monospace`;

export const DEFAULTS = {
  // 整体样式：现代 | 微信 | GitHub。选一次会把主题色、Markdown 排版、字体、字号行高这些一起换掉（见 STYLES）
  uiStyle: 'modern',
  // 深浅色：每个样式都自带一套浅色和一套纯黑的深色
  theme: 'light', // light | dark | auto
  accent: '#3b82f6', // 主题色；你自己的气泡颜色跟着它走
  mdStyle: 'default', // 回复正文的 Markdown：default | github | github-compact
  radius: 10, // 全局圆角 px：按钮、卡片、弹窗、输入框、气泡等都按它按比例缩放（见 style.css 里的 --r-*）
  chatWidth: 920, // 聊天内容最大宽度 px，0 = 铺满
  spacing: 1, // 间距倍率
  hoverBox: false, // 回复正文外面那圈边框：默认关（想要带框的正文就打开）
  // 文字（默认系统字体：macOS / iOS 上是苹方，Windows 上是微软雅黑）
  font: SYSTEM_FONT,
  codeFont: GITHUB_MONO,
  fontSize: 14,
  codeFontSize: 13,
  lineHeight: 1.7,
  letterSpacing: 0.2,
  paraGap: 0.6, // 段落间距 em
  // 行为
  sendKey: 'enter', // enter | ctrlEnter
  thinkingOpen: false,
  toolsOpen: false,
  showMeta: false, // 默认不显示每条消息的时间/模型/用量（右键消息或菜单里打开）
  showUsage: false, // 输入框上面的花费/token/上下文信息：默认收起，点顶部栏的状态按钮（或右键菜单）展开
  // 附件
  uploadDir: '{tmp}/pi-web/{session}', // 拖进来/粘贴的文件上传到哪：{tmp} {cwd} {session} {date} {home}，相对路径按 cwd 解析
  uploadMaxMB: 500, // 单个文件上传上限
  keepAttachments: true, // 发送后附件留在输入框上面，下一轮接着带
  // 临时会话：侧栏那个「临时会话」按钮每点一次，就在这个目录下面建一个带时间戳的子目录当工作目录
  tempSessionDir: '{tmp}/pi-web/temporary', // 支持 {tmp} {home} {date}，相对路径按用户目录解析
};

/** 整体样式：每个样式就是一整套设置（配色名、Markdown 排版、字体、字号行高、圆角…）。
 *  深浅色不在这里：一个样式既有浅色也有纯黑的深色，在“深浅色”里单独切 */
export const STYLES = [
  {
    value: 'modern',
    label: '现代',
    desc: '圆角 + 留白，蓝色主色',
    settings: {
      accent: '#3b82f6',
      mdStyle: 'default',
      font: SYSTEM_FONT,
      codeFont: GITHUB_MONO,
      radius: 10,
      chatWidth: 920,
      spacing: 1,
      fontSize: 14,
      codeFontSize: 13,
      lineHeight: 1.7,
      letterSpacing: 0.2,
      paraGap: 0.6,
    },
  },
  {
    value: 'wechat',
    label: '微信',
    desc: '浅灰底、绿色主色，字号大一点',
    settings: {
      accent: '#07c160',
      mdStyle: 'default',
      font: SYSTEM_FONT,
      codeFont: GITHUB_MONO,
      radius: 8,
      chatWidth: 880,
      spacing: 1,
      fontSize: 15,
      codeFontSize: 13,
      lineHeight: 1.75,
      letterSpacing: 0.2,
      paraGap: 0.7,
    },
  },
  {
    value: 'github',
    label: 'GitHub',
    desc: 'GitHub 字体 + markdown 排版，紧凑方正',
    settings: {
      accent: '#0969da',
      mdStyle: 'github',
      font: GITHUB_FONT,
      codeFont: GITHUB_MONO,
      radius: 6,
      chatWidth: 980,
      spacing: 1,
      fontSize: 14,
      codeFontSize: 13,
      lineHeight: 1.55,
      letterSpacing: 0,
      paraGap: 0.6,
    },
  },
];

/** 换整体样式：把整套设置一起套上（调色板由 CSS 的 [data-ui] 负责，不用手动改） */
export function useStyle(v) {
  const s = STYLES.find((x) => x.value === v) || STYLES[0];
  Object.assign(UI, s.settings, { uiStyle: s.value });
}

export const ACCENTS = ['#0969da', '#07c160', '#3b82f6', '#12b7f5', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#64748b'];
/** 主题色色块的名字（没写的就直接显示颜色值） */
export const ACCENT_NAMES = { '#0969da': 'GitHub 蓝', '#07c160': '微信绿', '#3b82f6': '默认蓝' };

/** 字体下拉框：一个选项就是一款字体，不往里塞一串（缺字、缺等宽的兜底交给 apply() 统一补） */
export const FONT_PRESETS = [
  { label: '系统默认', value: SYSTEM_FONT },
  { label: '霞鹜文楷屏幕阅读版 LXGW WenKai Screen', value: WENKAI_SCREEN },
  { label: '霞鹜文楷 LXGW WenKai', value: "'LXGW WenKai'" },
  { label: '苹方 PingFang SC', value: "'PingFang SC'" },
  { label: '微软雅黑 Microsoft YaHei', value: "'Microsoft YaHei'" },
  { label: '微软雅黑 UI Microsoft YaHei UI', value: "'Microsoft YaHei UI'" },
  { label: 'Segoe UI', value: "'Segoe UI'" },
  { label: 'Noto Sans', value: "'Noto Sans'" },
  { label: 'Noto Sans CJK SC', value: "'Noto Sans CJK SC'" },
];

/** 等宽字体：同样一款一个。只有“系统默认等宽”那项得靠 ui-monospace 这类关键字，拆不开 */
export const MONO_PRESETS = [
  { label: '系统默认等宽', value: GITHUB_MONO },
  { label: '霞鹜文楷等宽屏幕阅读版 LXGW WenKai Mono Screen', value: WENKAI_MONO_SCREEN },
  { label: '霞鹜文楷等宽 LXGW WenKai Mono', value: "'LXGW WenKai Mono'" },
  { label: 'Cascadia Mono', value: "'Cascadia Mono'" },
  { label: 'Consolas', value: "'Consolas'" },
  { label: 'SF Mono', value: "'SF Mono'" },
  { label: 'Menlo', value: "'Menlo'" },
  { label: 'JetBrains Mono', value: "'JetBrains Mono'" },
  { label: 'Fira Code', value: "'Fira Code'" },
];

const KEY = 'pi-web-settings';
const VER = 11; // 设置结构版本：<2 的那批默认字体是 Sarasa，升级时跟着换成系统字体；<3 去掉了头像开关；<4 气泡圆角改成了全局圆角；<5 正文默认不带边框；<6 气泡色固定跟随主题色；<7 系统字体栈不再把 system-ui 放第一位；<8 字体下拉改成一款一个（不再打包好几家字体）；<9 去掉更纱黑体，加霞鹜文楷；<10 系统字体栈的中文首选换成霞鹜文楷屏幕阅读版；<11 等宽字体栈里也加上了霞鹜文楷等宽屏幕阅读版
let saved = {};
try {
  saved = JSON.parse(localStorage.getItem(KEY) || '{}');
} catch {}
if ((saved.__v || 1) < 2) {
  if (saved.font === "'Sarasa Term SC'") delete saved.font; // 没改过的，直接用新默认值
  delete saved.showMeta; // v2 起默认改成“悬停才显示”
}
if ((saved.__v || 1) < 3) delete saved.avatars; // 头像去掉了，这个开关也没了
if ((saved.__v || 1) < 4) delete saved.radius; // 旧值是“气泡圆角”，含义变了，回到新默认值
if ((saved.__v || 1) < 5) delete saved.hoverBox; // 正文改成默认不带边框了，旧设置里的 true 作废
if ((saved.__v || 1) < 6) delete saved.userBubble; // 气泡色现在固定跟着主题色
if ((saved.__v || 1) < 7) {
  // 老版本的“系统默认字体”字符串，存下来就等于没改过，删掉好让新的字体栈生效
  const oldSys = "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei UI', 'Noto Sans CJK SC', sans-serif";
  if (saved.font === oldSys) delete saved.font;
  if (saved.codeFont === oldSys) delete saved.codeFont;
}
if ((saved.__v || 1) < 8) {
  // “GitHub 字体”那个打包选项没了：界面字体回到系统默认，代码字体换到系统默认等宽
  if (saved.font === GITHUB_FONT) saved.font = SYSTEM_FONT;
  if (saved.codeFont === GITHUB_FONT) saved.codeFont = GITHUB_MONO;
}
if ((saved.__v || 1) < 9) {
  // 更纱黑体那几个选项去掉了：存着的老值换成最接近的（正文字体回系统默认，等宽的换系统默认等宽）
  const gone = { "'Sarasa Term SC'": GITHUB_MONO, "'Sarasa Mono SC'": GITHUB_MONO, "'Sarasa Gothic SC'": SYSTEM_FONT, "'Sarasa UI SC'": SYSTEM_FONT };
  if (saved.font in gone) saved.font = gone[saved.font];
  if (saved.codeFont in gone) saved.codeFont = gone[saved.codeFont];
}
if ((saved.__v || 1) < 10) {
  // “系统默认字体”那一串里插进了霞鹜文楷屏幕阅读版：存的就是旧那串的话等于没改过，删掉让新的字体栈生效
  const oldSys = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', 'Noto Sans CJK SC', system-ui, sans-serif";
  if (saved.font === oldSys) delete saved.font;
}
if ((saved.__v || 1) < 11) {
  // “系统默认等宽”那一串加了霞鹜文楷等宽屏幕阅读版，同理把存着的旧值删掉
  const oldMono = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";
  if (saved.codeFont === oldMono) delete saved.codeFont;
}
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

/** 中文字体的兜底链：用户的字体里没有汉字（比如选了 Segoe UI）时，中文按这个顺序找。
 *  首选霞鹜文楷屏幕阅读版，没装再落到苹方 / 雅黑 */
const FALLBACK = `${WENKAI_SCREEN}, 'PingFang SC', 'Microsoft YaHei UI', 'Noto Sans CJK SC', sans-serif`;
/** 等宽的兜底链：用户的等宽字体里没有汉字时，先找霞鹜文楷等宽屏幕阅读版 */
const MONO_FALLBACK = `${WENKAI_MONO_SCREEN}, 'Cascadia Mono', Consolas, 'Liberation Mono', monospace`;
const mql = window.matchMedia('(prefers-color-scheme: dark)');

function apply() {
  const r = document.documentElement;
  const dark = UI.theme === 'dark' || (UI.theme === 'auto' && mql.matches);
  view.dark = dark;
  r.dataset.theme = dark ? 'dark' : 'light';
  r.dataset.ui = UI.uiStyle;
  r.dataset.md = UI.mdStyle;
  const set = (k, v) => r.style.setProperty(k, v);
  set('--accent', UI.accent);
  set('--font', `${UI.font || SYSTEM_FONT}, ${FALLBACK}`);
  set('--font-code', `${UI.codeFont || UI.font || SYSTEM_FONT}, ${MONO_FALLBACK}`);
  set('--fs', UI.fontSize + 'px');
  set('--fs-code', UI.codeFontSize + 'px');
  set('--lh', String(UI.lineHeight));
  set('--ls', UI.letterSpacing + 'px');
  set('--para', UI.paraGap + 'em');
  set('--r', UI.radius + 'px');
  set('--s', String(UI.spacing));
  set('--chat-w', UI.chatWidth ? UI.chatWidth + 'px' : '100%');
  setFavicon();
}

/** 标签页图标：和左上角的 π 方块保持一致，跟着主题色和全局圆角变。
 *  logo 用的是 --r-sm 这一档（现代风 = 全局圆角 × 0.7，GitHub 风 = 全局圆角），
 *  logo 是 28px、图标画布是 32，再按 32 / 28 换算一下，两者看起来就一样圆 */
function setFavicon() {
  const rx = Math.min(16, (UI.radius * (UI.uiStyle === 'github' ? 1 : 0.7) * 32) / 28).toFixed(1);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="${rx}" fill="${UI.accent}"/><text x="16" y="24.5" font-size="22" font-weight="700" text-anchor="middle" fill="#fff" font-family="system-ui, 'Segoe UI', 'Helvetica Neue', sans-serif">π</text></svg>`;
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
