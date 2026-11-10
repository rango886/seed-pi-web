// 界面设置：保存在 localStorage（实际存在后端，见 prefs.js），改了立刻生效（写到 <html> 的 CSS 变量上）
import { reactive, watch } from 'vue';
import { resetDiagramCache } from './util.js';

// 字体只使用浏览器本机安装的版本。明确的西文字体在前，中文缺字兜底在后，通用字体族最后。
// 中文字体也覆盖英文：用户主动选苹方 / 文楷时，会优先使用它们自己的英文字形。
export const WENKAI_SCREEN = "'LXGW WenKai Screen', '霞鹜文楷 屏幕阅读版'";
export const WENKAI_MONO_SCREEN = "'LXGW WenKai Mono Screen', '霞鹜文楷等宽 屏幕阅读版'";
export const SYSTEM_FONT = "'Segoe UI', 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei UI', 'Noto Sans CJK SC', system-ui, sans-serif";
const GITHUB_FONT_OLD = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
export const GITHUB_FONT = "'Segoe UI', 'Noto Sans', Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei UI', 'Noto Sans CJK SC', system-ui, sans-serif";
export const GITHUB_MONO = `SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', ${WENKAI_MONO_SCREEN}, ui-monospace, monospace`;
/** 默认代码字体；缺字和跨平台兜底由 buildFontStack() 补齐。 */
export const GITHUB_CODE = "'Consolas'";

// 保留 Pi 的字体候选，但把 ui-monospace 移到明确的字体之后，避免提前截断匹配。
export const PI_FONT = "'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', ui-monospace, monospace";
export const PI_SETTINGS = {
  accent: '#7459b4', mdStyle: 'pi', font: PI_FONT, chatFont: '', codeFont: PI_FONT,
  radius: 4, chatWidth: 980, spacing: 1, fontSize: 12, userFontSize: 12, chatFontSize: 12, codeFontSize: 12,
  toolFontSize: 12, thinkingFontSize: 12,
  lineHeight: 1.5, letterSpacing: 0, paraGap: 1.5,
};

/** GitHub 那一套（默认整体样式）：配色 + 无衬线正文 + Consolas + GitHub Markdown 排版。 */
const GITHUB_SETTINGS = {
  accent: '#0969da',
  mdStyle: 'github',
  font: GITHUB_FONT,
  chatFont: '', // 空字符串表示跟随界面字体
  codeFont: GITHUB_CODE,
  radius: 6,
  chatWidth: 980,
  spacing: 1,
  fontSize: 14,
  userFontSize: 14,
  chatFontSize: 14,
  codeFontSize: 13,
  toolFontSize: 12,
  thinkingFontSize: 12,
  lineHeight: 1.55,
  letterSpacing: 0,
  paraGap: 0.6,
};

const WARM_SETTINGS = { ...GITHUB_SETTINGS, accent: '#32827b', font: "'PingFang SC'", chatFont: "'PingFang SC'" };

export const DEFAULTS = {
  // 整体样式：素白 | GitHub（默认）| pi。选一次会把主题色、Markdown 排版、字体、字号行高这些一起换掉（见 STYLES）
  uiStyle: 'github',
  // 深浅色：每个样式都自带浅色和深色；pi 使用导出页原版配色
  theme: 'light', // light | dark | auto
  // 配色 / 字体 / 字号行高这些就是 GitHub 那一套，想改默认效果改上面的 GITHUB_SETTINGS 就行
  ...GITHUB_SETTINGS,
  // 行为
  sendKey: 'enter', // enter | ctrlEnter
  thinkingDisplay: 'collapsed', // collapsed | expanded
  toolsDisplay: 'collapsed',
  showMeta: false, // 默认不显示每条消息的时间/模型/用量（右键消息或菜单里打开）
  topStatus: true, // 顶栏右侧显示 token / 缓存 / 花费 / 上下文
  // 附件
  uploadDir: '{tmp}/seed-pi-web/{session}', // 拖进来/粘贴的文件上传到哪：{tmp} {cwd} {session} {date} {home}，相对路径按 cwd 解析
  uploadMaxMB: 500, // 单个文件上传上限
  keepAttachments: true, // 发送后附件留在输入框上面，下一轮接着带
  // 侧栏顶部按钮：隐藏后快捷键（Alt+N / Alt+Shift+N）照样能用
  newShow: true, // 侧栏显示「新会话」按钮
  dirShow: true, // 侧栏显示「选目录」按钮
  // 临时会话：侧栏「临时聊」按钮在 tempRoot 下新建一个文件夹，会话开在里面
  tempShow: true, // 侧栏显示「临时聊」按钮
  tempRoot: '{data}/temp', // 根目录：{data}（~/.seed-pi-web）{home} {tmp}，~ 开头按用户目录
  tempName: '{date}_{time}', // 文件夹名：{date} {time} {rand}，重名自动加 -1、-2
};

/** 整体样式：每个样式就是一整套设置（配色名、Markdown 排版、字体、字号行高、圆角…）。
 *  深浅色不在这里，在“深浅色”里单独切；切样式不改变过程块的展开习惯 */
export const STYLES = [
  { value: 'github-warm', label: '素白', settings: { ...WARM_SETTINGS } },
  { value: 'github', label: 'GitHub', settings: { ...GITHUB_SETTINGS } },
  { value: 'pi', label: 'pi', settings: { ...PI_SETTINGS } },
];

/** 换整体样式：把整套设置一起套上（调色板由 CSS 的 [data-ui] 负责，不用手动改） */
export function useStyle(v) {
  const s = STYLES.find((x) => x.value === v) || STYLES[0];
  Object.assign(UI, s.settings, { uiStyle: s.value });
}

export const ACCENTS = ['#32827b', '#7459b4', '#0969da', '#07c160', '#3b82f6', '#12b7f5', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#64748b'];
/** 主题色色块的名字（没写的就直接显示颜色值） */
export const ACCENT_NAMES = { '#32827b': '素白 · 青绿', '#7459b4': 'pi 紫', '#0969da': 'GitHub 蓝（默认）', '#07c160': '绿色', '#3b82f6': '蓝色' };

/** 字体下拉框：一个选项就是一款字体，不往里塞一串（缺字、缺等宽的兜底交给 apply() 统一补） */
export const FONT_PRESETS = [
  { label: '系统默认', value: SYSTEM_FONT },
  { label: 'GitHub 默认', value: GITHUB_FONT },
  { label: 'pi 等宽（原版）', value: PI_FONT },
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
  { label: 'pi 等宽（原版）', value: PI_FONT },
  { label: '霞鹜文楷等宽屏幕阅读版 LXGW WenKai Mono Screen', value: WENKAI_MONO_SCREEN },
  { label: '霞鹜文楷等宽 LXGW WenKai Mono', value: "'LXGW WenKai Mono'" },
  { label: 'Cascadia Mono', value: "'Cascadia Mono'" },
  { label: 'Consolas', value: "'Consolas'" },
  { label: 'SF Mono', value: "'SF Mono'" },
  { label: 'Menlo', value: "'Menlo'" },
  { label: 'JetBrains Mono', value: "'JetBrains Mono'" },
  { label: 'Fira Code', value: "'Fira Code'" },
];

const KEY = 'seed-pi-web-settings';
export const VER = 23; // v23：输入框状态栏撤掉，用量挪到顶栏，statusBar 换成 topStatus 开关。
// 设置结构历史：<2 的那批默认字体是 Sarasa，升级时跟着换成系统字体；<3 去掉了头像开关；<4 气泡圆角改成了全局圆角；<5 正文默认不带边框；<6 气泡色固定跟随主题色；<7 系统字体栈不再把 system-ui 放第一位；<8 字体下拉改成一款一个（不再打包好几家字体）；<9 去掉更纱黑体，加霞鹜文楷；<10 系统字体栈的中文首选换成霞鹜文楷屏幕阅读版；<11 等宽字体栈里也加上了霞鹜文楷等宽屏幕阅读版；<12 默认整体样式换成 GitHub（苹方 + Consolas），等宽字体统一 Consolas；<13 输入框上面的状态信息改成默认显示
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
if ((saved.__v || 1) < 6) delete saved.userBubble; // 气泡色现在固定跟着主题色
if ((saved.__v || 1) < 7) {
  // 老版本的“系统默认字体”字符串，存下来就等于没改过，删掉好让新的字体栈生效
  const oldSys = "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei UI', 'Noto Sans CJK SC', sans-serif";
  if (saved.font === oldSys) delete saved.font;
  if (saved.codeFont === oldSys) delete saved.codeFont;
}
if ((saved.__v || 1) < 8) {
  // “GitHub 字体”那个打包选项没了：界面字体回到系统默认，代码字体换到系统默认等宽
  if (saved.font === GITHUB_FONT_OLD) saved.font = SYSTEM_FONT;
  if (saved.codeFont === GITHUB_FONT_OLD) saved.codeFont = GITHUB_MONO;
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
if ((saved.__v || 1) < 12) {
  // 旧默认字体更新为当前字体栈。
  if (saved.font === GITHUB_FONT_OLD) saved.font = GITHUB_FONT;
  if (saved.codeFont === GITHUB_MONO) saved.codeFont = GITHUB_CODE;
}
if ((saved.__v || 1) < 13) {
  // 状态信息改成默认显示：存档里的 false 就是旧默认（当时根本没地方单独打开），删掉让新默认生效
  delete saved.showUsage;
}
if ((saved.__v || 1) < 16) {
  // 只替换完整匹配的旧内置预设，保留用户自定义字体。
  const oldSystem = `-apple-system, BlinkMacSystemFont, 'Segoe UI', ${WENKAI_SCREEN}, 'PingFang SC', 'Microsoft YaHei UI', 'Noto Sans CJK SC', system-ui, sans-serif`;
  const oldMono = `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', ${WENKAI_MONO_SCREEN}, monospace`;
  const oldPi = "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace";
  const replacements = new Map([[oldSystem, SYSTEM_FONT], [`'PingFang SC', ${GITHUB_FONT_OLD}`, GITHUB_FONT], [oldMono, GITHUB_MONO], [oldPi, PI_FONT]]);
  for (const key of ['font', 'chatFont', 'codeFont']) {
    if (replacements.has(saved[key])) saved[key] = replacements.get(saved[key]);
  }
  saved.chatFont ??= '';
  saved.chatFontSize ??= saved.fontSize ?? DEFAULTS.fontSize;
}
// 同样处理导入的旧设置，即使导入文件的版本号已是当前版本。
if (saved.uiStyle === 'wechat') Object.assign(saved, PI_SETTINGS, { uiStyle: 'pi' });
if (saved.mdStyle === 'github-compact') saved.mdStyle = 'github';
if ((saved.__v || 1) < 17) {
  // 原先 pi 过程块跟随界面字号，其他样式是界面字号减 2px；升级后保持当前显示大小。
  const oldSize = saved.fontSize ?? DEFAULTS.fontSize;
  const blockSize = saved.uiStyle === 'pi' ? oldSize : oldSize - 2;
  saved.toolFontSize ??= blockSize;
  saved.thinkingFontSize ??= blockSize;
}
if ((saved.__v || 1) < 18) {
  // 原“聊天字号”继续用于助手回复；用户消息初始化为同样的大小，不再减 1px。
  saved.userFontSize ??= saved.chatFontSize ?? DEFAULTS.chatFontSize;
}
if ((saved.__v || 1) < 19) {
  // 状态胶囊改成默认隐藏：旧存档里的 true 是旧默认，删掉让新默认生效
  delete saved.showUsage;
}
if ((saved.__v || 1) < 20 && saved.uiStyle === 'github-warm' && saved.accent === '#82704e') {
  // 已经选过素白的用户刷新即可看到新配色；自选颜色、字体和其他偏好保持不变。
  saved.accent = '#32827b';
}
if ((saved.__v || 1) < 21 && saved.uiStyle === 'pi' && saved.chatWidth === 800) {
  // pi 预设的聊天区宽度改成 980，跟其他样式一致；手动调过的宽度保持不变。
  saved.chatWidth = 980;
}
// showUsage → statusBar → topStatus：旧的“隐藏”沿用成关掉顶栏用量（导入旧备份也要清掉）
if (saved.topStatus === undefined && saved.statusBar === 'hidden') saved.topStatus = false;
if (typeof saved.topStatus !== 'boolean') delete saved.topStatus;
delete saved.showUsage;
delete saved.statusBar;
delete saved.statusDivider;
for (const [key, oldKey] of [['thinkingDisplay', 'thinkingOpen'], ['toolsDisplay', 'toolsOpen']]) {
  if (!['collapsed', 'expanded'].includes(saved[key])) {
    saved[key] = saved[key] === undefined && saved[oldKey] === true ? 'expanded' : 'collapsed';
  }
  delete saved[oldKey];
}
delete saved.hoverBox;
delete saved.__v;

export const UI = reactive({ ...DEFAULTS, ...saved });
export const view = reactive({
  settingsOpen: false,
  dark: false,
  menu: null, // 输入框上方的弹出菜单：'model' | 'thinking'
  side: localStorage.getItem('seed-pi-web-side') !== '0', // 宽屏：侧栏是否展开
  drawer: false, // 窄屏：抽屉是否打开
  mobile: false,
  ctx: null, // 右键菜单 { x, y, items }
  panel: null, // 右边的浮动侧栏：'files' | 'agents' | null
  lightbox: null, // 图片灯箱：{ list: [{ src, alt }], i }，i 是当前看的是第几张
});

/** 右侧浮动侧栏（文件 / 进程）：再点一次同一个就关掉 */
export function togglePanel(name) {
  view.panel = view.panel === name ? null : name;
}

/** 打开图片灯箱：list 是这个会话里能翻的所有图片，i 是点开的那一张。
 *  一张也要打开（就是全屏看看大图），只是不显示左右按钮 */
export function openLightbox(list, i = 0) {
  if (!list?.length) return;
  view.lightbox = { list, i: Math.min(Math.max(i, 0), list.length - 1) };
}

/** 灯箱里左右翻（到头绕回去） */
export function stepLightbox(d) {
  const lb = view.lightbox;
  if (lb) lb.i = (lb.i + d + lb.list.length) % lb.list.length;
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
    localStorage.setItem('seed-pi-web-side', view.side ? '1' : '0');
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

// 常规正文优先黑体，文楷保留为最后的具名字体兜底，也可以在设置里主动选到最前。
const FALLBACK = `'PingFang SC', 'Microsoft YaHei UI', 'Noto Sans CJK SC', ${WENKAI_SCREEN}, system-ui, sans-serif`;
const MONO_FALLBACK = `'Cascadia Mono', Consolas, 'Liberation Mono', ${WENKAI_MONO_SCREEN}, 'Noto Sans Mono CJK SC', ui-monospace, monospace`;
const GENERIC_FONTS = new Set(['-apple-system', 'blinkmacsystemfont', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'math', 'fangsong']);

/** 合并预设 / 自定义字体和兜底：保留具名字体顺序、去重，把系统别名和通用族统一放最后。
 *  带引号的字体名允许包含逗号；例如 'Example, Mono' 仍是一款字体。
 */
export function buildFontStack(font, mono = false) {
  const names = [], generic = [], seen = new Set();
  const tokens = `${font || (mono ? GITHUB_CODE : SYSTEM_FONT)}, ${mono ? MONO_FALLBACK : FALLBACK}`.match(/(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,'"])+/g) || [];
  for (const token of tokens) {
    const value = token.trim();
    const isGeneric = GENERIC_FONTS.has(value.toLowerCase());
    const key = (isGeneric ? 'generic:' : 'font:') + value.replace(/^(['"])(.*)\1$/, '$2').toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    // 引号内的 "serif" 等是具名字体，不是 CSS 通用族。
    (isGeneric ? generic : names).push(value);
  }
  return [...names, ...generic].join(', ');
}
const mql = window.matchMedia('(prefers-color-scheme: dark)');

// 图（mermaid）是先把文字量一遍再算尺寸的，所以字体或字号一变就得重新量、重画。
// 颜色那边不用管：pele 的颜色全走 CSS 变量，换主题不用重画
let lastFontKey = '';

function apply() {
  const r = document.documentElement;
  const dark = UI.theme === 'dark' || (UI.theme === 'auto' && mql.matches);
  view.dark = dark;
  r.dataset.theme = dark ? 'dark' : 'light';
  r.dataset.ui = UI.uiStyle;
  r.dataset.md = UI.mdStyle;
  const set = (k, v) => r.style.setProperty(k, v);
  // 原版 pi 在深色下用更亮的紫色；用户自选的主题色仍照常保留。
  const accent = UI.uiStyle === 'pi' && UI.accent === PI_SETTINGS.accent && dark ? '#a798d7' : UI.accent;
  set('--accent', accent);
  const font = buildFontStack(UI.font);
  const chatFont = buildFontStack(UI.chatFont || UI.font);
  const codeFont = buildFontStack(UI.codeFont, true);
  set('--font', font);
  set('--font-chat', chatFont);
  set('--font-code', codeFont);
  set('--fs', UI.fontSize + 'px');
  set('--fs-user', UI.userFontSize + 'px');
  set('--fs-chat', UI.chatFontSize + 'px');
  set('--fs-code', UI.codeFontSize + 'px');
  set('--fs-tool', UI.toolFontSize + 'px');
  set('--fs-thinking', UI.thinkingFontSize + 'px');
  set('--lh', String(UI.lineHeight));
  set('--ls', UI.letterSpacing + 'px');
  set('--para', UI.paraGap + 'em');
  set('--r', UI.radius + 'px');
  set('--s', String(UI.spacing));
  set('--chat-w', UI.chatWidth ? UI.chatWidth + 'px' : '100%');
  const fontKey = `${chatFont}|${codeFont}|${UI.chatFontSize}`;
  if (fontKey !== lastFontKey) {
    lastFontKey = fontKey;
    resetDiagramCache();
  }
  setFavicon(accent);
}

/** 标签页图标：和左上角的 π 方块保持一致，跟着主题色和全局圆角变。
 *  所有样式的 logo 都使用全局圆角；logo 是 28px、图标画布是 32，
 *  按 32 / 28 换算，两者看起来就一样圆。 */
function setFavicon(accent) {
  const rx = Math.min(16, Math.max(0, UI.radius) * 32 / 28).toFixed(1);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="${rx}" fill="${accent}"/><text x="16" y="24.5" font-size="22" font-weight="700" text-anchor="middle" fill="#fff" font-family="system-ui, 'Segoe UI', 'Helvetica Neue', sans-serif">π</text></svg>`;
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
