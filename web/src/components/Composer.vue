<script setup>
import { ref, toRef, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { S, submit, stop, allCommands, BUILTINS, toast, setThinking, compact, showSessionInfo, hasStatus, otherAgents, viewer, takeOver, openDirPicker, openFile, attachPaths, uploadFiles, pasteFiles, removeAttachment, clearAttachments, moveAttachment, ORIGIN_LABEL } from '../store.js';
import { UI, view } from '../settings.js';
import { http, rawUrl } from '../api.js';
import { fmtTokens, levelName, joinPath, fmtSize } from '../util.js';
import ModelMenu from './ModelMenu.vue';
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
function attTitle(a) {
  if (a.status === 'uploading') return `${a.name}\n正在上传 ${Math.round(a.progress * 100)}%`;
  const info = [ORIGIN_LABEL[a.origin] || '', a.size != null ? fmtSize(a.size) : ''].filter(Boolean).join(' · ');
  return `${a.path}\n${info}\n拖动调整顺序${a.kind === 'dir' ? '' : '，点击打开'}`;
}
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
const ctxColor = computed(() => (ctxPct.value == null ? 'var(--text-3)' : ctxPct.value > 85 ? 'var(--err)' : ctxPct.value > 65 ? 'var(--warn)' : 'var(--accent)'));
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
    outTok: fmtTokens(t.output || 0),
  };
});

function toggleMenu(name) {
  menu.value = menu.value === name ? null : name;
}
async function chooseThinking(l) {
  menu.value = null;
  await setThinking(l);
  ta.value?.focus();
}
function closeMenus(e) {
  if (menu.value && !e.target.closest('.composer .pop, .composer .chip')) menu.value = null;
}
onMounted(() => window.addEventListener('mousedown', closeMenus));
onUnmounted(() => window.removeEventListener('mousedown', closeMenus));
watch(menu, (v) => !v && nextTick(() => ta.value?.focus()));

const placeholder = computed(() => {
  if (S.detached) return '这个会话只读：先选个新目录才能继续聊';
  if (viewer.value) return '其他窗口正在使用这个会话，这里只能看';
  if (busy.value) return view.mobile ? '继续输入，发送 = 插话' : '继续输入：发送 = 插话，Alt+Enter = 等它做完再发';
  return view.mobile ? '给 pi 发消息…' : '/ 查看命令  ! 执行 shell  @ 引用文件';
});
const disabled = computed(() => !S.agentId || !!S.agentExited || viewer.value);

async function onTakeOver() {
  await takeOver();
  nextTick(() => ta.value?.focus());
}
</script>

<template>
  <div class="composer" @dragover="onDragOver" @dragleave.self="dragging = false" @drop="onDrop">
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

    <ModelMenu v-if="menu === 'model'" @close="menu = null" />
    <div v-if="menu === 'thinking'" class="pop think-pop">
      <div class="pop-title">思考强度</div>
      <div v-for="l in S.thinkingLevels" :key="l" class="lv" :class="{ cur: l === thinking }" @click="chooseThinking(l)">
        <span class="check">{{ l === thinking ? '✓' : '' }}</span>
        <span class="grow">{{ levelName(l) }}</span>
        <span class="dim small">{{ l }}</span>
      </div>
    </div>

    <!-- 花费/token/上下文：放在输入框外面、上面一行（悬浮在对话上面的那块区域里），默认收起；
         点顶部栏的状态按钮或右键菜单展开 -->
    <div v-if="UI.showUsage && hasStatus" class="usage">
      <template v-if="usage">
        <span v-if="usage.cost" class="u click" title="本会话花费，点击看详情" @click="showSessionInfo"><i>花费</i>{{ usage.cost }}</span>
        <span v-if="usage.hit != null" class="u" title="缓存命中率（缓存读 / 全部输入）"><i>缓存</i>{{ usage.hit }}%</span>
        <span class="u" title="累计输入 / 输出 tokens"><i>输入</i>{{ usage.inTok }}<i class="gap">输出</i>{{ usage.outTok }}</span>
      </template>
      <span v-if="ctx" class="u" title="当前上下文占用"><i>上下文</i>{{ fmtTokens(ctx.tokens) }} / {{ fmtTokens(ctx.contextWindow) }}</span>
      <span v-if="otherAgents" class="u"><i>后台</i>{{ otherAgents }} 个在跑</span>
      <span v-for="(v, k) in S.statusItems" :key="k" class="u ext" :title="`${k}: ${v}`">{{ v }}</span>
    </div>

    <div v-if="viewer" class="viewer">
      <span class="vdot" />
      <span class="grow">另一个窗口正在使用这个会话，这里会同步显示，但不能发消息</span>
      <button class="btn sm primary" title="把操作权拿到这个窗口，另一个窗口变成只能看" @click="onTakeOver">接管</button>
    </div>

    <div class="box" :class="{ focused, dragging, disabled, big }">
      <button class="expand" :class="{ on: big }" :title="big ? '还原输入框高度' : '放大输入框（写长消息用）'" @click="toggleBig">
        <Icon :name="big ? 'collapse' : 'expand'" :size="14" />
      </button>
      <!-- 附件：顺序就是发送时的编号，可以拖动调整；悬停看路径 -->
      <div v-if="atts.length" class="atts">
        <div
          v-for="(a, i) in atts"
          :key="a.id"
          class="att"
          :class="{ up: a.status === 'uploading', moving: dragAtt === i, link: a.kind !== 'dir' }"
          :title="attTitle(a)"
          draggable="true"
          @dragstart="chipDragStart($event, i)"
          @dragover="chipDragOver($event, i)"
          @drop.prevent.stop
          @dragend="dragAtt = -1"
          @click="openAtt(a)"
        >
          <span class="no">{{ i + 1 }}</span>
          <img v-if="a.kind === 'image' && !a.broken && (a.preview || a.path)" class="pic" :src="a.preview || rawUrl(a.path)" draggable="false" alt="" @error="a.broken = true" />
          <span v-else class="fic"><Icon :name="a.kind === 'dir' ? 'folder' : 'file'" :size="15" /></span>
          <span class="aname ellipsis">{{ a.name }}</span>
          <span v-if="a.status === 'uploading'" class="prog"><i :style="{ width: Math.round(a.progress * 100) + '%' }" /></span>
          <button class="x" title="移除" @click.stop="removeAttachment(a)">✕</button>
        </div>
        <button v-if="atts.length > 1" class="att-clear" title="移除全部附件" @click="clearAttachments">清空</button>
      </div>
      <textarea
        ref="ta"
        v-model="S.composer.text"
        class="ta"
        rows="1"
        :placeholder="placeholder"
        :disabled="disabled"
        autofocus
        @keydown="onKey"
        @keyup="syncCaret"
        @click="syncCaret"
        @input="syncCaret"
        @paste="onPaste"
        @focus="focused = true"
        @blur="focused = false"
      />
      <div class="bar">
        <button class="ibtn" title="添加图片或文件（也可以直接粘贴、拖进来，或输入 @ 引用项目里的文件）" :disabled="disabled" @click="fileInput.click()">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.4 11.6l-8.8 8.8a5.5 5.5 0 0 1-7.8-7.8l8.8-8.8a3.7 3.7 0 0 1 5.2 5.2l-8.8 8.8a1.8 1.8 0 0 1-2.6-2.6l8.1-8.1" /></svg>
        </button>
        <input ref="fileInput" type="file" multiple hidden @change="onPickFiles" />

        <button class="chip dir" :title="`工作目录：${S.cwd}\n点击切换`" @click="openDirPicker('switch')">
          <Icon name="folder" :size="14" />
          <span class="ellipsis">{{ dirName }}</span>
        </button>

        <button class="chip" :class="{ on: menu === 'model' }" title="切换模型 (Ctrl+L)" :disabled="disabled" @click="toggleMenu('model')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" /></svg>
          <span class="ellipsis">{{ modelLabel }}</span>
          <span class="caret">▾</span>
        </button>
        <button v-if="S.thinkingLevels.length > 1" class="chip" :class="{ on: menu === 'thinking' }" title="思考强度" :disabled="disabled" @click="toggleMenu('thinking')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" /></svg>
          <span>{{ levelName(thinking) }}</span>
          <span class="caret">▾</span>
        </button>
        <div class="grow" />

        <button
          v-if="ctx"
          class="ring"
          :title="`上下文 ${ctxPct != null ? Math.round(ctxPct) + '%' : '?'}（${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.contextWindow)}），点击压缩`"
          @click="compact()"
        >
          <svg width="22" height="22" viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="14" fill="none" stroke="var(--line)" stroke-width="4" />
            <circle cx="18" cy="18" r="14" fill="none" :stroke="ctxColor" stroke-width="4" stroke-linecap="round" pathLength="100" :stroke-dasharray="`${ctxPct ?? 0} 100`" transform="rotate(-90 18 18)" />
          </svg>
          <span>{{ ctxPct != null ? Math.round(ctxPct) + '%' : '?' }}</span>
        </button>

        <template v-if="busy">
          <button v-if="hasInput" class="btn sm" title="Alt+Enter：等全部做完再发" @click="send(true)">排队</button>
          <button v-if="hasInput" class="btn sm primary" title="当前这步做完后插进去" @click="send(false)">插话</button>
          <button v-if="!viewer" class="round stop" title="停止 (Esc)" @click="stop">
            <svg width="12" height="12" viewBox="0 0 12 12"><rect width="12" height="12" rx="2.5" fill="currentColor" /></svg>
          </button>
        </template>
        <button v-else class="round send" :disabled="disabled || !hasInput" title="发送" @click="send(false)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer { position: relative; flex: none; pointer-events: none; }
/* 输入框整个悬在对话上面，只有卡片本身（和弹出的菜单）接鼠标事件，中间空白处让滚轮穿透给下面的对话 */
.box, .usage, .pop { pointer-events: auto; }
.box { position: relative; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-xl); box-shadow: var(--shadow); padding: var(--sp3) var(--sp3) calc(var(--sp2) + 2px); transition: border-color 0.15s, box-shadow 0.15s; }
.expand { position: absolute; top: 10px; right: 10px; width: 26px; height: 26px; border: 1px solid var(--line); background: var(--panel-2); border-radius: var(--r-sm); color: var(--text-3); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; z-index: 2; opacity: 0; box-shadow: var(--shadow-sm); transition: opacity 0.15s, color 0.15s, background 0.15s, border-color 0.15s; }
.box:hover .expand, .box.focused .expand, .expand.on { opacity: 1; }
.expand:hover { color: var(--text); border-color: var(--text-3); }
.expand.on { color: var(--accent-text); background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 35%, var(--line)); }
.box.focused { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); box-shadow: var(--shadow), 0 0 0 4px var(--accent-softer); }
.box.dragging { border-style: dashed; border-color: var(--accent); background: var(--accent-softer); }
.box.disabled { opacity: 0.6; }
.viewer { pointer-events: auto; display: flex; align-items: center; gap: 8px; margin-bottom: var(--sp2); padding: 6px 6px 6px 12px; border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--line)); background: color-mix(in srgb, var(--warn) 10%, var(--panel)); border-radius: var(--r-md); font-size: var(--fs-sm); color: var(--text-2); box-shadow: var(--shadow-sm); }
.vdot { width: 8px; height: 8px; border-radius: 50%; background: var(--warn); flex: none; }
.ta { display: block; width: 100%; resize: none; border: 0; background: transparent; outline: none; padding: 2px 34px 4px 2px; line-height: var(--lh); min-height: calc(var(--lh) * 1em + 10px); max-height: 40vh; overflow-y: hidden; }
.ta::placeholder { color: var(--text-3); }
.box.big .ta { min-height: 32vh; max-height: 72vh; }

.bar { display: flex; align-items: center; gap: 6px; margin-left: -6px; min-width: 0; }
.bar > * { flex-shrink: 0; }
.bar > .chip { flex-shrink: 1; min-width: 0; }
.ibtn { width: 32px; height: 32px; border: 0; background: transparent; border-radius: var(--r-sm); color: var(--text-2); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.ibtn:hover { background: var(--hover); color: var(--text); }
.chip { height: 30px; max-width: 260px; display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; border: 1px solid var(--line); background: var(--panel-2); border-radius: var(--r-pill); color: var(--text-2); cursor: pointer; font-size: var(--fs-sm); transition: all 0.15s; }
.chip svg { flex: none; }
.chip.dir { max-width: 220px; }
.chip:hover, .chip.on { border-color: var(--accent); color: var(--accent-text); background: var(--accent-softer); }
.chip:disabled { opacity: 0.5; pointer-events: none; }
.caret { font-size: 10px; opacity: 0.6; }
.usage { display: flex; align-items: center; gap: var(--sp2); padding: 0 0 var(--sp2); font-size: 11.5px; line-height: 16px; color: var(--text-2); white-space: nowrap; overflow: hidden; font-variant-numeric: tabular-nums; }
/* 每一项都是个小胶囊：对话从下面淡过时，它还是一块看得清的 UI，不会跟背景文字混在一起 */
.u { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 var(--pad-x); border-radius: var(--r-pill); background: var(--panel); border: 1px solid var(--line); box-shadow: var(--shadow-sm); flex: none; }
.u i { font-style: normal; color: var(--text-3); }
.u i.gap { margin-left: 4px; }
.u.click { cursor: pointer; }
.u.click:hover { background: var(--hover); color: var(--text); }
.u.ext { flex: 0 1 auto; min-width: 0; max-width: 240px; overflow: hidden; text-overflow: ellipsis; display: inline-block; line-height: 24px; color: var(--text-3); }
.ring { display: inline-flex; align-items: center; gap: 4px; border: 0; background: transparent; color: var(--text-3); cursor: pointer; font-size: var(--fs-xs); padding: 0 6px; height: 30px; border-radius: var(--r-sm); font-variant-numeric: tabular-nums; }
.ring:hover { background: var(--hover); color: var(--text-2); }
.round { width: 34px; height: 34px; border-radius: 50%; border: 0; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex: none; transition: background 0.15s, transform 0.1s; }
.round:active { transform: scale(0.94); }
.send { background: var(--accent); color: #fff; }
.send:hover { background: var(--accent-hover); }
.send:disabled { background: var(--line); color: var(--text-3); cursor: default; transform: none; }
.stop { background: var(--text); color: var(--panel); }
.stop:hover { background: var(--err); color: #fff; }

.atts { display: flex; gap: 6px; padding: 2px 34px 8px 0; flex-wrap: wrap; }
.att { position: relative; display: inline-flex; align-items: center; gap: 6px; height: 36px; max-width: 220px; padding: 0 10px 0 4px; border: 1px solid var(--line); background: var(--panel-2); border-radius: var(--r-md); font-size: var(--fs-sm); color: var(--text-2); cursor: grab; user-select: none; overflow: hidden; transition: border-color 0.15s, background 0.15s; }
.att:hover { border-color: var(--text-3); color: var(--text); }
.att.moving { opacity: 0.45; border-style: dashed; border-color: var(--accent); }
.att.up { color: var(--text-3); }
.att .no { flex: none; min-width: 18px; height: 18px; padding: 0 4px; border-radius: var(--r-pill); background: var(--accent-soft); color: var(--accent-text); font-size: 11px; font-weight: 600; line-height: 18px; text-align: center; font-variant-numeric: tabular-nums; }
.att .pic { flex: none; width: 28px; height: 28px; object-fit: cover; border-radius: var(--r-xs); border: 1px solid var(--line-2); display: block; background: var(--hover); }
.att .fic { flex: none; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-3); border-radius: var(--r-xs); background: var(--hover); }
.att .aname { min-width: 0; }
.att .prog { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: var(--line-2); }
.att .prog i { display: block; height: 100%; background: var(--accent); transition: width 0.2s; }
.att .x { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; border-radius: 50%; border: 0; background: var(--text); color: var(--panel); font-size: 9px; cursor: pointer; display: none; align-items: center; justify-content: center; padding: 0; }
.att:hover .x { display: inline-flex; }
.att-clear { height: 36px; padding: 0 10px; border: 1px dashed var(--line); background: transparent; border-radius: var(--r-md); color: var(--text-3); font-size: var(--fs-xs); cursor: pointer; }
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

.think-pop { bottom: calc(100% + 8px); left: 200px; width: 220px; }
.pop-title { font-size: var(--fs-xs); color: var(--text-3); padding: 4px 8px 6px; }
.lv { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px 0 6px; border-radius: var(--r-sm); cursor: pointer; }
.lv:hover { background: var(--hover); }
.lv.cur { color: var(--accent-text); font-weight: 600; }
.check { width: 16px; text-align: center; flex: none; }
.small { font-size: var(--fs-xs); font-weight: normal; }
@media (max-width: 768px) {
  .think-pop { left: auto; right: 0; }
  .bar { gap: 4px; }
  .chip { max-width: none; min-width: 0; flex-shrink: 1; padding: 0 9px; }
  .chip.dir { max-width: 34vw; }
  .ring span { display: none; }
  .ring { padding: 0 4px; }
  .box { border-radius: var(--r-xl); padding: 10px 10px 6px; }
}
/* 触屏没有悬停，放大按钮、附件的删除按钮得一直看得到 */
@media (hover: none) {
  .expand { opacity: 1; }
  .att .x { display: inline-flex; }
}
</style>
