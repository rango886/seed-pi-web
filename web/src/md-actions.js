// 渲染出来的 markdown（v-html）里的交互：文件链接、代码块的“复制”。
// 对话、文件预览、系统消息都是同一套 HTML，所以统一挂在 document 上委托处理，
// 不用每个组件各写一遍（以前文件预览里的“复制”按钮就是因为没人接而点了没反应）
import { http } from './api.js';
import { S, openFile, openPicker, toast } from './store.js';
import { toolPath, normPath, isAbsPath, joinPath } from './util.js';

/** 这个会话里模型用工具（read/edit/write…）碰过的文件，统一成 normPath 的样子 */
function toolPaths() {
  const set = new Set();
  for (const m of S.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b?.type !== 'toolCall') continue;
      const p = toolPath(b.arguments);
      if (p) set.add(normPath(isAbsPath(p) ? p : joinPath(S.cwd, p)));
    }
  }
  return set;
}

const relTo = (p, root) => {
  const r = root.replace(/[\\/]+$/, '');
  return p.toLowerCase().startsWith(r.toLowerCase()) ? p.slice(r.length).replace(/^[\\/]+/, '') : p;
};

/**
 * 按原路径找不到时：在项目里找路径以 rel 结尾的文件。
 * 只有一个就直接开；好几个时，对话里工具用过的优先，还分不出来就弹列表让人选。找到了返回 true
 */
async function resolveByName(rel, line) {
  if (!rel || !S.cwd) return false;
  const r = await http.get('/api/fs/resolve', { cwd: S.cwd, rel }).catch(() => null);
  const list = r?.matches || [];
  if (!list.length) return false;
  if (list.length === 1) return openFile(list[0], { line }), true;
  const seen = toolPaths();
  const known = list.filter((p) => seen.has(normPath(p)));
  if (known.length === 1) return openFile(known[0], { line }), true;
  const ordered = [...known, ...list.filter((p) => !known.includes(p))];
  openPicker({
    title: `有 ${list.length} 个文件对得上“${rel}”，打开哪个？`,
    items: ordered.map((p) => ({ label: relTo(p, S.cwd), detail: known.includes(p) ? '对话里用过' : '', value: p })),
    onPick: (p) => openFile(p, { line }),
  });
  return true;
}

async function openLink(a) {
  const path = a.dataset.file;
  const line = Number(a.dataset.line) || 0;
  // 先问一下后端有没有这个文件：模型提到的路径不一定真存在，别开一个只写着“出错”的空标签
  const st = await http.get('/api/fs/stat', { path }).catch(() => null);
  if (!st) return openFile(path, { line }); // 问不到就照常打开，让标签页自己报错
  if (st.exists && !st.dir) return openFile(st.path, { line });
  // 模型常常只写个文件名（`util.js`）或半截路径，拼上当前目录不对，就去项目里找
  if (await resolveByName(a.dataset.rel, line)) return;
  if (st.dir) return toast(`这是一个文件夹：${path}`, 'warning');
  toast(`文件不存在：${a.dataset.rel || path}`, 'warning');
}

function copyCode(btn) {
  const code = btn.closest('pre')?.querySelector('code');
  if (!code) return;
  navigator.clipboard?.writeText(code.innerText).then(() => {
    btn.textContent = '已复制';
    clearTimeout(btn._t);
    btn._t = setTimeout(() => (btn.textContent = '复制'), 1200);
  });
}

export function startMdActions() {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = e.target.closest?.('a[data-file]');
    if (a) {
      e.preventDefault();
      // 链接里的图片照样让灯箱处理（ChatView 自己会接），这里只管打开文件
      if (!e.target.closest('img')) openLink(a);
      return;
    }
    const btn = e.target.closest?.('.md [data-copy]');
    if (btn) copyCode(btn);
  });
}
