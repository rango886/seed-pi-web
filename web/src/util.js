import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';

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
  return (n / 1e6).toFixed(2) + 'M';
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

// ---------- Markdown ----------
marked.setOptions({ gfm: true, breaks: true });
const renderer = new marked.Renderer();
renderer.code = ({ text, lang }) => {
  const l = (lang || '').split(/\s/)[0];
  let html;
  try {
    // 自动识别语言很慢，长代码块直接不猜
    if (l && hljs.getLanguage(l)) html = hljs.highlight(text, { language: l }).value;
    else if (text.length < 3000) html = hljs.highlightAuto(text).value;
    else html = escapeHtml(text);
  } catch {
    html = escapeHtml(text);
  }
  return `<pre class="code"><div class="code-bar"><span>${escapeHtml(l)}</span><button class="copy-btn" data-copy>复制</button></div><code class="hljs">${html}</code></pre>`;
};
renderer.link = ({ href, text }) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
marked.use({ renderer });

// 渲染结果缓存：同一段文字不重复解析和高亮（流式输出、切换界面时省掉大量计算）
const mdCache = new Map();
export function renderMarkdown(src) {
  src = src || '';
  const hit = mdCache.get(src);
  if (hit !== undefined) return hit;
  const html = DOMPurify.sanitize(marked.parse(src), { ADD_ATTR: ['target', 'data-copy'] });
  mdCache.set(src, html);
  if (mdCache.size > 600) mdCache.delete(mdCache.keys().next().value);
  return html;
}

export const LEVEL_NAMES = { off: '关闭', minimal: '极少', low: '低', medium: '中', high: '高', xhigh: '极高' };
export const levelName = (l) => LEVEL_NAMES[l] || l || '-';

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const EXT_LANG = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript', py: 'python', rs: 'rust', go: 'go', md: 'markdown', json: 'json', jsonl: 'json', yml: 'yaml', yaml: 'yaml', sh: 'bash', ps1: 'powershell', vue: 'xml', html: 'xml', xml: 'xml', css: 'css', scss: 'scss', c: 'c', h: 'c', cpp: 'cpp', java: 'java', sql: 'sql', toml: 'ini', ini: 'ini', lua: 'lua', rb: 'ruby', php: 'php', kt: 'kotlin', swift: 'swift', cs: 'csharp' };
export function highlightFile(name, text) {
  const ext = name.split('.').pop().toLowerCase();
  const lang = EXT_LANG[ext];
  if (text.length > 400_000) return escapeHtml(text);
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(text, { language: lang }).value;
  } catch {}
  return escapeHtml(text);
}

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;
