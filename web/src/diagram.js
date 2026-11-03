// mermaid 图（pele 画的）的交互：缩放 / 拖动 / 源码切换 / 复制源码。
//
// 缩放拖动直接用 pele 自带的 enableZoom：图比容器宽时右下角会出现放大、缩小、还原三个按钮，
// Ctrl+滚轮（触控板双指）也能缩放，双击放大，放大以后按住就能拖。
//
// 图是 v-html 塞进来的，不是 Vue 组件，没法在模板里挂事件，所以这里用 MutationObserver
// 盯新出现的 .md-diagram，出现一张接一张；右上角工具条的按钮用事件委托统一处理。

let peleP = null;
const pele = () => (peleP ||= import('pele/lazy'));

/** 给一张图接上缩放；同一张图只接一次（dataset 标记跟着元素走，元素被重画才会再来） */
function bind(box) {
  if (box.dataset.dgm || box.firstElementChild?.localName !== 'svg') return; // 报错卡片没有 svg，不用接
  box.dataset.dgm = '1';
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
  const btn = e.target.closest?.('[data-dgm-toggle], [data-dgm-copy]');
  if (!btn) return;
  const box = btn.closest('.md-diagram');
  if (!box) return;
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
