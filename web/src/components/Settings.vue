<script setup>
import { ref, watch } from 'vue';
import { UI, DEFAULTS, VER, STYLES, useStyle, ACCENTS, ACCENT_NAMES, FONT_PRESETS, MONO_PRESETS, view, resetSettings } from '../settings.js';
import { toast } from '../store.js';
import { DISPLAY_MODES } from '../block-display.js';

const close = () => (view.settingsOpen = false);
const fileInput = ref(null); // 导入用的隐藏文件框

// ---- 导出 / 导入 ----
// 能备份的就是 localStorage 里那些 seed-pi-web-* 键：界面设置、收藏的目录、会话列表的怎么看/怎么摆、侧栏宽度…
// seed-pi-web-token 是访问令牌，不往文件里写（导出的东西可能会发给别人）。运行时内存里的东西不导。
const SKIP_KEYS = new Set(['seed-pi-web-token']);
function dumpStore() {
  const store = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith('seed-pi-web-') || SKIP_KEYS.has(k)) continue;
    store[k] = localStorage.getItem(k);
  }
  return store;
}

// 导出成 JSON：settings 那份人能看懂、也方便手工改；store 是原样打包（含 __v 和那些只有代码认得的键）
function exportSettings() {
  const settings = {};
  for (const k of Object.keys(DEFAULTS)) settings[k] = UI[k];
  const name = `seed-pi-web-settings-${new Date().toISOString().slice(0, 10)}.json`;
  const data = { app: 'seed-pi-web', kind: 'settings', version: 2, exportedAt: new Date().toISOString(), settings, store: dumpStore() };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`已导出 ${name}`);
}

/** 导入：把文件里的 seed-pi-web-* 键写回 localStorage，然后刷一次页面让各处重新读一遍 */
async function importSettings(e) {
  const file = e.target.files?.[0];
  e.target.value = ''; // 清掉，同一个文件还能再导一次
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('导入失败：这个文件不是 JSON', 'error');
    return;
  }
  if (data?.app !== 'seed-pi-web') {
    toast('导入失败：不是 seed-pi-web 导出的设置文件', 'error');
    return;
  }
  const store = { ...(data.store || {}) };
  // 老格式（v1）只有 settings 那一份：包成设置键，版本号写当前的，免得再去跑一遍老的迁移
  if (!data.store && data.settings) store['seed-pi-web-settings'] = JSON.stringify({ ...data.settings, __v: VER });
  let n = 0;
  for (const [k, v] of Object.entries(store)) {
    if (!k.startsWith('seed-pi-web-') || SKIP_KEYS.has(k) || typeof v !== 'string') continue;
    localStorage.setItem(k, v);
    n++;
  }
  if (!n) {
    toast('导入失败：文件里没有能用的设置', 'error');
    return;
  }
  toast(`已导入 ${n} 项，正在重新载入…`, 'info', 3000);
  setTimeout(() => location.reload(), 700);
}
// 按用途分三项：界面、聊天正文、代码 / 终端。聊天可选择跟随界面。
const fontFields = [
  { key: 'font', label: '界面字体', presets: FONT_PRESETS },
  { key: 'chatFont', label: '聊天字体', presets: FONT_PRESETS },
  { key: 'codeFont', label: '代码／终端等宽字体', presets: MONO_PRESETS },
];
const isPreset = (v, field) => (field.key === 'chatFont' && v === '') || field.presets.some((f) => f.value === v);
const fontCustom = ref(Object.fromEntries(fontFields.map((field) => [field.key, !isPreset(UI[field.key], field)])));
function onFontPick(e, field) {
  const v = e.target.value;
  if (v === '__custom') {
    fontCustom.value[field.key] = true;
    // 保留现有值，避免“自定义”空输入与聊天的“跟随界面”互相混淆。
    return;
  }
  fontCustom.value[field.key] = false;
  UI[field.key] = v;
}
// 切换整体样式 / 恢复默认时同步下拉框状态。
for (const field of fontFields) {
  watch(() => UI[field.key], (v) => { fontCustom.value[field.key] = !isPreset(v, field); });
}
function onKey(e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    close();
  }
}
// 滑块：[字段, 标题, 最小, 最大, 步长, 单位格式]
const textSliders = [
  ['fontSize', '界面字号', 12, 20, 1, (v) => `${v}px`],
  ['userFontSize', '用户消息字号', 12, 24, 1, (v) => `${v}px`],
  ['chatFontSize', '助手回复字号', 12, 24, 1, (v) => `${v}px`],
  ['codeFontSize', '代码字号', 11, 18, 1, (v) => `${v}px`],
  ['toolFontSize', '工具调用字号', 10, 24, 1, (v) => `${v}px`],
  ['thinkingFontSize', '思考字号', 10, 24, 1, (v) => `${v}px`],
  ['lineHeight', '行高', 1.3, 2.1, 0.05, (v) => v.toFixed(2)],
  ['letterSpacing', '字间距', 0, 1.5, 0.1, (v) => `${v.toFixed(1)}px`],
  ['paraGap', '段落间距', 0.2, 2, 0.1, (v) => `${v.toFixed(1)}em`],
];
const layoutSliders = [
  ['spacing', '整体间距', 0.7, 1.5, 0.05, (v) => `${Math.round(v * 100)}%`],
  ['radius', '全局圆角', 0, 20, 1, (v) => `${v}px`],
  ['chatWidth', '聊天区宽度', 0, 1400, 20, (v) => (v ? `${v}px` : '铺满')],
];
</script>

<template>
  <Transition name="drawer">
    <!-- 类名刻意和 App.vue 的 .mask 区分开：子组件根元素会同时带上父组件的 scoped 标记，
         两处同名 class 的样式会互相覆盖（同名时后编译的那条赢），之前就是这样把抽屉弄成透明的 -->
    <div v-if="view.settingsOpen" class="settings-mask" @mousedown.self="close" @keydown="onKey">
      <aside class="settings-drawer" tabindex="-1">
        <header class="head">
          <div class="title">界面设置</div>
          <div class="grow" />
          <button class="btn icon sm flat" title="关闭 (Esc)" @click="close">✕</button>
          <input ref="fileInput" type="file" accept=".json,application/json" style="display: none" @change="importSettings" />
        </header>

        <div class="body">
          <section>
            <h3>外观</h3>
            <div class="card">
              <div class="item col">
                <span class="label">整体风格</span>
                <div class="styles">
                  <button v-for="s in STYLES" :key="s.value" class="style" :class="{ on: UI.uiStyle === s.value }" :aria-pressed="UI.uiStyle === s.value" @click="useStyle(s.value)">
                    <span class="sty-name">{{ s.label }}</span>
                  </button>
                </div>
              </div>
              <div class="item">
                <span class="label">深浅色</span>
                <div class="seg">
                  <button v-for="[v, l] in [['light', '浅色'], ['dark', '深色'], ['auto', '跟随系统']]" :key="v" :class="{ on: UI.theme === v }" @click="UI.theme = v">{{ l }}</button>
                </div>
              </div>
              <div class="item col">
                <span class="label">主题色</span>
                <div class="swatches">
                  <button
                    v-for="c in ACCENTS"
                    :key="c"
                    class="sw"
                    :class="{ on: UI.accent.toLowerCase() === c }"
                    :style="{ background: c }"
                    :title="ACCENT_NAMES[c] || c"
                    @click="UI.accent = c"
                  />
                  <label class="sw custom" :class="{ on: !ACCENTS.includes(UI.accent.toLowerCase()) }" title="自定义颜色" :style="{ background: ACCENTS.includes(UI.accent.toLowerCase()) ? '' : UI.accent }">
                    <input v-model="UI.accent" type="color" />
                    <span v-if="ACCENTS.includes(UI.accent.toLowerCase())">+</span>
                  </label>
                </div>
              </div>
              <div class="item">
                <span class="label">正文排版</span>
                <div class="seg">
                  <button v-for="[v, l] in [['default', '经典'], ['github', 'GitHub'], ['pi', 'pi']]" :key="v" :class="{ on: UI.mdStyle === v }" @click="UI.mdStyle = v">{{ l }}</button>
                </div>
              </div>
            </div>
          </section>

          <!-- 布局 -->
          <section>
            <h3>布局</h3>
            <div class="card">
              <div v-for="[k, l, min, max, step, fmt] in layoutSliders" :key="k" class="item">
                <span class="label">{{ l }}</span>
                <input v-model.number="UI[k]" type="range" :aria-label="l" :min="min" :max="max" :step="step" class="range" @dblclick="UI[k] = DEFAULTS[k]" />
                <span class="val">{{ fmt(UI[k]) }}</span>
              </div>
            </div>
          </section>

          <!-- 文字 -->
          <section>
            <h3>文字</h3>
            <div class="card">
              <div v-for="field in fontFields" :key="field.key" class="item col">
                <span class="label">{{ field.label }}</span>
                <select class="input" :aria-label="field.label" :value="fontCustom[field.key] ? '__custom' : UI[field.key]" @change="onFontPick($event, field)">
                  <option v-if="field.key === 'chatFont'" value="">跟随界面字体</option>
                  <option v-for="f in field.presets" :key="f.value" :value="f.value">{{ f.label }}</option>
                  <option value="__custom">自定义…</option>
                </select>
                <input v-if="fontCustom[field.key]" v-model.lazy="UI[field.key]" class="input" :aria-label="field.label + '（自定义）'" placeholder="CSS 字体名，例如 'LXGW WenKai' 或 'JetBrains Mono'" />
              </div>
              <div v-for="[k, l, min, max, step, fmt] in textSliders" :key="k" class="item">
                <span class="label">{{ l }}</span>
                <input v-model.number="UI[k]" type="range" :aria-label="l" :min="min" :max="max" :step="step" class="range" @dblclick="UI[k] = DEFAULTS[k]" />
                <span class="val">{{ fmt(UI[k]) }}</span>
              </div>
              <details class="text-preview">
                <summary>文字预览</summary>
                <div class="preview user-message-sample" aria-label="用户消息字号预览">
                  <div class="sample-bubble">用户消息预览：你好 Hello，帮我看一下这段代码。</div>
                </div>
                <div class="preview md" aria-label="助手回复字号预览">
                  <p>助手回复预览 Preview：敏捷的棕色狐狸跳过了懒狗。The quick brown fox jumps over the lazy dog. <code>const x = 42</code></p>
                  <p>第二段，用来看段落间距和行高是否舒服。0O 1lI {} [] =&gt; ===</p>
                  <blockquote><p>引用块长这样</p></blockquote>
                </div>
                <div class="preview process-samples" aria-label="工具调用和思考字号预览">
                  <div class="blk tool-execution"><div class="blk-body">工具调用预览 Tool output：读取文件，共 42 行。</div></div>
                  <div class="blk prose thinking-block"><div class="blk-body prose">思考预览 Thinking：先分析问题，再逐步验证。</div></div>
                </div>
              </details>
            </div>
          </section>

          <!-- 行为 -->
          <section>
            <h3>使用习惯</h3>
            <div class="card">
              <div class="item">
                <span class="label">发送消息</span>
                <div class="seg">
                  <button :class="{ on: UI.sendKey === 'enter' }" @click="UI.sendKey = 'enter'">Enter</button>
                  <button :class="{ on: UI.sendKey === 'ctrlEnter' }" @click="UI.sendKey = 'ctrlEnter'">Ctrl + Enter</button>
                </div>
              </div>
              <div v-for="[key, label] in [['thinkingDisplay', '思考过程'], ['toolsDisplay', '工具调用']]" :key="key" class="item">
                <span class="label">{{ label }}</span>
                <div class="seg" :aria-label="label">
                  <button v-for="mode in DISPLAY_MODES" :key="mode.value" :class="{ on: UI[key] === mode.value }" :aria-pressed="UI[key] === mode.value" @click="UI[key] = mode.value">{{ mode.label }}</button>
                </div>
              </div>
              <div class="item">
                <span class="label">状态栏</span>
                <div class="seg" aria-label="状态栏">
                  <button v-for="[v, l] in [['top', '顶部'], ['bottom', '底部'], ['hidden', '隐藏']]" :key="v" :class="{ on: UI.statusBar === v }" :aria-pressed="UI.statusBar === v" @click="UI.statusBar = v">{{ l }}</button>
                </div>
              </div>
              <label v-if="UI.statusBar !== 'hidden'" class="item">
                <span class="label">状态栏分割线</span>
                <input v-model="UI.statusDivider" type="checkbox" class="switch" />
              </label>
              <label class="item">
                <span class="label">显示时间、模型与用量</span>
                <input v-model="UI.showMeta" type="checkbox" class="switch" />
              </label>
            </div>
          </section>

          <!-- 附件 -->
          <section>
            <h3>附件</h3>
            <div class="card">
              <label class="item">
                <span class="label">发送后保留附件</span>
                <input v-model="UI.keepAttachments" type="checkbox" class="switch" />
              </label>
              <div class="item col">
                <span class="label">上传目录</span>
                <input v-model.lazy.trim="UI.uploadDir" aria-label="上传目录" class="input mono" :placeholder="DEFAULTS.uploadDir" @change="!UI.uploadDir && (UI.uploadDir = DEFAULTS.uploadDir)" />
              </div>
              <div class="item">
                <span class="label">单个文件上传上限</span>
                <input v-model.number="UI.uploadMaxMB" aria-label="单个文件上传上限" type="number" min="1" class="input num" />
                <span class="val">MB</span>
              </div>
            </div>
          </section>
        </div>
        <footer class="foot">
          <button class="btn sm flat" @click="exportSettings">导出</button>
          <button class="btn sm flat" @click="fileInput.click()">导入</button>
          <div class="grow" />
          <button class="btn sm flat" @click="resetSettings">恢复默认</button>
        </footer>
      </aside>
    </div>
  </Transition>
</template>

<style scoped>
.settings-mask { position: fixed; inset: 0; z-index: 55; background: rgba(15, 23, 42, 0.12); display: flex; justify-content: flex-end; }
.settings-drawer { width: 460px; max-width: 100vw; height: 100%; background: var(--panel); border-left: 1px solid var(--line); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; outline: none; }
.head { display: flex; align-items: center; gap: 8px; min-height: var(--top-height); padding: 16px 24px; border-bottom: 1px solid var(--line); }
.title { font-size: calc(var(--fs) + 2px); font-weight: 600; }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 0 24px; scrollbar-gutter: stable; }
section { padding: 24px 0; }
section + section { border-top: 1px solid var(--line); }
h3 { font-size: var(--fs-sm); font-weight: 600; color: var(--text-3); margin: 0 0 12px; }
.card { display: flex; flex-direction: column; gap: 4px; }
.item { display: flex; align-items: center; gap: 12px; padding: 10px 0; min-height: 44px; cursor: default; }
label.item { cursor: pointer; }
.item.col { flex-direction: column; align-items: stretch; gap: 10px; }
.label { flex: 1; min-width: 0; color: var(--text-2); }
.item.col .label { flex: none; }
.item:has(.range) .label { flex: 0 0 104px; }
.val { flex: 0 0 54px; text-align: right; color: var(--text-3); font-variant-numeric: tabular-nums; font-size: var(--fs-sm); }
.range { flex: 1; min-width: 0; width: 0; height: 20px; margin: 0; appearance: none; background: transparent; cursor: pointer; }
.range::-webkit-slider-runnable-track { height: 3px; border-radius: var(--r-sm); background: var(--line); }
.range::-moz-range-track { height: 3px; border-radius: var(--r-sm); background: var(--line); }
.range::-webkit-slider-thumb { appearance: none; width: 13px; height: 13px; margin-top: -5px; border: 2px solid var(--accent); border-radius: var(--r-sm); background: var(--panel); }
.range::-moz-range-thumb { width: 9px; height: 9px; border: 2px solid var(--accent); border-radius: var(--r-sm); background: var(--panel); }
.range:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: var(--r-sm); }

.seg { display: inline-flex; flex: none; border: 1px solid var(--line); border-radius: var(--r-md); padding: 3px; gap: 2px; }
.seg button { border: 0; background: transparent; padding: 5px 10px; border-radius: var(--r-sm); cursor: pointer; color: var(--text-2); font-size: var(--fs-sm); white-space: nowrap; }
.seg button:hover { background: var(--hover); color: var(--text); }
.seg button.on { background: var(--accent-softer); color: var(--accent-text); font-weight: 600; }

.swatches { display: flex; gap: 10px; flex-wrap: wrap; padding: 4px; }
.styles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.style { padding: 12px; text-align: center; border: 1px solid var(--line); border-radius: var(--r-md); background: transparent; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
.style:hover { border-color: var(--text-3); }
.style.on { border-color: var(--accent); background: var(--accent-softer); }
.sty-name { font-weight: 600; color: var(--text); }
.style.on .sty-name { color: var(--accent-text); }
.sw { width: 22px; height: 22px; border-radius: var(--r-sm); border: 0; cursor: pointer; position: relative; padding: 0; transition: transform 0.12s; }
.sw:hover { transform: scale(1.1); }
.sw.on { box-shadow: 0 0 0 2px var(--panel), 0 0 0 4px var(--text-2); }
.sw.custom { background: var(--panel-2); border: 1px solid var(--line); display: inline-flex; align-items: center; justify-content: center; color: var(--text-2); }
.sw.custom input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
select.input { cursor: pointer; width: 100%; }
.text-preview { margin-top: 8px; border: 1px solid var(--line-2); border-radius: var(--r-md); overflow: hidden; }
.text-preview summary { padding: 12px; color: var(--text-2); font-size: var(--fs-sm); cursor: pointer; }
.text-preview summary:hover { background: var(--hover); }

.preview { padding: 12px 14px; background: var(--chat-bg); font-size: var(--fs-chat); border-top: 1px solid var(--line-2); }
.user-message-sample { display: flex; justify-content: flex-end; }
.sample-bubble { font-family: var(--font-chat); font-size: var(--fs-user); line-height: 1.6; padding: 8px 12px; border: 1px solid var(--bubble-me-border); border-radius: var(--r-bubble); background: var(--bubble-me); color: var(--bubble-me-text); }
.process-samples { display: grid; gap: 8px; }
.process-samples .blk { margin: 0; }
.input.mono { font-family: var(--font-code); font-size: var(--fs-sm); }
.input.num { width: 80px; }
.item:has(.input.num) .val { flex-basis: auto; }
.foot { display: flex; align-items: center; flex: none; gap: 8px; padding: 14px 24px; border-top: 1px solid var(--line); }
@media (max-width: 400px) {
  .head, .foot { padding-left: 16px; padding-right: 16px; }
  .body { padding: 0 16px; }
  .item { gap: 8px; }
  .item:has(.range) .label { flex-basis: 96px; }
  .seg button { padding: 5px 8px; }
}

.drawer-enter-active, .drawer-leave-active { transition: background 0.2s; }
.drawer-enter-active .settings-drawer, .drawer-leave-active .settings-drawer { transition: transform 0.22s ease; }
.drawer-enter-from, .drawer-leave-to { background: transparent; }
.drawer-enter-from .settings-drawer, .drawer-leave-to .settings-drawer { transform: translateX(100%); }
</style>
