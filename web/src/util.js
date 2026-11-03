import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { rawUrl } from './api.js';
import temml from 'temml';
import { ref } from 'vue';
import hljs from 'highlight.js/lib/common';
// common 只带了 36 种常用语言，代码块里翻出来一堆认不出来的（powershell、dockerfile、nginx…），
// 认不出来就会退到“猜语言”，猜错的颜色比没有颜色还难看。常用的补齐
import powershell from 'highlight.js/lib/languages/powershell';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import nginx from 'highlight.js/lib/languages/nginx';
import protobuf from 'highlight.js/lib/languages/protobuf';
import http from 'highlight.js/lib/languages/http';
for (const [name, lang] of Object.entries({ powershell, dockerfile, nginx, protobuf, http })) hljs.registerLanguage(name, lang);

// eslint-disable-next-line no-control-regex
const ANSI = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
export const stripAnsi = (s) => (typeof s === 'string' ? s.replace(ANSI, '') : s);

export const isAbsPath = (p) => /^([a-zA-Z]:[\\/]|[\\/]|~)/.test(p);
export function joinPath(base, rel, sep = '/') {
  if (!base) return rel;
  const b = base.replace(/[\\/]+$/, '');
  return b + sep + rel;
}
export function normPath(p) {
  if (!p) return '';
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = [];
  for (const seg of s.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  s = parts.join('/');
  return /^[a-zA-Z]:/.test(s) ? s.toLowerCase() : s;
}

export function fmtTokens(n) {
  if (n == null) return '-';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
}

export function relTime(iso) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} 天前`;
  return new Date(iso).toLocaleDateString();
}

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}
export const imagesOf = (content) => (Array.isArray(content) ? content.filter((c) => c.type === 'image') : []);

/** 消息文本登记表：右键菜单统一在 App 层弹，靠 DOM 上的消息 key 回来取要复制的内容 */
const msgTexts = new Map();
export const setMsgText = (k, text) => k != null && msgTexts.set(String(k), text || '');
export const getMsgText = (k) => msgTexts.get(String(k)) || '';
/** 消息组件卸载时删掉，不然切会话切多了这张表只增不减 */
export const delMsgText = (k) => msgTexts.delete(String(k));

/** 工具卡片标题里显示的一行摘要：不认识的工具也能显示个大概 */
const SUMMARY_KEYS = ['command', 'path', 'file_path', 'filePath', 'file', 'pattern', 'query', 'url', 'name', 'prompt'];
export function toolSummary(args) {
  if (!args || typeof args !== 'object') return '';
  for (const k of SUMMARY_KEYS) if (typeof args[k] === 'string') return args[k];
  const first = Object.values(args).find((v) => typeof v === 'string');
  return first || '';
}
export function toolPath(args) {
  if (!args) return null;
  for (const k of ['path', 'file_path', 'filePath', 'file']) if (typeof args[k] === 'string') return args[k];
  return null;
}

// ---------- 代码高亮 ----------
// 代码块里标的语言名五花八门（js / jsx / vue / ps1 …），先翻译成 highlight.js 认的名字
const LANG_ALIAS = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'shell', terminal: 'shell', shellsession: 'shell',
  py: 'python', py3: 'python', python3: 'python',
  rs: 'rust', golang: 'go',
  html: 'xml', vue: 'xml', svelte: 'xml', svg: 'xml', xhtml: 'xml', htm: 'xml',
  yml: 'yaml', toml: 'ini', cfg: 'ini', conf: 'ini', env: 'ini', dotenv: 'ini', properties: 'ini', editorconfig: 'ini',
  ps1: 'powershell', ps: 'powershell', pwsh: 'powershell', psd1: 'powershell', psm1: 'powershell',
  cxx: 'cpp', 'c++': 'cpp', cc: 'cpp', hpp: 'cpp', hxx: 'cpp', h: 'c', 'c#': 'csharp', cs: 'csharp',
  'objective-c': 'objectivec', objc: 'objectivec',
  md: 'markdown', mdx: 'markdown',
  kt: 'kotlin', kts: 'kotlin', rb: 'ruby',
  docker: 'dockerfile', containerfile: 'dockerfile',
  postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql',
  jsonc: 'json', json5: 'json', ndjson: 'json', jsonl: 'json',
  make: 'makefile', mk: 'makefile', patch: 'diff',
  txt: 'plaintext', text: 'plaintext', plain: 'plaintext', plaintext: 'plaintext',
  tex: 'latex', ex: 'elixir', exs: 'elixir', hs: 'haskell', clj: 'clojure', vim: 'vim',
};
const langName = (raw) => {
  const l = (raw || '').split(/\s/)[0].toLowerCase();
  const name = LANG_ALIAS[l] || l;
  return name && hljs.getLanguage(name) ? name : '';
};
/** 高亮一段代码。返回 { html, label }，label 是实际用上的语言名（给代码块标题栏显示） */
export function highlightCode(text, lang) {
  const raw = (lang || '').split(/\s/)[0].toLowerCase();
  const name = langName(raw);
  try {
    if (name && name !== 'plaintext') return { html: hljs.highlight(text, { language: name, ignoreIllegals: true }).value, label: name };
    // 没标语言：只在确实像代码的时候才猜（纯文字被猜成 CSS / 正则的情况太常见了）
    if (!raw && text.length >= 40 && text.length < 4000 && /[{}()\[\];=<>]/.test(text)) {
      return { html: hljs.highlightAuto(text).value, label: '' };
    }
  } catch {}
  return { html: escapeHtml(text), label: name };
}

// ---------- 本地图片 ----------
// 模型经常直接写 `![](out/x.png)`（相对会话目录）或者 `![](C:/Users/x/Downloads/out/x.png)`
// （Windows 绝对路径），这两种地址浏览器自己都打不开：相对路径会当成网站的路径去请求，
// 后端没这个文件就回了首页；`C:` 在浏览器眼里是未知协议，DOMPurify 还会直接把 src 删掉。
// 所以渲染 <img> 的时候就把地址换成后端读文件的接口（/api/fs/raw）。
let assetBase = ''; // 消息所属会话的目录（预览文件时是文件所在的目录）
let parseBase = ''; // 这一次 marked.parse 用的目录。parse 是同步的，用完就还原

/** 告诉 util 现在的“当前目录”，markdown 里的相对图片路径按它来解析 */
export function setAssetBase(dir) {
  const v = dir || '';
  if (v === assetBase) return;
  assetBase = v;
  // 缓存的 HTML 里已经有解析好的图片地址了，目录一换就得全部作废
  mdCache.clear();
  mdFinal.clear();
  mdEpoch.value++;
}

/** markdown 里的图片地址 → 浏览器能请求的地址；http(s) / data: 这类原样返回 */
export function assetUrl(src, base = assetBase) {
  let p = String(src || '').trim();
  if (!p) return '';
  if (/^file:\/\//i.test(p)) p = p.slice(7).replace(/^\/([a-zA-Z]:)/, '$1'); // file:///C:/x.png → C:/x.png
  // 盘符要先于“协议”判断，否则 C:/x.png 会被当成 c: 协议；盘符路径里的中文也要先解码
  else if (!/^[a-zA-Z]:[\\/]/.test(p) && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(p)) return p; // http(s): / data: / blob: … 交给浏览器
  try {
    p = decodeURI(p); // 中文文件名在 markdown 里常写成 %E5%9F%8E…，解回来才找得到文件
  } catch {}
  p = p.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(p) || p.startsWith('//')) return rawUrl(p); // Windows 盘符 / UNC
  if (p.startsWith('~/') || !base) return p; // 家目录：网页这边不知道 home 在哪，留着让浏览器自己报错
  // 开头的 / 当“相对项目的根”处理（README 里常见 /docs/a.png 这种写法）
  return rawUrl(joinPath(base, p.replace(/^\/+/, '')));
}

// ---------- 本地文件链接 ----------
// 模型回复里经常提到文件：`web/src/util.js`、`C:\Users\x\a.md:12`、[说明](docs/a.md)。
// 这些在渲染时变成可点的链接（<a data-file>），点了在顶部开一个标签页看文件。
// 判断宽松一点会把 `obj.method` 这种也当文件，所以分了两档：
//   - markdown 链接 [x](path)：用户/模型明确写成了链接，只要不是网址就当文件
//   - 行内代码、正文里的裸路径：要像文件才算（带扩展名；没有目录的单个文件名要是常见扩展名）
const KNOWN_EXT = new Set(
  ('js mjs cjs jsx ts tsx mts cts vue svelte py pyi rs go java kt kts c h cc cpp hpp cs php rb swift lua dart scala sql ' +
    'css scss sass less html htm xml json jsonl jsonc yaml yml toml ini cfg conf env properties md markdown mdx txt rst log csv tsv ' +
    'sh bash zsh fish ps1 psm1 psd1 bat cmd png jpg jpeg gif webp bmp svg ico pdf lock gitignore dockerfile makefile').split(' '),
);
const BAD_STRICT = /[\s<>"'`|*?(){}[\]=,;$&^%!#]/; // 行内代码里出现这些，基本就是代码不是路径
const BAD_LOOSE = /[<>"|*?]/; // Windows 文件名里本来就不允许的字符
const isWinAbs = (p) => /^[a-zA-Z]:[\\/]/.test(p);

/** 拆掉结尾的行号：a.js:12、a.js:12:3、a.md#L12-L20 */
function splitLine(p) {
  const m = /^(.+?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(p);
  return m ? { path: m[1], line: Number(m[2] || m[3]) } : { path: p, line: 0 };
}

/** 去掉 . / ..，分隔符统一成这个系统的样子（盘符路径用 \） */
function cleanPath(p) {
  const win = /^[a-zA-Z]:/.test(p);
  const parts = [];
  p.replace(/\\/g, '/')
    .split('/')
    .forEach((seg, i) => {
      if (seg === '..') parts.length > 1 && parts.pop();
      else if (seg !== '.' && (seg !== '' || i === 0)) parts.push(seg);
    });
  return parts.join(win ? '\\' : '/');
}

/**
 * 一段文字是不是本地文件路径。是的话返回 { path: 绝对路径, rel: 原来写的相对路径（绝对路径时为空）, line }。
 * loose：markdown 链接用，只要不是网址就算
 */
export function localPathOf(raw, base = assetBase, { loose = false } = {}) {
  let s = String(raw || '').trim();
  if (!s || s.length > 400) return null;
  if (/^file:\/\//i.test(s)) s = s.slice(7).replace(/^\/([a-zA-Z]:)/, '$1');
  else if (!isWinAbs(s) && /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\?)/i.test(s)) return null; // 网址、锚点
  if (loose) {
    try {
      s = decodeURI(s);
    } catch {}
  }
  const { path: p0, line } = splitLine(s);
  if ((loose ? BAD_LOOSE : BAD_STRICT).test(p0)) return null;
  const last = p0.split(/[\\/]/).pop();
  const ext = /\.([a-z0-9]{1,12})$/i.exec(last)?.[1]?.toLowerCase();
  if (!loose && (!ext || /^\d+$/.test(ext))) return null; // 没扩展名的（text/html、1.2.3 这种）不猜
  if (isWinAbs(p0)) return { path: cleanPath(p0), rel: '', line };
  if (p0.startsWith('~')) return null; // 网页不知道 home 在哪
  const winBase = isWinAbs(base || '');
  if (p0.startsWith('/')) {
    // Linux/mac 上是绝对路径；Windows 上当成“相对项目根”（README 里的 /docs/a.md）
    if (!winBase) return base || loose ? { path: cleanPath(p0), rel: '', line } : null;
  } else if (!loose && !/[\\/]/.test(p0) && !KNOWN_EXT.has(ext)) {
    return null; // 单独一个 a.b：多半是 obj.prop，只认常见扩展名
  }
  if (!base) return null;
  const rel = p0.replace(/^(?:\.[\\/])+/, '').replace(/^[\\/]+/, '');
  return { path: cleanPath(joinPath(base, rel)), rel, line };
}

const fileLink = (info, inner) =>
  `<a class="file-link" data-file="${escapeHtml(info.path)}"${info.rel ? ` data-rel="${escapeHtml(info.rel)}"` : ''}` +
  `${info.line ? ` data-line="${info.line}"` : ''} title="${escapeHtml(info.path)}\n点击在标签页中打开">${inner}</a>`;

// ---------- Markdown ----------
marked.setOptions({ gfm: true, breaks: true });
const renderer = new marked.Renderer();
let linkDepth = 0; // 正在渲染链接文字：里面的路径不能再套一层链接

// 图表示例（mermaid）：先只吐一个占位元素，源码就当文本放里面（不用 data 属性：
// DOMPurify 会把含 `-->` 这类序列的属性整个删掉，而 mermaid 到处都是箭头）；
// 真正的 SVG 由 pele 异步画好以后再填进去（见下面的 enhance）
const MERMAID_LANG = /^mermaid$/i;
renderer.code = ({ text, lang }) => {
  const l = (lang || '').split(/\s/)[0];
  if (MERMAID_LANG.test(l)) return `<div class="md-diagram">${escapeHtml(text)}</div>`;
  const { html, label } = highlightCode(text, lang);
  return `<pre class="code"><div class="code-bar"><span>${escapeHtml(label)}</span><button class="copy-btn" data-copy>复制</button></div><code class="hljs">${html}</code></pre>`;
};
renderer.link = function ({ href, title, tokens, text }) {
  linkDepth++;
  let inner;
  try {
    inner = tokens ? this.parser.parseInline(tokens) : escapeHtml(text);
  } finally {
    linkDepth--;
  }
  const file = localPathOf(href, parseBase, { loose: true });
  if (file) return fileLink(file, inner);
  const t = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${escapeHtml(href || '')}"${t} target="_blank" rel="noopener">${inner}</a>`;
};
renderer.codespan = ({ text }) => {
  const html = `<code>${escapeHtml(text)}</code>`;
  const file = !linkDepth && localPathOf(text, parseBase);
  return file ? fileLink(file, html) : html;
};
renderer.image = ({ href, title, text }) => {
  const src = escapeHtml(assetUrl(href, parseBase));
  const alt = escapeHtml(text || '');
  return `<img src="${src}" alt="${alt}"${title ? ` title="${escapeHtml(title)}"` : ''}>`;
};
marked.use({ renderer });

// ---------- 数学公式：Temml 把 TeX 翻成 MathML，排版交给浏览器（不用下载字体）----------
const TEX_OPTS = { throwOnError: false, errorColor: 'var(--err)', strict: false };
/** 一段 TeX → MathML 字符串。出错时 Temml 自己会把不认识的部分标红，不会抛异常 */
export function renderTex(tex, displayMode = false) {
  try {
    return temml.renderToString(tex, { ...TEX_OPTS, displayMode });
  } catch (e) {
    return `<span class="tex-error">${escapeHtml(tex)}</span>`;
  }
}

// 行内 $...$：开头的 $ 后面不能是空白，结尾的 $ 前面不能是空白、后面不能是数字（`$5 和 $10` 不会误判）。
// 另外带汉字的一段一般不可能是公式（真带汉字的话里面会有 \\text{} 之类的命令），否则
// `$5 和 $10 这两处…，$PATH` 这种东西会被整段当成公式
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const looksLikeTex = (s) => !CJK.test(s) || s.includes('\\');
const INLINE_TEX = /^\$(?=\S)([^\n]*?[^\s$])\$(?![\d$])/;
const INLINE_TEX_PAREN = /^\\\(([\s\S]+?)\\\)/;
const INLINE_TEX_BRACKET = /^\\\[([\s\S]+?)\\\]/;
// 独占一段的 $$...$$（marked 的块级 tokenizer 只在行首调用）
const BLOCK_TEX = /^ {0,3}\$\$[ \t]*\r?\n?([\s\S]+?)\r?\n? {0,3}\$\$[ \t]*(?:\r?\n+|$)/;

const mathPlaceholder = (tex, display) => `<span class="md-math${display ? ' block' : ''}">${escapeHtml(tex)}</span>`;

// 正文里没加反引号的 Windows 路径（C:\x\a.md）：遇到空白、引号、中文就算结束，末尾的标点不要
const WIN_PATH = /^[a-zA-Z]:[\\/][^\s<>"'`|*?\u3000-\u303f\u3400-\u9fff\uff00-\uffef]+/;

marked.use({
  extensions: [
    {
      name: 'winPath',
      level: 'inline',
      start(src) {
        const m = /(?:^|[^\w\\/:.])[a-zA-Z]:[\\/]/.exec(src);
        return m ? m.index + (/^[a-zA-Z]:/.test(m[0]) ? 0 : 1) : undefined;
      },
      tokenizer(src) {
        const m = WIN_PATH.exec(src);
        if (!m) return undefined;
        const raw = m[0].replace(/[.,;:!?)\]}]+$/, '');
        if (raw.length < 4) return undefined;
        return { type: 'winPath', raw, text: raw };
      },
      renderer(t) {
        const file = !linkDepth && localPathOf(t.text, parseBase);
        return file ? fileLink(file, escapeHtml(t.text)) : escapeHtml(t.text);
      },
    },
    {
      name: 'mathBlock',
      level: 'block',
      start(src) {
        const i = src.search(/^ {0,3}\$\$/m);
        return i < 0 ? undefined : i;
      },
      tokenizer(src) {
        const m = BLOCK_TEX.exec(src);
        if (!m || !m[1].trim()) return undefined;
        return { type: 'mathBlock', raw: m[0], text: m[1].trim(), display: true };
      },
      renderer(t) {
        return mathPlaceholder(t.text, true);
      },
    },
    {
      name: 'mathInline',
      level: 'inline',
      start(src) {
        const i = src.search(/(?:\$\$?|\\[\[(])/);
        return i < 0 ? undefined : i;
      },
      tokenizer(src) {
        if (src.startsWith('$$')) {
          const m = /^\$\$([\s\S]+?)\$\$/.exec(src);
          if (m && m[1].trim() && looksLikeTex(m[1])) return { type: 'mathInline', raw: m[0], text: m[1].trim(), display: true };
          return undefined;
        }
        const bracket = INLINE_TEX_BRACKET.exec(src);
        if (bracket && bracket[1].trim()) return { type: 'mathInline', raw: bracket[0], text: bracket[1].trim(), display: true };
        const m = INLINE_TEX.exec(src) || INLINE_TEX_PAREN.exec(src);
        if (!m || !m[1].trim() || !looksLikeTex(m[1])) return undefined;
        return { type: 'mathInline', raw: m[0], text: m[1].trim(), display: false };
      },
      renderer(t) {
        return mathPlaceholder(t.text, t.display);
      },
    },
  ],
});

// ---------- 打理 sanitize 之后的产物：占位符换成真正的内容 ----------
// 关键点：MathML / 图表的产出都算可信内容，必须在 sanitize 之后才填进去，
// 否则 DOMPurify 的白名单会把 MathML 属性、SVG 的 foreignObject 之类揉碎
const mdEpoch = ref(0); // 图渲染完（异步）就 +1，让用到 renderMarkdown 的组件自动重渲染
const mdCache = new Map(); // 源文本 → sanitize 过的 HTML（占位符还在）
const mdFinal = new Map(); // 源文本 + 字体签名 → 图都就绪的最终 HTML
const diagramCache = new Map(); // mermaid 源码 → { svg }（画好的）或 { error }（画不出来的原因）
const diagramPending = new Set();
const MAX_CACHE = 600;
const capSet = (map, k, v) => {
  map.set(k, v);
  if (map.size > MAX_CACHE) map.delete(map.keys().next().value);
};

/** 图的尺寸靠量文字算出来，所以字体一变就得重画：给它一个签名，缓存按它分 */
let fontSig = '';
function currentFontSig() {
  if (fontSig) return fontSig;
  const cs = getComputedStyle(document.documentElement);
  fontSig = `${cs.getPropertyValue('--fs').trim()}|${cs.getPropertyValue('--font').trim()}`;
  return fontSig;
}
/** 主题/字体改了就作废：下次渲染按新变量重新量、重画 */
export function resetDiagramCache() {
  fontSig = '';
  diagramCache.clear();
  mdFinal.clear();
  mdEpoch.value++;
}

// pele 的配色全部走 CSS 变量，这里把当前字体交过去（量节点宽高用），Id 前缀保证同页多张图不撞
function diagramOptions(src) {
  const cs = getComputedStyle(document.documentElement);
  const font = cs.getPropertyValue('--font').trim() || 'sans-serif';
  const mono = cs.getPropertyValue('--font-code').trim() || 'monospace';
  const size = Math.max(10, Math.round(parseFloat(cs.getPropertyValue('--fs')) || 14));
  return { idPrefix: 'pm' + hash(src), fontFamily: font, fontFamilyMono: mono, fontSize: size, math: diagramMath };
}

// 32 位 FNV-1a：给每张图一个稳定的 id 前缀
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

// 图里的 $$...$$ 标签：pele 只认“你给它的排版结果”，所以自己用 Temml 排好再量一下宽高
let mathBox = null;
const mathBoxCache = new Map();
function diagramMath(tex, size) {
  const key = size + '|' + tex;
  const hit = mathBoxCache.get(key);
  if (hit) return hit;
  if (!mathBox) {
    mathBox = document.createElement('span');
    mathBox.setAttribute('aria-hidden', 'true');
    mathBox.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:nowrap;visibility:hidden;';
    document.body.appendChild(mathBox);
  }
  mathBox.style.fontSize = size + 'px';
  mathBox.innerHTML = renderTex(tex, false);
  const out = { html: mathBox.innerHTML, width: mathBox.offsetWidth || size * Math.max(1, tex.length * 0.6), height: mathBox.offsetHeight || size * 1.4 };
  capSet(mathBoxCache, key, out);
  return out;
}

/**
 * 模型写图的时候常把 `{}` / `[]` 直接塞进 `[...]` 标签里（`H3[--workflow<br/>@upload{本地图}]`、
 * `O[转 jobs[].error 原样给用户]`）。这种写法 mermaid 自己也不认，但意思很清楚，就是标签文字。
 * 所以解析失败时先试着给这些标签整体加上引号再画一次，能救回来就救。
 */
function repairDiagram(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('[', i);
    if (open < 0) {
      out += src.slice(i);
      break;
    }
    // 找配对的 ]（标签里可能还嵌着 []，比如 jobs[].error）
    let depth = 0;
    let j = open;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '\n') {
        j = -1; // 跨行的不猜，原样放回去
        break;
      }
      if (c === '[') depth++;
      else if (c === ']' && --depth === 0) break;
    }
    if (j < 0) {
      out += src.slice(i);
      break;
    }
    const t = src.slice(open + 1, j).trim();
    // 前面紧挨着一个节点 id（避免动到文本里的 [xxx]），里面有 mermaid 不认的括号，而且还没加引号
    const prev = src.slice(i, open).trimEnd();
    if (t && /[\[\]{}]/.test(t) && !/^["']/.test(t) && /[\w-]$/.test(prev)) {
      out += `${src.slice(i, open + 1)}"${t.replace(/"/g, '#quot;')}"]`;
    } else {
      out += src.slice(i, j + 1);
    }
    i = j + 1;
  }
  return out;
}

/** 异步画一张图（pele/lazy 会按图类型去拉对应的 chunk，没用到的类型根本不下载） */
function loadDiagram(src) {
  const key = currentFontSig() + '|' + src;
  if (diagramPending.has(key)) return;
  diagramPending.add(key);
  import('pele/lazy')
    // 先按原文画；画不出来再把标签补上引号重试一次（repair 过才提示用户）
    .then(async ({ renderAsync }) => {
      try {
        return { svg: (await renderAsync(src, diagramOptions(src))).svg };
      } catch (e) {
        const fixed = repairDiagram(src);
        if (fixed !== src) {
          try {
            return { svg: (await renderAsync(fixed, diagramOptions(fixed))).svg, fixed: true };
          } catch {}
        }
        throw e;
      }
    })
    .then((v) => capSet(diagramCache, key, v))
    .catch((e) => capSet(diagramCache, key, { error: e?.message || String(e) }))
    .finally(() => {
      diagramPending.delete(key);
      mdEpoch.value++;
    });
}

/** 右上角工具条用的小图标（和 Icon.vue 同一套线条风格） */
const svgIcon = (d, cls) =>
  `<svg class="${cls}" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const I_COPY = 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1';
const I_OK = 'M5 12.5l4.5 4.5L19 7.5';
const I_CODE = 'M9 7l-5 5 5 5M15 7l5 5-5 5';
const I_DIAGRAM = 'M4 4h6v5H4zM14 15h6v5h-6zM7 9v3.5h10V15';

/** 图的源码：默认藏着，右上角按钮或“画不出来”的时候才露出来（带复制按钮） */
function diagramSourceHtml(src, label = 'mermaid') {
  return (
    `<pre class="code dgm-code"><div class="code-bar"><span>${escapeHtml(label)}</span><button class="copy-btn" data-copy>复制</button></div>` +
    `<code class="hljs">${escapeHtml(src)}</code></pre>`
  );
}

/** 图画不出来时：给一行原因，再把源码原样摆出来（能复制，能自己去修） */
function diagramErrorHtml(src, msg) {
  return `<div class="dgm-err">图示没法画：${escapeHtml(msg)}</div>${diagramSourceHtml(src)}`;
}

// 右上角的小工具条：复制源码 + 源码/图示切换（点击由 diagram.js 统一接管，图不是 Vue 组件）
const dgBar = (fixed) =>
  '<div class="dgm-bar">' +
  `<button class="dgm-btn" type="button" data-dgm-copy title="复制 mermaid 源码" aria-label="复制源码">${svgIcon(I_COPY, 'i-copy')}${svgIcon(I_OK, 'i-ok')}</button>` +
  `<button class="dgm-btn" type="button" data-dgm-toggle aria-label="切换源码 / 图示" title="${
    fixed ? '查看源码 / 图示（原图标签没加引号，已自动补上）' : '查看源码 / 图示（Ctrl+滚轮缩放，双击放大）'
  }">${svgIcon(I_CODE, 'i-src')}${svgIcon(I_DIAGRAM, 'i-dgm')}</button>` +
  '</div>';

/** sanitize 过的 HTML → 填好公式和图的 HTML；pending = 还有图没画完（这次先别缓存） */
function enhance(html) {
  if (!html.includes('md-diagram') && !html.includes('md-math')) return { html, pending: false };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let pending = false;
  for (const el of doc.querySelectorAll('.md-math')) {
    const tex = el.textContent;
    el.textContent = '';
    el.innerHTML = renderTex(tex, el.classList.contains('block'));
  }
  for (const el of doc.querySelectorAll('.md-diagram')) {
    const src = el.textContent;
    el.textContent = '';
    const hit = diagramCache.get(currentFontSig() + '|' + src);
    if (hit?.svg) {
      // pele 的缩放（enableZoom）要求容器的第一个子元素就是 svg，所以 svg 必须排在最前面；
      // 容器里也不能再塞会占高度的东西（它一旦变高就会触发“容器尺寸变了 → 重算”，缩放会被还原）
      el.innerHTML = hit.svg + diagramSourceHtml(src, hit.fixed ? 'mermaid（原图标签没加引号，已自动补上）' : 'mermaid') + dgBar(hit.fixed);
    } else if (hit?.error) {
      el.classList.add('err');
      el.innerHTML = diagramErrorHtml(src, hit.error);
    } else {
      pending = true;
      el.classList.add('loading');
      el.textContent = '正在渲染图示…';
      loadDiagram(src);
    }
  }
  return { html: doc.body.innerHTML, pending };
}

/**
 * live：这段还在流式输出（每 50ms 变一次），结果不进缓存。
 * 不然一条长回复的几百个中间状态会把缓存（600 条）挤满，把真正有用的都顶出去
 */
export function renderMarkdown(src, base = assetBase, { live = false } = {}) {
  void mdEpoch.value; // 图渲染完 / 字体变了时，把这个依赖收集进调用方组件
  src = src || '';
  const hasDiagram = /\bmermaid\b/i.test(src);
  // 目录也算进 key：同一段 markdown 在别的目录里图片指向的文件不一样
  const key = `${base}\u0000${hasDiagram ? currentFontSig() + '\u0000' : ''}${src}`;
  const done = mdFinal.get(key);
  if (done !== undefined) return done;
  let html = mdCache.get(key);
  if (html === undefined) {
    parseBase = base;
    try {
      html = DOMPurify.sanitize(marked.parse(src), { ADD_ATTR: ['target', 'data-copy'] });
    } finally {
      parseBase = '';
    }
    if (!live) capSet(mdCache, key, html);
  }
  const { html: out, pending } = enhance(html);
  if (!pending && !live) capSet(mdFinal, key, out);
  return out;
}

export const LEVEL_NAMES = { off: '关闭', minimal: '极少', low: '低', medium: '中', high: '高', xhigh: '极高' };
export const levelName = (l) => LEVEL_NAMES[l] || l || '-';

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function highlightFile(name, text) {
  if (text.length > 400_000) return escapeHtml(text);
  const ext = name.split('.').pop().toLowerCase();
  // 扩展名走同一张别名表（md → markdown、ps1 → powershell、vue → xml …）
  return highlightCode(text, ext).html;
}

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;

// ---------- 附件 ----------
// 发给模型的只是路径：拼在提示词最后面，带编号，模型需要看内容时自己用 read 工具读。
// 编号只对这一条消息有效（每轮都按输入框上面当前的顺序重新编）
const ATT_NOTE = '以下是用户附带的文件路径（编号只对本条消息有效），需要查看内容时请用 read 工具读取。';
// 模型能用 read 当图片读的那几种才算 image（svg 其实是文本）
const VISION_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
export const attachKind = (name, dir = false) => (dir ? 'dir' : VISION_EXT.test(name || '') ? 'image' : 'file');
export const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');

// ---------- 文件类型图标 ----------
// 文件树/附件前面那个小图标：目录给 folder，其余按扩展名猜，认不出来就是通用文件图标。
// 返回的是 Icon.vue 里的图标名，所以这里只管名字，不管怎么画
const EXT_ICONS = [
  ['image', /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif|tiff?)$/i],
  ['code', /\.(js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|pyi|rs|go|java|kt|kts|c|h|cc|cpp|hpp|cs|php|rb|swift|lua|dart|scala|sql|css|scss|sass|less|html?|xml)$/i],
  ['data', /\.(json|jsonl|jsonc|ya?ml|ini|cfg|conf|env|properties|csv|tsv|toml)$/i],
  ['doc', /\.(md|markdown|mdx|txt|rst|pdf|docx?|xlsx?|pptx?|rtf|tex|log)$/i],
  ['terminal', /\.(sh|bash|zsh|fish|ps1|bat|cmd)$/i],
  ['archive', /\.(zip|tar|gz|tgz|bz2|xz|7z|rar|jar|whl|exe|msi|dmg)$/i],
  ['media', /\.(mp3|wav|flac|m4a|ogg|opus|aac|mp4|mkv|avi|mov|webm)$/i],
];
const LOCK_FILES = /^(package-lock\.json|yarn\.lock|pnpm-lock\.ya?ml|cargo\.lock|poetry\.lock|pipfile\.lock|composer\.lock|gemfile\.lock)$/i;
export function iconOf(name, dir = false) {
  const n = baseName(name);
  if (dir) return 'folder';
  if (LOCK_FILES.test(n)) return 'lock';
  const hit = EXT_ICONS.find(([, re]) => re.test(n));
  return hit ? hit[0] : 'file';
}

export function buildAttachmentBlock(list) {
  const lines = list.map((a, i) => `[${i + 1}] ${a.kind}: ${a.path}`);
  return `<attachments>\n${ATT_NOTE}\n${lines.join('\n')}\n</attachments>`;
}

// 现在都拼在最后；最前面的是老版本发的，也认
const ATT_HEAD = /^<attachments>\r?\n([\s\S]*?)\r?\n<\/attachments>[ \t]*(?:\r?\n){0,2}/;
const ATT_TAIL = /(?:\r?\n){1,2}<attachments>\r?\n([\s\S]*?)\r?\n<\/attachments>\s*$/;
const ATT_LINE = /^\[(\d+)\]\s+(image|file|dir):\s+(.+)$/;

/** 把消息里的 <attachments> 块拆出来：返回 { text: 正文, attachments: [{ n, kind, path, name }] } */
export function splitAttachments(text) {
  const s = typeof text === 'string' ? text : '';
  const m = s.match(ATT_HEAD) || s.match(ATT_TAIL);
  if (!m) return { text: s, attachments: [] };
  const attachments = [];
  for (const line of m[1].split(/\r?\n/)) {
    const x = line.trim().match(ATT_LINE);
    if (x) attachments.push({ n: Number(x[1]), kind: x[2], path: x[3].trim(), name: baseName(x[3].trim()) });
  }
  return { text: s.slice(0, m.index) + s.slice(m.index + m[0].length), attachments };
}
export const stripAttachments = (text) => splitAttachments(text).text;

export function fmtSize(s) {
  if (s == null) return '';
  return s < 1024 ? `${s} B` : s < 1048576 ? `${(s / 1024).toFixed(1)} KB` : s < 1073741824 ? `${(s / 1048576).toFixed(1)} MB` : `${(s / 1073741824).toFixed(2)} GB`;
}
