// mermaid 图（pele 画的）的交互：缩放 / 拖动 / 源码切换 / 复制源码。
//
// 缩放拖动直接用 pele 自带的 enableZoom：图比容器宽时右下角会出现放大、缩小、还原三个按钮，
// Ctrl+滚轮（触控板双指）也能缩放，双击放大，放大以后按住就能拖。
//
// 图是 v-html 塞进来的，不是 Vue 组件，没法在模板里挂事件，所以这里用 MutationObserver
// 盯新出现的 .md-diagram，出现一张接一张；右上角工具条的按钮用事件委托统一处理。

import { openLightbox } from './settings.js';
import { prefixSvgIds } from './diagram-svg.js';

let peleP = null;
const pele = () => (peleP ||= import('pele/lazy').catch((e) => { peleP = null; throw e; }));
const bindings = new WeakMap();
const isolated = new WeakSet();
let diagramSeq = 0;
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
  const s = prefixSvgIds(c.outerHTML, `lb${++fullSeq}-`);
  return { svg: s, w: w || svg.clientWidth || 400, h: h || svg.clientHeight || 300, alt: 'mermaid 图示', name: `diagram-${Date.now()}.svg` };
}

/** 以实际 SVG 和初始化状态去重；切换期间取消的初始化不能留下“已绑定”标记。 */
function bind(box) {
  let svg = box.firstElementChild;
  if (!box.isConnected || svg?.localName !== 'svg') return;
  const previous = bindings.get(box);
  if (previous?.svg === svg && (previous.pending || box._zoom)) return;
  unbind(box);
  // 缓存中的同一张图可能同时出现在对话和隐藏的文件预览里，不能共享 marker / clipPath 等 id。
  if (!isolated.has(svg)) {
    const html = svg.outerHTML;
    const namespaced = prefixSvgIds(html, `dgm${++diagramSeq}-`);
    if (namespaced !== html) svg.outerHTML = namespaced;
    svg = box.firstElementChild;
    isolated.add(svg);
  }
  const state = { svg, pending: true };
  bindings.set(box, state);
  box.dataset.vb = svg.getAttribute('viewBox') || '';
  pele()
    .then(({ enableZoom }) => {
      if (bindings.get(box) !== state || !box.isConnected || box.firstElementChild !== svg) return;
      box._zoom = enableZoom(box, {
        maxScale: 4,
        labels: { zoomIn: '放大', zoomOut: '缩小', reset: '还原' },
      });
      box.dataset.dgm = '1';
    })
    .catch(() => {})
    .finally(() => { state.pending = false; });
}

function unbind(box) {
  bindings.delete(box);
  box._zoom?.destroy();
  delete box._zoom;
  delete box.dataset.dgm;
}

function scan(root, visit = bind) {
  if (root.matches?.('.md-diagram')) visit(root);
  // 大部分新增节点（消息里的一个 span、一行文字）里根本没有图：先粗筛。
  if (root.getElementsByClassName?.('md-diagram').length) for (const box of root.querySelectorAll('.md-diagram')) visit(box);
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
    for (const r of records) {
      for (const n of r.removedNodes) if (n.nodeType === 1) scan(n, (box) => { if (!box.isConnected) unbind(box); });
      // 占位容器可能被原位复用，只插入 SVG：也要检查发生变更的父容器。
      const box = r.target.closest?.('.md-diagram');
      if (box) bind(box);
      for (const n of r.addedNodes) if (n.nodeType === 1) scan(n);
    }
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
