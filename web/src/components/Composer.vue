<script setup>
import { ref, toRef, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { S, submit, stop, allCommands, BUILTINS, toast, setThinking, compact, showSessionInfo } from '../store.js';
import { UI, view } from '../settings.js';
import { fmtTokens, levelName } from '../util.js';
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
const hasInput = computed(() => !!S.composer.text.trim() || S.composer.images.length > 0);
async function send(followUp = false) {
  const text = S.composer.text;
  if (!text.trim() && !S.composer.images.length) return;
  S.composer.text = ''; // 先清空，失败再放回去，感觉更跟手
  const imgs = S.composer.images;
  const ok = await submit(text, { followUp });
  if (ok) {
    S.composer.images = [];
    if (text.trim() && history[0] !== text) {
      history.unshift(text);
      history.length = Math.min(history.length, 100);
      localStorage.setItem('pi-web-history', JSON.stringify(history));
    }
  } else {
    if (!S.composer.text) S.composer.text = text;
    S.composer.images = imgs;
  }
  histIdx = -1;
  nextTick(() => ta.value?.focus());
}

function onKey(e) {
  if (e.isComposing || e.keyCode === 229) return;
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

// ---- 图片：粘贴 / 拖进来 / 点按钮选 ----
function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    if (f.size > 20 * 1024 * 1024) {
      toast('图片太大了（>20MB）', 'warning');
      continue;
    }
    const r = new FileReader();
    r.onload = () => {
      const [head, data] = String(r.result).split(',');
      S.composer.images.push({ type: 'image', data, mimeType: head.slice(5, head.indexOf(';')), url: r.result });
    };
    r.readAsDataURL(f);
  }
}
function onPaste(e) {
  const files = [...(e.clipboardData?.files || [])];
  if (files.some((f) => f.type.startsWith('image/'))) {
    e.preventDefault();
    addFiles(files);
  }
}
const dragging = ref(false);
function onDrop(e) {
  dragging.value = false;
  addFiles([...(e.dataTransfer?.files || [])]);
}
function onPickFiles(e) {
  addFiles([...(e.target.files || [])]);
  e.target.value = '';
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
// 输入框下面那一行小字：花费、缓存命中、token
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
const others = computed(() => S.agents.filter((a) => a.running && a.id !== S.agentId).length);

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

const sendHint = computed(() => (UI.sendKey === 'ctrlEnter' ? 'Ctrl+Enter 发送 · Enter 换行' : 'Enter 发送 · Shift+Enter 换行'));
const placeholder = computed(() => {
  if (S.detached) return '这个会话只读：先选个新目录才能继续聊';
  if (busy.value) return view.mobile ? '继续输入，发送 = 插话' : '继续输入：发送 = 插话，Alt+Enter = 等它做完再发';
  return view.mobile ? '给 pi 发消息…' : '给 pi 发消息…  输入 / 查看命令，! 执行 shell';
});
const disabled = computed(() => !S.agentId || !!S.agentExited);
</script>

<template>
  <div class="composer" @dragover.prevent="dragging = true" @dragleave.self="dragging = false" @drop.prevent="onDrop">
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

    <div class="box" :class="{ focused, dragging, disabled, big }">
      <button class="expand" :class="{ on: big }" :title="big ? '还原输入框高度' : '放大输入框（写长消息用）'" @click="toggleBig">
        <Icon :name="big ? 'collapse' : 'expand'" :size="14" />
      </button>
      <div v-if="S.composer.images.length" class="thumbs">
        <div v-for="(im, i) in S.composer.images" :key="i" class="thumb">
          <img :src="im.url || `data:${im.mimeType};base64,${im.data}`" />
          <button class="x" title="移除" @click="S.composer.images.splice(i, 1)">✕</button>
        </div>
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
        @paste="onPaste"
        @focus="focused = true"
        @blur="focused = false"
      />
      <div class="bar">
        <button class="ibtn" title="添加图片（也可以直接粘贴或拖进来）" :disabled="disabled" @click="fileInput.click()">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-9 9" /></svg>
        </button>
        <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="onPickFiles" />

        <button class="chip dir" :title="`工作目录：${S.cwd}\n点击切换`" @click="S.dirPicker = true">
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
          <button class="round stop" title="停止 (Esc)" @click="stop">
            <svg width="12" height="12" viewBox="0 0 12 12"><rect width="12" height="12" rx="2.5" fill="currentColor" /></svg>
          </button>
        </template>
        <button v-else class="round send" :disabled="disabled || !hasInput" title="发送" @click="send(false)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
        </button>
      </div>

      <!-- 底部的花费/token/上下文：放在输入框里面，不再另占一行 -->
      <div class="usage">
        <template v-if="usage">
          <span class="u click" title="本会话花费，点击看详情" @click="showSessionInfo">{{ usage.cost }}</span>
          <span v-if="usage.hit != null" class="u" title="缓存命中率（缓存读 / 全部输入）">缓存 {{ usage.hit }}%</span>
          <span class="u" title="累计输入 / 输出 tokens">↑{{ usage.inTok }} ↓{{ usage.outTok }}</span>
        </template>
        <span v-if="ctx" class="u" title="当前上下文占用">上下文 {{ fmtTokens(ctx.tokens) }}/{{ fmtTokens(ctx.contextWindow) }}</span>
        <span v-for="(v, k) in S.statusItems" :key="k" class="u ext" :title="k">{{ v }}</span>
        <span v-if="others" class="u">后台 {{ others }} 个在跑</span>
        <span class="grow" />
        <span class="u hint">{{ sendHint }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer { position: relative; flex: none; }
.box { position: relative; background: var(--panel); border: 1px solid var(--line); border-radius: 18px; box-shadow: var(--shadow); padding: 10px 10px 8px 14px; transition: border-color 0.15s, box-shadow 0.15s; }
.expand { position: absolute; top: 8px; right: 10px; width: 26px; height: 26px; border: 1px solid var(--line); background: var(--panel-2); border-radius: 7px; color: var(--text-3); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; z-index: 2; opacity: 0; box-shadow: var(--shadow-sm); transition: opacity 0.15s, color 0.15s, background 0.15s, border-color 0.15s; }
.box:hover .expand, .box.focused .expand, .expand.on { opacity: 1; }
.expand:hover { color: var(--text); border-color: var(--text-3); }
.expand.on { color: var(--accent-text); background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 35%, var(--line)); }
.box.focused { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); box-shadow: var(--shadow), 0 0 0 4px var(--accent-softer); }
.box.dragging { border-style: dashed; border-color: var(--accent); background: var(--accent-softer); }
.box.disabled { opacity: 0.6; }
.ta { display: block; width: 100%; resize: none; border: 0; background: transparent; outline: none; padding: 4px 32px 6px 0; line-height: var(--lh); min-height: calc(var(--lh) * 1em + 10px); max-height: 40vh; overflow-y: hidden; }
.ta::placeholder { color: var(--text-3); }
.box.big .ta { min-height: 32vh; max-height: 72vh; }

.bar { display: flex; align-items: center; gap: 6px; margin-left: -6px; min-width: 0; }
.bar > * { flex-shrink: 0; }
.bar > .chip { flex-shrink: 1; min-width: 0; }
.ibtn { width: 32px; height: 32px; border: 0; background: transparent; border-radius: 8px; color: var(--text-2); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.ibtn:hover { background: var(--hover); color: var(--text); }
.chip { height: 30px; max-width: 260px; display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; border: 1px solid var(--line); background: var(--panel-2); border-radius: 15px; color: var(--text-2); cursor: pointer; font-size: var(--fs-sm); transition: all 0.15s; }
.chip svg { flex: none; }
.chip.dir { max-width: 220px; }
.chip:hover, .chip.on { border-color: var(--accent); color: var(--accent-text); background: var(--accent-softer); }
.chip:disabled { opacity: 0.5; pointer-events: none; }
.caret { font-size: 10px; opacity: 0.6; }
.usage { display: flex; align-items: center; gap: 2px; padding: 4px 2px 0; font-size: 11px; color: var(--text-3); white-space: nowrap; overflow: hidden; font-variant-numeric: tabular-nums; }
.u { padding: 1px 6px; border-radius: 5px; display: inline-flex; align-items: center; }
.u + .u:not(.hint)::before { content: ''; }
.u.click { cursor: pointer; }
.u.click:hover { background: var(--active); color: var(--text-2); }
.u.ext { max-width: 240px; overflow: hidden; text-overflow: ellipsis; display: inline-block; }
.hint { font-size: 11px; color: var(--text-3); }
@media (max-width: 768px) { .hint { display: none; } }
.ring { display: inline-flex; align-items: center; gap: 4px; border: 0; background: transparent; color: var(--text-3); cursor: pointer; font-size: var(--fs-xs); padding: 0 6px; height: 30px; border-radius: 8px; font-variant-numeric: tabular-nums; }
.ring:hover { background: var(--hover); color: var(--text-2); }
.round { width: 34px; height: 34px; border-radius: 50%; border: 0; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex: none; transition: background 0.15s, transform 0.1s; }
.round:active { transform: scale(0.94); }
.send { background: var(--accent); color: #fff; }
.send:hover { background: var(--accent-hover); }
.send:disabled { background: var(--line); color: var(--text-3); cursor: default; transform: none; }
.stop { background: var(--text); color: var(--panel); }
.stop:hover { background: var(--err); color: #fff; }

.thumbs { display: flex; gap: 8px; padding: 2px 0 8px; flex-wrap: wrap; }
.thumb { position: relative; }
.thumb img { height: 64px; border-radius: 10px; border: 1px solid var(--line); display: block; }
.thumb .x { position: absolute; top: -6px; right: -6px; width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--panel); background: var(--text); color: var(--panel); font-size: 10px; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; }

.slash { left: 0; right: 0; bottom: calc(100% + 8px); max-height: 320px; overflow-y: auto; }
.sl { display: flex; align-items: center; gap: 10px; padding: 0 10px; height: 36px; border-radius: var(--r-sm); cursor: pointer; }
.sl.active { background: var(--accent-soft); }
.cmd { color: var(--accent-text); flex: none; min-width: 12ch; font-family: var(--font-code); font-weight: 600; }
.args { color: var(--text-3); font-family: var(--font-code); font-size: var(--fs-sm); flex: none; }
.desc { color: var(--text-2); font-size: var(--fs-sm); }
.src { font-size: 11px; color: var(--text-3); border: 1px solid var(--line); border-radius: 5px; padding: 0 6px; line-height: 18px; flex: none; }

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
  .box { border-radius: 16px; padding: 8px 8px 6px 12px; }
}
/* 触屏没有悬停，放大按钮得一直看得到 */
@media (hover: none) {
  .expand { opacity: 1; }
}
</style>
