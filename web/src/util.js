import { marked } from 'marked';
import DOMPurify from 'dompurify';
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

// ---------- Markdown ----------
marked.setOptions({ gfm: true, breaks: true });
const renderer = new marked.Renderer();

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
renderer.link = ({ href, text }) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
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
const INLINE_TEX = /^\$(?=\S)([^\n]*?[^\s$])\$(?![\d$])/;;
const INLINE_TEX_PAREN = /^\\\(([\s\S]+?)\\\)/;
const INLINE_TEX_BRACKET = /^\\\[([\s\S]+?)\\\]/;
// 独占一段的 $$...$$（marked 的块级 tokenizer 只在行首调用）
const BLOCK_TEX = /^ {0,3}\$\$[ \t]*\r?\n?([\s\S]+?)\r?\n? {0,3}\$\$[ \t]*(?:\r?\n+|$)/;

const mathPlaceholder = (tex, display) => `<span class="md-math${display ? ' block' : ''}">${escapeHtml(tex)}</span>`;

marked.use({
  extensions: [
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
const diagramCache = new Map(); // mermaid 源码 → SVG（或错误提示）
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

/** 异步画一张图（pele/lazy 会按图类型去拉对应的 chunk，没用到的类型根本不下载） */
function loadDiagram(src) {
  const key = currentFontSig() + '|' + src;
  if (diagramPending.has(key)) return;
  diagramPending.add(key);
  import('pele/lazy')
    .then(({ renderAsync }) => renderAsync(src, diagramOptions(src)))
    .then(({ svg }) => capSet(diagramCache, key, svg))
    .catch((e) => capSet(diagramCache, key, `<div class="md-diagram err">图示渲染失败：${escapeHtml(e?.message || String(e))}</div>`))
    .finally(() => {
      diagramPending.delete(key);
      mdEpoch.value++;
    });
}

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
    const svg = diagramCache.get(currentFontSig() + '|' + src);
    if (svg) el.innerHTML = svg;
    else {
      pending = true;
      el.classList.add('loading');
      el.textContent = '正在渲染图示…';
      loadDiagram(src);
    }
  }
  return { html: doc.body.innerHTML, pending };
}

export function renderMarkdown(src) {
  void mdEpoch.value; // 图渲染完 / 字体变了时，把这个依赖收集进调用方组件
  src = src || '';
  const hasDiagram = /\bmermaid\b/i.test(src);
  const key = hasDiagram ? currentFontSig() + '|' + src : src;
  const done = mdFinal.get(key);
  if (done !== undefined) return done;
  let html = mdCache.get(src);
  if (html === undefined) {
    html = DOMPurify.sanitize(marked.parse(src), { ADD_ATTR: ['target', 'data-copy'] });
    capSet(mdCache, src, html);
  }
  const { html: out, pending } = enhance(html);
  if (!pending) capSet(mdFinal, key, out);
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
