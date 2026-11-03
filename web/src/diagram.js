// mermaid 图（pele 画的）的交互：缩放 / 拖动 / 源码切换 / 复制源码。
//
// 缩放拖动直接用 pele 自带的 enableZoom：图比容器宽时右下角会出现放大、缩小、还原三个按钮，
// Ctrl+滚轮（触控板双指）也能缩放，双击放大，放大以后按住就能拖。
//
// 图是 v-html 塞进来的，不是 Vue 组件，没法在模板里挂事件，所以这里用 MutationObserver
// 盯新出现的 .md-diagram，出现一张接一张；右上角工具条的按钮用事件委托统一处理。

import { openLightbox } from './settings.js';

let peleP = null;
const pele = () => (peleP ||= import('pele/lazy'));
let fullSeq = 0;

/** 把页面上这张图复制一份给灯箱用：
 *  - pele 的缩放会改 viewBox 和内联宽高，先还原成刚画出来的样子
 *  - 图里的 id（箭头 marker、渐变……）换个前缀，免得和原图重名；原图在“看源码”时是藏起来的，引用到它身上就画不出来 */
function fullItem(box) {
  const svg = box.querySelector(':scope > svg');
  if (!svg) return null;
  const c = svg.cloneNode(true);
  const vb = box.dataset.vb || c.getAttribute('viewBox') || `0 0 ${c.getAttribute('width')} ${c.getAttribute('height')}`;
  const [, , w, h] = vb.split(/[\s,]+/).map(Number);
  c.setAttribute('viewBox', vb);
  for (const p of ['width', 'height', 'max-width', 'margin', 'display', 'cursor', 'user-select', 'touch-action']) c.style.removeProperty(p);
  c.removeAttribute('tabindex');
  const pre = `lb${++fullSeq}-`;
  const ids = [...c.querySelectorAll('[id]')].map((n) => n.id).sort((a, b) => b.length - a.length);
  let s = c.outerHTML;
  for (const id of ids) {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`(id="|#)${esc}(?![\\w-])`, 'g'), `$1${pre}${id}`);
  }
  return { svg: s, w: w || svg.clientWidth || 400, h: h || svg.clientHeight || 300, alt: 'mermaid 图示', name: `diagram-${Date.now()}.svg` };
}

/** 给一张图接上缩放；同一张图只接一次（dataset 标记跟着元素走，元素被重画才会再来） */
function bind(box) {
  if (box.dataset.dgm || box.firstElementChild?.localName !== 'svg') return; // 报错卡片没有 svg，不用接
  box.dataset.dgm = '1';
  box.dataset.vb = box.firstElementChild.getAttribute('viewBox') || ''; // 记下原始 viewBox：放大以后 pele 会改它
  pele()
    .then(({ enableZoom }) => {
      if (!box.isConnected) return; // 等着加载的这几毫秒里可能已经被新的渲染换掉了
      box._zoom = enableZoom(box, {
        maxScale: 4,
        labels: { zoomIn: '放大', zoomOut: '缩小', reset: '还原' },
      });
    })
    .catch(() => {});
}

function scan(root) {
  if (root.matches?.('.md-diagram')) bind(root);
  // 大部分新增节点（消息里的一个 span、一行文字）里根本没有图：先用 getElementsByClassName 粗筛，比 querySelectorAll 便宜
  if (root.getElementsByClassName?.('md-diagram').length) for (const box of root.querySelectorAll('.md-diagram')) bind(box);
}

function onClick(e) {
  const btn = e.target.closest?.('[data-dgm-toggle], [data-dgm-copy], [data-dgm-full]');
  if (!btn) return;
  const box = btn.closest('.md-diagram');
  if (!box) return;
  if (btn.hasAttribute('data-dgm-full')) {
    const it = fullItem(box);
    if (it) openLightbox([it]);
    return;
  }
  if (btn.hasAttribute('data-dgm-copy')) {
    const src = box.querySelector('.dgm-code code')?.textContent || '';
    navigator.clipboard?.writeText(src).then(() => {
      btn.classList.add('done');
      clearTimeout(btn._t);
      btn._t = setTimeout(() => btn.classList.remove('done'), 1200);
    });
    return;
  }
  box.classList.toggle('show-src');
  box._zoom?.refresh(); // 换了显示内容，尺寸变了要重新算一下“适应容器”的比例
}

export function startDiagramBinder() {
  scan(document);
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) scan(n);
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('click', onClick);
  // 按钮自己的 pointerdown 别冒到容器上，不然会被 pele 的拖动逻辑接走（点了按钮变成拖图）
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.target.closest?.('.dgm-bar')) e.stopPropagation();
    },
    true,
  );
}
