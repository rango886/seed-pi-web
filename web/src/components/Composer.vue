<script setup>
import { ref, toRef, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { S, submit, stop, allCommands, BUILTINS, toast, setThinking, setDefaultThinking, compact, showSessionInfo, hasStatus, otherAgents, viewer, takeOver, openDirPicker, openFile, attachPaths, uploadFiles, pasteFiles, removeAttachment, clearAttachments, moveAttachment, ORIGIN_LABEL, warmUp } from '../store.js';
import { UI, view, openMenu } from '../settings.js';
import { http, rawUrl } from '../api.js';
import { fmtTokens, levelName, joinPath, fmtSize } from '../util.js';
import ModelMenu from './ModelMenu.vue';
import AttTooltip from './AttTooltip.vue';
import Icon from './Icon.vue';

const ta = ref(null);
const fileInput = ref(null);
const sel = ref(0);
const menu = toRef(view, 'menu'); // 'model' | 'thinking' | null，Ctrl+L 也会打开 model
const focused = ref(false);
const history = JSON.parse(localStorage.getItem('pi-web-history') || '[]');
let histIdx = -1;

// ---- 斜杠命令菜单 ----
const slashQuery = computed(() => {
  const m = S.composer.text.match(/^\/(\S*)$/);
  return m ? m[1].toLowerCase() : null;
});
const SRC = { pi: '', tui: '终端', extension: '扩展', prompt: '模板', skill: '技能' };
const items = computed(() => {
  const q = slashQuery.value;
  if (q == null) return [];
  const all = allCommands();
  const starts = all.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = all.filter((c) => !c.name.toLowerCase().startsWith(q) && (c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q)));
  return [...starts, ...contains].slice(0, 60);
});
watch(slashQuery, () => (sel.value = 0));
const slashEl = ref(null);
watch(sel, () => nextTick(() => slashEl.value?.querySelector('.sl.active')?.scrollIntoView({ block: 'nearest' })));

function pick(c, run) {
  const builtin = BUILTINS.find((b) => b.name === c.name);
  if (run && (builtin || c.source === 'tui')) {
    S.composer.text = '';
    submit(`/${c.name}`);
  } else S.composer.text = `/${c.name} `;
  nextTick(() => ta.value?.focus());
}

// ---- 发送 ----
const atts = computed(() => S.composer.attachments);
const hasInput = computed(() => !!S.composer.text.trim() || atts.value.some((a) => a.status === 'ready'));
async function send(followUp = false) {
  const text = S.composer.text;
  if (!text.trim() && !atts.value.length) return;
  S.composer.text = ''; // 先清空，失败再放回去，感觉更跟手（附件清不清由 submit 按设置决定）
  const ok = await submit(text, { followUp });
  if (ok) {
    if (text.trim() && history[0] !== text) {
      history.unshift(text);
      history.length = Math.min(history.length, 100);
      localStorage.setItem('pi-web-history', JSON.stringify(history));
    }
  } else if (!S.composer.text) S.composer.text = text;
  histIdx = -1;
  nextTick(() => ta.value?.focus());
}

// ---- @ 引用项目里的文件：光标前面是「@xxx」就弹补全，选中后变成上面的附件 ----
const caret = ref(0);
const syncCaret = () => (caret.value = ta.value?.selectionStart ?? 0);
const atMatch = computed(() => {
  if (slashQuery.value != null) return null;
  const before = S.composer.text.slice(0, caret.value);
  const m = before.match(/(^|\s)@([^\s@]*)$/);
  return m ? { q: m[2], start: caret.value - m[2].length - 1 } : null;
});
const atOff = ref(false); // Esc 关掉以后，这个 @ 就不再弹
watch(() => atMatch.value?.start, () => (atOff.value = false));
const proj = ref(null);
let projKey = '';
async function loadProj() {
  const key = `${S.cwd}|${S.fsEpoch}`;
  if (projKey === key) return;
  projKey = key;
  try {
    proj.value = await http.get('/api/fs/files', { cwd: S.cwd });
  } catch {
    proj.value = null;
    projKey = '';
  }
}
watch(() => !!atMatch.value, (v) => v && loadProj());
const projEntries = computed(() => {
  const p = proj.value;
  if (!p) return [];
  return [...p.dirs.map((rel) => ({ rel, dir: true })), ...p.files.map((rel) => ({ rel, dir: false }))].map((e) => {
    const l = e.rel.toLowerCase();
    return { ...e, l, base: l.slice(l.lastIndexOf('/') + 1) };
  });
});
// 打分：文件名开头匹配 > 文件名包含 > 路径包含 > 按顺序出现的字母（模糊）；分越小越靠前
function score(e, q) {
  if (!q) return e.l.split('/').length * 1000 + e.l.length;
  if (e.base === q) return 0;
  if (e.base.startsWith(q)) return 10 + e.base.length;
  if (e.base.includes(q)) return 200 + e.base.length;
  if (e.l.includes(q)) return 1000 + e.l.length;
  let i = 0;
  for (const ch of e.l) if (ch === q[i] && ++i === q.length) return 5000 + e.l.length;
  return -1;
}
const atItems = computed(() => {
  const m = atMatch.value;
  if (!m || atOff.value || !proj.value) return [];
  const q = m.q.toLowerCase().replace(/\\/g, '/');
  const hits = [];
  for (const e of projEntries.value) {
    const s = score(e, q);
    if (s >= 0) hits.push([s, e]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  return hits.slice(0, 50).map(([, e]) => e);
});
const atSel = ref(0);
watch(atItems, () => (atSel.value = 0));
const atEl = ref(null);
watch(atSel, () => nextTick(() => atEl.value?.querySelector('.sl.active')?.scrollIntoView({ block: 'nearest' })));
const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const nameOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);

/** drill：目录按 Tab 就是「进入」，把 @ 后面补成这个目录接着挑；其它情况都是加成附件 */
function pickAt(e, drill = false) {
  const m = atMatch.value;
  if (!m) return;
  const t = S.composer.text;
  const end = caret.value;
  let pos = m.start;
  if (drill && e.dir) {
    const ins = `@${e.rel}/`;
    S.composer.text = t.slice(0, m.start) + ins + t.slice(end);
    pos = m.start + ins.length;
  } else {
    S.composer.text = t.slice(0, m.start) + t.slice(end);
    const p = proj.value;
    attachPaths([{ path: joinPath(p.root, e.rel.split('/').join(p.sep), p.sep), dir: e.dir }], 'mention');
  }
  nextTick(() => {
    ta.value?.focus();
    ta.value?.setSelectionRange(pos, pos);
    syncCaret();
  });
}

function onKey(e) {
  if (e.isComposing || e.keyCode === 229) return;
  if (atItems.value.length) {
    const n = atItems.value.length;
    if (e.key === 'ArrowDown') return e.preventDefault(), (atSel.value = (atSel.value + 1) % n);
    if (e.key === 'ArrowUp') return e.preventDefault(), (atSel.value = (atSel.value - 1 + n) % n);
    if (e.key === 'Tab') return e.preventDefault(), pickAt(atItems.value[atSel.value], true);
    if (e.key === 'Enter' && !e.shiftKey) return e.preventDefault(), pickAt(atItems.value[atSel.value]);
    if (e.key === 'Escape') return e.preventDefault(), e.stopPropagation(), (atOff.value = true);
  }
  if (items.value.length) {
    if (e.key === 'ArrowDown') return e.preventDefault(), (sel.value = (sel.value + 1) % items.value.length);
    if (e.key === 'ArrowUp') return e.preventDefault(), (sel.value = (sel.value - 1 + items.value.length) % items.value.length);
    if (e.key === 'Tab') return e.preventDefault(), pick(items.value[sel.value], false);
    if (e.key === 'Enter' && !e.shiftKey) return e.preventDefault(), pick(items.value[sel.value], true);
    if (e.key === 'Escape') return e.preventDefault(), e.stopPropagation(), (S.composer.text = '');
  }
  if (e.key === 'Enter') {
    const mod = e.ctrlKey || e.metaKey;
    const isSend = UI.sendKey === 'ctrlEnter' ? mod : !e.shiftKey && !mod;
    if (isSend || e.altKey) {
      e.preventDefault();
      return send(e.altKey);
    }
  }
  // 输入框为空时 ↑↓ 翻历史输入
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && (!S.composer.text || histIdx >= 0)) {
    const el = ta.value;
    if (e.key === 'ArrowUp' && el.selectionStart !== 0 && S.composer.text) return;
    e.preventDefault();
    histIdx = e.key === 'ArrowUp' ? Math.min(histIdx + 1, history.length - 1) : histIdx - 1;
    S.composer.text = histIdx >= 0 ? history[histIdx] || '' : '';
  }
}

// ---- 附件：粘贴 / 拖进来 / 点按钮选 / 从文件树拖 ----
function onPaste(e) {
  const dt = e.clipboardData;
  if (!dt) return;
  const files = [...dt.files];
  if (files.length) {
    e.preventDefault();
    pasteFiles(files);
    return;
  }
  // 浏览器既没给文件也没给文字（有的浏览器粘贴复制的文件就是这样）：本机的话问后端剪贴板里有没有文件
  const types = [...dt.types];
  if (S.info.local && !types.includes('text/plain') && !types.includes('text/html')) {
    e.preventDefault();
    pasteFiles([]);
  }
}
const dragging = ref(false);
const isFileDrag = (e) => {
  const t = [...(e.dataTransfer?.types || [])];
  return !t.includes('application/x-pi-att') && (t.includes('Files') || t.includes('application/x-pi-path'));
};
function onDragOver(e) {
  if (!isFileDrag(e)) return; // 拖一段文字进来：交给输入框自己处理
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  dragging.value = true;
}
function onDrop(e) {
  dragging.value = false;
  const dt = e.dataTransfer;
  if (!dt) return;
  // 从右侧文件树拖来的：本来就是后端的路径，直接用
  const piPath = dt.getData('application/x-pi-path');
  if (piPath) {
    e.preventDefault();
    try {
      attachPaths(JSON.parse(piPath), 'tree');
    } catch {}
    return;
  }
  if (!dt.files?.length) return;
  e.preventDefault();
  // 资源管理器拖来的：浏览器拿不到路径，只能上传。文件夹没法传，跳过
  const items = [...(dt.items || [])].filter((it) => it.kind === 'file');
  const files = [];
  let dirs = 0;
  [...dt.files].forEach((f, i) => (items[i]?.webkitGetAsEntry?.()?.isDirectory ? dirs++ : files.push(f)));
  if (dirs) toast(`文件夹没法上传，跳过了 ${dirs} 个。可以从右侧文件树拖，或者在资源管理器里复制后到这里 Ctrl+V`, 'warning', 7000);
  uploadFiles(files);
}
function onPickFiles(e) {
  uploadFiles([...(e.target.files || [])]);
  e.target.value = '';
}

// 附件拖动调顺序：拖到哪个上面就立刻挪过去，编号跟着变
const dragAtt = ref(-1);
function chipDragStart(e, i) {
  dragAtt.value = i;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('application/x-pi-att', String(i));
}
function chipDragOver(e, i) {
  if (dragAtt.value < 0) return;
  e.preventDefault();
  e.stopPropagation();
  if (dragAtt.value !== i) {
    moveAttachment(dragAtt.value, i);
    dragAtt.value = i;
  }
}
// 附件的悬停浮层：图片附件平时只露个缩略图，名字、完整路径、大小这些都放这里
const tip = ref(null); // { anchor, index, name, path, info }，位置由 AttTooltip 自己算
// 浮层里最后一行：正在上传就报进度，否则报来源和大小
// 卡片第二行的小字：扩展名 + 大小（文件夹就写“文件夹”）
function cardMeta(a) {
  if (a.status === 'uploading') return `上传中 ${Math.round((a.progress || 0) * 100)}%`;
  if (a.kind === 'dir') return '文件夹';
  const dot = a.name.lastIndexOf('.');
  const ext = dot > 0 ? a.name.slice(dot + 1).toLowerCase() : '';
  return [ext, a.size != null ? fmtSize(a.size) : ''].filter(Boolean).join(' · ');
}
function tipInfo(a) {
  if (a.status === 'uploading') return `正在上传 ${Math.round((a.progress || 0) * 100)}%`;
  return [ORIGIN_LABEL[a.origin] || '', a.size != null ? fmtSize(a.size) : ''].filter(Boolean).join(' · ');
}
function showTip(e, a, i) {
  tip.value = { anchor: e.currentTarget.getBoundingClientRect(), index: i + 1, name: a.name, path: a.path, info: tipInfo(a) };
}
const hideTip = () => (tip.value = null);
// 附件变了（发送、清空、删除）就把浮层收起来，别让它留在半空
watch(
  () => atts.value.map((a) => a.id).join(),
  () => hideTip(),
);
const isImage = (a) => a.kind === 'image' && !a.broken && !!(a.preview || a.path);
function openAtt(a) {
  if (a.status === 'ready' && a.path && a.kind !== 'dir') openFile(a.path);
}

// 自动长高
// big：把输入框变高（右上角按钮切），适合写长提示词
const big = ref(localStorage.getItem('pi-web-composer-big') === '1');
function toggleBig() {
  big.value = !big.value;
  localStorage.setItem('pi-web-composer-big', big.value ? '1' : '0');
  nextTick(autosize);
}
function autosize() {
  const el = ta.value;
  if (!el) return;
  el.style.height = 'auto';
  const max = window.innerHeight * (big.value ? 0.72 : 0.4);
  el.style.height = Math.min(el.scrollHeight, max) + 'px';
  el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
}
watch(() => [S.composer.text, UI.fontSize, UI.lineHeight, big.value], () => nextTick(autosize));
watch(
  () => S.activeTab,
  (t) => t === 'chat' && nextTick(() => ta.value?.focus()),
);

// ---- 下方工具栏 ----
const model = computed(() => S.state?.model);
const dirName = computed(() => (S.cwd || '').split(/[\\/]/).filter(Boolean).pop() || S.cwd || '选择目录');
const modelLabel = computed(() => (model.value ? model.value.name || model.value.id : '选择模型'));
const thinking = computed(() => S.state?.thinkingLevel);
const ctx = computed(() => S.stats?.contextUsage);
const ctxPct = computed(() => (ctx.value?.percent != null ? Math.min(100, Math.max(0, ctx.value.percent)) : null));
const pctText = computed(() => (ctxPct.value != null ? Math.round(ctxPct.value) + '%' : '?'));
const busy = computed(() => S.running || !!S.bashLive);
// 输入框上面那一行小字：花费、缓存命中、token
const usage = computed(() => {
  const s = S.stats;
  if (!s?.tokens) return null;
  const t = s.tokens;
  const inAll = (t.input || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0);
  return {
    cost: s.cost != null ? `$${s.cost.toFixed(s.cost < 1 ? 4 : 2)}` : '',
    hit: inAll && t.cacheRead ? Math.round((t.cacheRead / inAll) * 100) : null,
    inTok: fmtTokens(inAll),
    cacheTok: fmtTokens(t.cacheRead || 0),
    outTok: fmtTokens(t.output || 0),
  };
});
// 输入框上面那一整条状态：一个胶囊里从头排到尾
// 输入 → 输出 → 缓存读 → 缓存率 → 花费 → 上下文百分比 → 上下文比例
const statusItems = computed(() => {
  const out = [];
  const u = usage.value;
  if (u) {
    out.push({ label: '输入', text: u.inTok, title: '累计输入 tokens' });
    out.push({ label: '输出', text: u.outTok, title: '累计输出 tokens' });
    out.push({ label: '缓存读', text: u.cacheTok, title: '输入里来自缓存的那部分 tokens' });
    if (u.hit != null) out.push({ label: '缓存率', text: `${u.hit}%`, title: '缓存命中率（缓存读 / 全部输入）' });
    if (u.cost) out.push({ label: '花费', text: u.cost, title: '本会话花费，点击看详情', run: showSessionInfo });
  }
  if (ctx.value) {
    out.push({ label: '上下文', text: pctText.value, title: `当前上下文占用 ${pctText.value}，点击压缩`, run: compact });
    out.push({ text: `${fmtTokens(ctx.value.tokens)} / ${fmtTokens(ctx.value.contextWindow)}`, title: '当前上下文 tokens / 窗口大小' });
  }
  if (otherAgents.value) out.push({ label: '后台', text: `${otherAgents.value} 个在跑`, title: '其他会话还有几个 pi 进程在跑' });
  for (const [k, v] of Object.entries(S.statusItems)) out.push({ text: v, title: `${k}: ${v}` });
  return out;
});
/** 状态栏里的一小段被点了：自己有动作（花费 / 上下文）就干自己的事，并拦住冒泡；
 *  没动作的（输入、输出…）就放它冒上去，让整条框去打开会话详情 */
function onItemClick(it, e) {
  if (!it.run) return;
  e.stopPropagation();
  it.run();
}

// 模型 / 思考强度那两个弹窗贴着各自 chip：右边对齐按钮的右边缘，底边就在按钮上方 6px。
// 注意不能用 CSS 的 bottom:100% —— 那是相对整块输入区（含上面的用量条）算的，框会跑到输入框顶上。
// 窄屏上横向可能会顶出左边界，就夹一下
const composerEl = ref(null);
const boxEl = ref(null);
const modelChip = ref(null);
const thinkChip = ref(null);
const popPos = ref({ right: 0, bottom: 0 });
const POP_W = { model: 400, thinking: 220 }; // 和各自 CSS 里的 width 对齐
const POP_GAP = 6; // 弹窗底边到 chip 上边的距离
function alignPop() {
  const name = menu.value;
  const chip = name === 'model' ? modelChip.value : name === 'thinking' ? thinkChip.value : null;
  const box = boxEl.value?.getBoundingClientRect();
  const root = composerEl.value?.getBoundingClientRect();
  if (!chip || !box || !root) return;
  const r = chip.getBoundingClientRect();
  const w = Math.min(POP_W[name], box.width);
  popPos.value = {
    right: Math.max(0, Math.min(root.right - r.right, box.width - w)),
    bottom: Math.max(0, root.bottom - r.top + POP_GAP),
  };
}
function toggleMenu(name) {
  menu.value = menu.value === name ? null : name;
}
async function chooseThinking(l) {
  menu.value = null;
  await setThinking(l);
  ta.value?.focus();
}
/** 右键某一档思考强度：切到这一档 / 设为新会话的默认（写 pi 的 settings.json） */
function thinkMenu(e, l) {
  openMenu(e.clientX, e.clientY, [
    { label: '切换到这一档', disabled: l === thinking.value, run: () => chooseThinking(l) },
    '-',
    { label: '设为新会话的默认思考强度', run: () => setDefaultThinking(l) },
  ]);
}
function closeMenus(e) {
  if (menu.value && !e.target.closest('.composer .pop, .composer .chip')) menu.value = null;
}
onMounted(() => window.addEventListener('mousedown', closeMenus));
onUnmounted(() => window.removeEventListener('mousedown', closeMenus));
// 窗口大小变了（或者菜单是从 Ctrl+L 直接打开的，没经过 chip 的点击）：重新量一次位置
const onResize = () => menu.value && alignPop();
onMounted(() => window.addEventListener('resize', onResize));
onUnmounted(() => window.removeEventListener('resize', onResize));
watch(menu, (v) => (v ? nextTick(alignPop) : nextTick(() => ta.value?.focus())));

// 还没起进程（S.lazy）也能打字：一打字就在后台把 pi 起起来
const disabled = computed(() => !(S.agentId || S.lazy) || !!S.agentExited || viewer.value);
function onInput() {
  syncCaret();
  if (S.composer.text) warmUp();
}

async function onTakeOver() {
  await takeOver();
  nextTick(() => ta.value?.focus());
}
</script>

<template>
  <div ref="composerEl" class="composer" @dragover="onDragOver" @dragleave.self="dragging = false" @drop="onDrop">
    <!-- @ 引用文件 -->
    <div v-if="atItems.length" ref="atEl" class="pop slash">
      <div class="pop-title">选中的文件会加到附件里 · Enter 选中 · Tab 进入目录 · Esc 关闭</div>
      <div
        v-for="(e, i) in atItems"
        :key="e.rel + e.dir"
        class="sl"
        :class="{ active: i === atSel }"
        :title="e.rel"
        @mouseenter="atSel = i"
        @mousedown.prevent="pickAt(e)"
      >
        <Icon :name="e.dir ? 'folder' : 'file'" :size="14" class="at-ic" />
        <span class="at-name">{{ nameOf(e.rel) }}{{ e.dir ? '/' : '' }}</span>
        <span class="ellipsis grow desc">{{ dirOf(e.rel) }}</span>
      </div>
    </div>

    <!-- 斜杠命令 -->
    <div v-if="items.length" ref="slashEl" class="pop slash">
      <div
        v-for="(c, i) in items"
        :key="c.source + c.name"
        class="sl"
        :class="{ active: i === sel }"
        @mouseenter="sel = i"
        @mousedown.prevent="pick(c, true)"
      >
        <span class="cmd">/{{ c.name }}</span>
        <span v-if="c.args" class="args">{{ c.args }}</span>
        <span class="ellipsis grow desc">{{ c.desc }}</span>
        <span v-if="SRC[c.source]" class="src">{{ SRC[c.source] }}</span>
      </div>
    </div>

    <ModelMenu v-if="menu === 'model'" :pos="popPos" @close="menu = null" />
    <div v-if="menu === 'thinking'" class="pop think-pop" :style="{ right: popPos.right + 'px', bottom: popPos.bottom + 'px' }">
      <div class="pop-title">思考强度 · 右键可设为默认</div>
      <div v-for="l in S.thinkingLevels" :key="l" class="lv" :class="{ cur: l === thinking }" @click="chooseThinking(l)" @contextmenu.prevent.stop="thinkMenu($event, l)">
        <span class="check">{{ l === thinking ? '✓' : '' }}</span>
        <span class="grow">{{ levelName(l) }}</span>
        <span class="dim small">{{ l }}</span>
      </div>
    </div>

    <!-- 花费/token/上下文：放在输入框外面、上面一行（悬浮在对话上面的那块区域里），默认收起；
         点顶部栏的状态按钮或右键菜单展开。里面是一整条，不再拆成一个个胶囊；
         点这一整条就看会话详情（花费、上下文那几小段自己还有点小动作，所以用 .stop 拦住冒泡） -->
    <div v-if="UI.showUsage && hasStatus" class="usage">
      <div class="u click" @click="showSessionInfo()">
        <template v-for="(it, i) in statusItems" :key="i">
          <span v-if="i" class="sep" />
          <span class="it" :class="{ click: !!it.run }" :title="it.title" @click="onItemClick(it, $event)">
            <i v-if="it.label">{{ it.label }}</i>{{ it.text }}
          </span>
        </template>
      </div>
    </div>

    <div v-if="viewer" class="viewer">
      <span class="vdot" />
      <span class="grow">另一个窗口正在使用这个会话，这里会同步显示，但不能发消息</span>
      <button class="btn sm primary" title="把操作权拿到这个窗口，另一个窗口变成只能看" @click="onTakeOver">接管</button>
    </div>

    <div ref="boxEl" class="box" :class="{ focused, dragging, disabled, big }">
      <button class="expand" :class="{ on: big }" :title="big ? '还原输入框高度' : '放大输入框（写长消息用）'" @click="toggleBig">
        <Icon :name="big ? 'collapse' : 'expand'" :size="14" />
      </button>
      <!-- 附件：顺序就是发送时的编号（在悬停浮层里看），可以拖动调整 -->
      <div v-if="atts.length" class="atts">
        <div
          v-for="(a, i) in atts"
          :key="a.id"
          class="att"
          :class="{ up: a.status === 'uploading', moving: dragAtt === i, link: a.kind !== 'dir', img: isImage(a) }"
          draggable="true"
          @mouseenter="showTip($event, a, i)"
          @mouseleave="hideTip()"
          @dragstart="chipDragStart($event, i), hideTip()"
          @dragover="chipDragOver($event, i)"
          @drop.prevent.stop
          @dragend="dragAtt = -1"
          @click="openAtt(a)"
        >
          <img v-if="isImage(a)" class="pic" :src="a.preview || rawUrl(a.path)" draggable="false" alt="" @error="a.broken = true" />
          <span v-if="!isImage(a)" class="atxt">
            <span class="ameta ellipsis">{{ cardMeta(a) }}</span>
            <span class="aline">
              <Icon :name="a.kind === 'dir' ? 'folder' : 'file'" :size="12" />
              <span class="aname ellipsis">{{ a.name }}</span>
            </span>
          </span>
          <span v-if="a.status === 'uploading'" class="prog"><i :style="{ width: Math.round(a.progress * 100) + '%' }" /></span>
          <button class="x" title="移除" @click.stop="removeAttachment(a), hideTip()"><Icon name="close" :size="11" /></button>
        </div>
        <button v-if="atts.length > 1" class="att-clear" title="移除全部附件" @click="clearAttachments">清空</button>
      </div>

      <!-- 悬停浮层：编号、全名、完整路径、来源和大小都在这（图片附件平时只有缩略图） -->
      <AttTooltip :tip="tip" />
      <textarea
        ref="ta"
        v-model="S.composer.text"
        class="ta"
        rows="1"
        :disabled="disabled"
        autofocus
        @keydown="onKey"
        @keyup="syncCaret"
        @click="syncCaret"
        @input="onInput"
        @paste="onPaste"
        @focus="focused = true"
        @blur="focused = false"
      />
      <div class="bar">
        <button class="ibtn" title="添加图片或文件（也可以直接粘贴、拖进来，或输入 @ 引用项目里的文件）" :disabled="disabled" @click="fileInput.click()">
          <!-- 加号用实心路径而不是描边：横竖两笔刚好落在整像素上（2px 宽、端点是整数），不会出现发虚、边缘歪掉 -->
          <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true"><path d="M8 3h2v5h5v2h-5v5H8v-5H3V8h5z" /></svg>
        </button>
        <input ref="fileInput" type="file" multiple hidden @change="onPickFiles" />

        <!-- 工作目录 / 模型 / 思考强度靠右，和发送按钮排在一起 -->
        <div class="grow" />
        <span v-if="S.starting" class="dim small starting" title="这个会话之前没有 pi 进程，正在启动">启动 pi…</span>

        <button class="chip dir" :title="`工作目录：${S.cwd}\n点击切换`" @click="openDirPicker('switch')">
          <span class="ellipsis">{{ dirName }}</span>
        </button>

        <button ref="modelChip" class="chip" :class="{ on: menu === 'model' }" title="切换模型 (Ctrl+L)" :disabled="disabled" @click="toggleMenu('model')">
          <span class="ellipsis">{{ modelLabel }}</span>
          <Icon name="caret" :size="14" class="caret" />
        </button>
        <button v-if="S.thinkingLevels.length > 1" ref="thinkChip" class="chip" :class="{ on: menu === 'thinking' }" title="思考强度" :disabled="disabled" @click="toggleMenu('thinking')">
          <span>{{ levelName(thinking) }}</span>
          <Icon name="caret" :size="14" class="caret" />
        </button>

        <template v-if="busy">
          <button v-if="hasInput" class="btn sm" title="Alt+Enter：等全部做完再发" @click="send(true)">排队</button>
          <button v-if="hasInput" class="btn sm primary" title="当前这步做完后插进去" @click="send(false)">插话</button>
          <button v-if="!viewer" class="round stop" title="停止 (Esc)" @click="stop">
            <svg width="12" height="12" viewBox="0 0 12 12"><rect width="12" height="12" rx="2.5" fill="currentColor" /></svg>
          </button>
        </template>
        <button v-else class="round send" :disabled="disabled || !hasInput" title="发送" @click="send(false)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer { position: relative; flex: none; pointer-events: none; }
/* 输入框整个悬在对话上面，只有卡片本身（和弹出的菜单）接鼠标事件，中间空白处让滚轮穿透给下面的对话 */
.box, .usage, .pop { pointer-events: auto; }
.box { position: relative; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-xl); box-shadow: var(--shadow); padding: var(--sp2) var(--sp3); transition: border-color 0.15s, box-shadow 0.15s; }
/* 放大按钮：垂直居中对准输入框第一行文字（.ta 的 6px 上内边距 + 半行高）；
   右边距也跟上下一致（= 卡片内边距 12），四个方向的留白看着一样 */
.expand { position: absolute; top: calc(var(--sp2) + 6px + (var(--lh) * 1em - 26px) / 2); right: var(--sp3); width: 26px; height: 26px; border: 1px solid var(--line); background: var(--panel-2); border-radius: var(--r-sm); color: var(--text-3); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; z-index: 2; opacity: 0; box-shadow: var(--shadow-sm); transition: opacity 0.15s, color 0.15s, background 0.15s, border-color 0.15s; }
.box:hover .expand, .box.focused .expand, .expand.on { opacity: 1; }
.expand:hover { color: var(--text); border-color: var(--text-3); }
.expand.on { color: var(--accent-text); background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 35%, var(--line)); }
.box.focused { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); box-shadow: var(--shadow), 0 0 0 4px var(--accent-softer); }
.box.dragging { border-style: dashed; border-color: var(--accent); background: var(--accent-softer); }
.box.disabled { opacity: 0.6; }
.viewer { pointer-events: auto; display: flex; align-items: center; gap: 8px; margin-bottom: var(--sp2); padding: 6px 6px 6px 12px; border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--line)); background: color-mix(in srgb, var(--warn) 10%, var(--panel)); border-radius: var(--r-md); font-size: var(--fs-sm); color: var(--text-2); box-shadow: var(--shadow-sm); }
.vdot { width: 8px; height: 8px; border-radius: 50%; background: var(--warn); flex: none; }
/* 上下留白都按同一个数来：卡片 8px + 输入框 6px，再加上行高自带的半行空隙，文字上下一样宽。
   min-height 也只留一行的量（内容 + 上下 padding），不然单行时下面会多出一截空的，看着上紧下松。
   下边再留 8px：让输入框跟下面那排按钮（+ / 模型 / 发送）拉开一点，不贴着 */
.ta { display: block; width: 100%; resize: none; border: 0; background: transparent; outline: none; padding: 6px 34px 6px 2px; margin-bottom: 8px; line-height: var(--lh); min-height: calc(var(--lh) * 1em + 12px); max-height: 40vh; overflow-y: hidden; }
.box.big .ta { min-height: 32vh; max-height: 72vh; }

.bar { display: flex; align-items: center; gap: 6px; min-width: 0; }
.bar > * { flex-shrink: 0; }
.bar > .chip { flex-shrink: 1; min-width: 0; }
/* 和右边那几个 chip 一个观感：浅底 + 细边，悬停换成主题色 */
.ibtn { width: 30px; height: 30px; border: 1px solid var(--line); background: var(--panel-2); border-radius: var(--r-pill); color: var(--text-2); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; transition: border-color 0.15s, color 0.15s, background 0.15s; }
.ibtn:hover { border-color: var(--accent); color: var(--accent-text); background: var(--accent-softer); }
.chip { height: 30px; max-width: 260px; display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; border: 1px solid var(--line); background: var(--panel-2); border-radius: var(--r-pill); color: var(--text-2); cursor: pointer; font-size: var(--fs-sm); transition: all 0.15s; }
.chip.dir { max-width: 220px; }
.chip:hover, .chip.on { border-color: var(--accent); color: var(--accent-text); background: var(--accent-softer); }
.chip:disabled { opacity: 0.5; pointer-events: none; }
/* 下拉箭头：用线画的小折线，比 ▾ 这种字体符号更匀称，跟着 chip 颜色走 */
.chip .caret { flex: none; color: var(--text-3); margin-right: -2px; transition: color 0.15s; }
.chip:hover .caret, .chip.on .caret { color: var(--accent-text); }
.usage { display: flex; align-items: center; justify-content: flex-end; gap: var(--sp2); padding: 0 0 var(--sp2); font-size: 11.5px; line-height: 16px; color: var(--text-2); white-space: nowrap; overflow: hidden; font-variant-numeric: tabular-nums; }
/* 一整条状态：一个胶囊装下所有项，项之间用细竖线隔开；对话从下面淡过时它还是一块看得清的 UI，
   不会跟背景文字混在一起 */
.u { display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 var(--pad-x); border-radius: var(--r-pill); background: var(--panel); border: 1px solid var(--line); box-shadow: var(--shadow-sm); flex: 0 1 auto; min-width: 0; overflow: hidden; }
.u .it { display: inline-flex; align-items: center; gap: 4px; flex: none; white-space: nowrap; }
.u i { font-style: normal; color: var(--text-3); }
.u .sep { flex: none; width: 1px; height: 11px; background: var(--line); }
.u .it.click { cursor: pointer; }
.u .it.click:hover { color: var(--text); }
/* 整条都能点（打开会话详情）：悬停时把边框提一提，告诉用户这块是能点的 */
.u.click { cursor: pointer; }
.u.click:hover { border-color: var(--text-3); }
/* “排队 / 插话”：高度和圆角都跟两边的 chip、圆按钮一样（30 + 胶囊） */
.bar .btn { height: 30px; padding: 0 12px; border-radius: var(--r-pill); }
/* 发送 / 停止：跟旁边的 chip 一样高（都是一排 30px），圆形 */
.round { width: 30px; height: 30px; border-radius: 50%; border: 0; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex: none; transition: background 0.15s, transform 0.1s; }
.round:active { transform: scale(0.94); }
.send { background: var(--accent); color: #fff; }
.send:hover { background: var(--accent-hover); }
.send:disabled { background: var(--line); color: var(--text-3); cursor: default; transform: none; }
.stop { background: var(--text); color: var(--panel); }
.stop:hover { background: var(--err); color: #fff; }

.atts { display: flex; gap: 8px; padding: 8px 36px 8px 0; flex-wrap: wrap; align-items: flex-start; }
/* 附件：全是 72 高的方形磁贴 —— 图片是一张缩略图，文件/文件夹是“图标 + 名字 + 一行小字”，
   高度一样排得整齐，顺序也跟发送编号对得上。overflow 不能藏（右上角的叉号半悬在角上） */
.att { position: relative; display: inline-flex; align-items: center; gap: 8px; height: 72px; max-width: 260px; padding: 0; border: 1px solid var(--line); background: var(--panel-2); border-radius: var(--r-md); color: var(--text-2); cursor: grab; user-select: none; overflow: visible; transition: border-color 0.15s, background 0.15s; }
.att:hover { border-color: var(--text-3); color: var(--text); }
.att.moving { opacity: 0.45; border-style: dashed; border-color: var(--accent); }
.att.up { color: var(--text-3); }
.att .pic { flex: none; width: 36px; height: 36px; object-fit: cover; border-radius: var(--r-xs); border: 1px solid var(--line-2); display: block; background: var(--hover); }
/* 文件/文件夹：中间那块放类型 + 大小（水平垂直都居中，占图片的那种“预览”位置）；
   底部一条加深的横条，里面是图标 + 文件名，像缩略图底下的说明条 */
.att .atxt { display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; }
.att .ameta { flex: 1; display: flex; align-items: center; justify-content: center; min-width: 0; padding: 0 10px; font-size: var(--fs-sm); line-height: 1.25; color: var(--text-2); font-variant-numeric: tabular-nums; }
.att .aline { flex: none; display: flex; align-items: center; gap: 5px; min-width: 0; padding: 4px 10px 5px; border-radius: 0 0 calc(var(--r-md) - 1px) calc(var(--r-md) - 1px); background: var(--accent-soft); font-size: 11px; line-height: 1.3; color: var(--text-2); }
.att .aname { min-width: 0; }
/* 图片附件：只露一张缩略图，文件名、序号都等悬停浮层再说 */
.att.img { width: 72px; height: 72px; padding: 0; gap: 0; background: transparent; border-color: transparent; overflow: visible; }
.att.img:hover { border-color: var(--line-2); }
.att.img .pic { width: 100%; height: 100%; border-radius: inherit; border: 1px solid var(--line-2); }
.att.img.up .pic { opacity: 0.45; }
/* 悬停浮层的样式在 AttTooltip.vue 里（消息里的附件也用它） */
.att .prog { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: var(--line-2); }
.att .prog i { display: block; height: 100%; background: var(--accent); transition: width 0.2s; }
/* 移除：圆形，圆心就落在右上角的角上（一半悬在外面）；中间的叉用图标画（字形的 ✕ 靠基线会歪，圆形里居中不了） */
.att .x { position: absolute; top: -9px; right: -9px; width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--line); background: var(--elev); color: var(--text-2); cursor: pointer; display: none; align-items: center; justify-content: center; padding: 0; box-shadow: var(--shadow-sm); z-index: 2; transition: background 0.12s, border-color 0.12s, color 0.12s; }
.att:hover .x, .att:focus-within .x { display: inline-flex; }
.att .x:hover { background: var(--err); border-color: var(--err); color: #fff; }
/* “清空”：跟缩略图一样是 72 方块，虚线框 */
.att-clear { width: 72px; height: 72px; padding: 0; border: 1px dashed var(--line); background: transparent; border-radius: var(--r-md); color: var(--text-3); font-size: var(--fs-xs); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.att-clear:hover { color: var(--err); border-color: var(--err); }
.at-ic { flex: none; color: var(--text-3); }
.at-name { flex: none; max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-code); color: var(--text); }

.slash { left: 0; right: 0; bottom: calc(100% + 8px); max-height: 320px; overflow-y: auto; }
.sl { display: flex; align-items: center; gap: 10px; padding: 0 10px; height: 36px; border-radius: var(--r-sm); cursor: pointer; }
.sl.active { background: var(--accent-soft); }
.cmd { color: var(--accent-text); flex: none; min-width: 12ch; font-family: var(--font-code); font-weight: 600; }
.args { color: var(--text-3); font-family: var(--font-code); font-size: var(--fs-sm); flex: none; }
.desc { color: var(--text-2); font-size: var(--fs-sm); }
.src { font-size: 11px; color: var(--text-3); border: 1px solid var(--line); border-radius: var(--r-xs); padding: 0 6px; line-height: 18px; flex: none; }

.think-pop { bottom: 0; right: 0; left: auto; width: 220px; }
.pop-title { font-size: var(--fs-xs); color: var(--text-3); padding: 4px 8px 6px; }
.lv { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px 0 6px; border-radius: var(--r-sm); cursor: pointer; }
.lv:hover { background: var(--hover); }
.lv.cur { color: var(--accent-text); font-weight: 600; }
.check { width: 16px; text-align: center; flex: none; }
.small { font-size: var(--fs-xs); font-weight: normal; }
@media (max-width: 768px) {
  .bar { gap: 4px; }
  .chip { max-width: none; min-width: 0; flex-shrink: 1; padding: 0 9px; }
  .chip.dir { max-width: 34vw; }
  .box { border-radius: var(--r-xl); padding: 10px 10px 6px; }
}
/* 触屏没有悬停，放大按钮、附件的删除按钮得一直看得到 */
@media (hover: none) {
  .expand { opacity: 1; }
  .att .x { display: inline-flex; }
}
</style>
