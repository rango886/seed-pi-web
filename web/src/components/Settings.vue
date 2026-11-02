<script setup>
import { ref, watch } from 'vue';
import { UI, DEFAULTS, STYLES, useStyle, ACCENTS, ACCENT_NAMES, FONT_PRESETS, MONO_PRESETS, view, resetSettings } from '../settings.js';
import { toast } from '../store.js';

const close = () => (view.settingsOpen = false);

// 把设置导出成 JSON 文件（只导设置抽屉里那几项，内部字段不导）
function exportSettings() {
  const settings = {};
  for (const k of Object.keys(DEFAULTS)) settings[k] = UI[k];
  const name = `pi-web-settings-${new Date().toISOString().slice(0, 10)}.json`;
  const data = { app: 'pi-web', kind: 'settings', version: 1, exportedAt: new Date().toISOString(), settings };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`已导出 ${name}`);
}
// 界面字体和代码字体各自一张表：一个选项一款字体，代码字体那张只放等宽的
const presetsOf = (which) => (which === 'font' ? FONT_PRESETS : MONO_PRESETS);
const isPreset = (v, which = 'font') => presetsOf(which).some((f) => f.value === v);

// 字体下拉框：选“自定义…”时把当前预设值清掉，露出下面那个输入框
const fontCustom = ref(!isPreset(UI.font, 'font'));
const codeCustom = ref(!isPreset(UI.codeFont, 'code'));
function onFontPick(e, which) {
  const v = e.target.value;
  const custom = which === 'font' ? fontCustom : codeCustom;
  if (v === '__custom') {
    custom.value = true;
    if (isPreset(which === 'font' ? UI.font : UI.codeFont, which)) {
      if (which === 'font') UI.font = '';
      else UI.codeFont = '';
    }
    return;
  }
  custom.value = false;
  if (which === 'font') UI.font = v;
  else UI.codeFont = v;
}
// 整体样式会把字体换成预设值，换完把“自定义”输入框收起来
watch(
  () => UI.font,
  (v) => isPreset(v, 'font') && (fontCustom.value = false),
);
watch(
  () => UI.codeFont,
  (v) => isPreset(v, 'code') && (codeCustom.value = false),
);
function onKey(e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    close();
  }
}
// 滑块：[字段, 标题, 最小, 最大, 步长, 单位格式]
const textSliders = [
  ['fontSize', '字号', 12, 20, 1, (v) => `${v}px`],
  ['codeFontSize', '代码字号', 11, 18, 1, (v) => `${v}px`],
  ['lineHeight', '行高', 1.3, 2.1, 0.05, (v) => v.toFixed(2)],
  ['letterSpacing', '字间距', 0, 1.5, 0.1, (v) => `${v.toFixed(1)}px`],
  ['paraGap', '段落间距', 0.2, 1.4, 0.1, (v) => `${v.toFixed(1)}em`],
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
          <span class="dim hint">改动立即生效</span>
          <div class="grow" />
          <button class="btn sm flat" title="把当前设置导出成 JSON 文件" @click="exportSettings">导出</button>
          <button class="btn sm flat" @click="resetSettings">恢复默认</button>
          <button class="btn icon sm flat" title="关闭 (Esc)" @click="close">✕</button>
        </header>

        <div class="body">
          <!-- 整体样式：选一次就把主题色 / Markdown 排版 / 字体字号行高这些一起换掉 -->
          <section>
            <h3>整体样式</h3>
            <div class="card">
              <div class="styles">
                <button v-for="s in STYLES" :key="s.value" class="style" :class="{ on: UI.uiStyle === s.value }" @click="useStyle(s.value)">
                  <span class="sty-name">{{ s.label }}</span>
                  <span class="sty-desc">{{ s.desc }}</span>
                </button>
              </div>
              <div class="item">
                <span class="label dim small-tip">换样式会把主题色、Markdown 排版和字体字号行高一起换掉，换完还能单独改；深浅色在下面单独选。</span>
              </div>
            </div>
          </section>

          <!-- 深浅色 -->
          <section>
            <h3>深浅色</h3>
            <div class="card">
              <div class="item">
                <span class="label">配色</span>
                <div class="seg">
                  <button v-for="[v, l] in [['light', '浅色'], ['dark', '深色'], ['auto', '跟随系统']]" :key="v" :class="{ on: UI.theme === v }" @click="UI.theme = v">{{ l }}</button>
                </div>
              </div>
            </div>
          </section>

          <!-- 主题色 -->
          <section>
            <h3>主题色</h3>
            <div class="card">
              <div class="item col">
                <span class="label">主题色<span class="dim small-tip">（自己的气泡颜色跟着它走）</span></span>
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
            </div>
          </section>

          <!-- Markdown 排版 -->
          <section>
            <h3>Markdown 排版</h3>
            <div class="card">
              <div class="item">
                <span class="label">回复正文的 Markdown</span>
                <div class="seg">
                  <button v-for="[v, l] in [['default', '默认'], ['github', 'GitHub'], ['github-compact', 'GitHub 紧凑']]" :key="v" :class="{ on: UI.mdStyle === v }" @click="UI.mdStyle = v">{{ l }}</button>
                </div>
              </div>
              <label class="item">
                <span class="label">回复正文加边框（默认关）</span>
                <input v-model="UI.hoverBox" type="checkbox" class="switch" />
              </label>
            </div>
          </section>

          <!-- 布局 -->
          <section>
            <h3>布局</h3>
            <div class="card">
              <div v-for="[k, l, min, max, step, fmt] in layoutSliders" :key="k" class="item">
                <span class="label">{{ l }}</span>
                <input v-model.number="UI[k]" type="range" :min="min" :max="max" :step="step" class="range" @dblclick="UI[k] = DEFAULTS[k]" />
                <span class="val">{{ fmt(UI[k]) }}</span>
              </div>
            </div>
          </section>

          <!-- 文字 -->
          <section>
            <h3>文字</h3>
            <div class="card">
              <div class="item col">
                <span class="label">界面字体</span>
                <select class="input" :value="fontCustom ? '__custom' : UI.font" @change="onFontPick($event, 'font')">
                  <option v-for="f in FONT_PRESETS" :key="f.value" :value="f.value">{{ f.label }}</option>
                  <option value="__custom">自定义…</option>
                </select>
                <input v-if="fontCustom" v-model.lazy="UI.font" class="input" placeholder="CSS 字体名，例如 'LXGW WenKai'" />
              </div>
              <div class="item col">
                <span class="label">代码字体</span>
                <select class="input" :value="codeCustom ? '__custom' : UI.codeFont" @change="onFontPick($event, 'code')">
                  <option v-for="f in MONO_PRESETS" :key="f.value" :value="f.value">{{ f.label }}</option>
                  <option value="__custom">自定义…</option>
                </select>
                <input v-if="codeCustom" v-model.lazy="UI.codeFont" class="input" placeholder="CSS 字体名，例如 'JetBrains Mono'" />
              </div>
              <div v-for="[k, l, min, max, step, fmt] in textSliders" :key="k" class="item">
                <span class="label">{{ l }}</span>
                <input v-model.number="UI[k]" type="range" :min="min" :max="max" :step="step" class="range" @dblclick="UI[k] = DEFAULTS[k]" />
                <span class="val">{{ fmt(UI[k]) }}</span>
              </div>
              <div class="preview md">
                <p>预览 Preview：敏捷的棕色狐狸跳过了懒狗。The quick brown fox jumps over the lazy dog. <code>const x = 42</code></p>
                <p>第二段，用来看段落间距和行高是否舒服。0O 1lI {} [] =&gt; ===</p>
                <blockquote><p>引用块长这样</p></blockquote>
              </div>
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
              <label class="item">
                <span class="label">思考过程默认展开</span>
                <input v-model="UI.thinkingOpen" type="checkbox" class="switch" />
              </label>
              <label class="item">
                <span class="label">工具调用默认展开</span>
                <input v-model="UI.toolsOpen" type="checkbox" class="switch" />
              </label>
              <label class="item">
                <span class="label">显示时间、模型与用量（默认关；也可以右键消息打开）</span>
                <input v-model="UI.showMeta" type="checkbox" class="switch" />
              </label>
            </div>
            <p class="dim tip">小技巧：双击滑块恢复该项默认值。随时按 <b>Ctrl + ,</b> 打开这里。</p>
          </section>

          <!-- 附件 -->
          <section>
            <h3>附件</h3>
            <div class="card">
              <label class="item">
                <span class="label">发送后保留附件（下一轮接着带上）</span>
                <input v-model="UI.keepAttachments" type="checkbox" class="switch" />
              </label>
              <div class="item col">
                <span class="label">上传目录</span>
                <input v-model.lazy.trim="UI.uploadDir" class="input mono" :placeholder="DEFAULTS.uploadDir" @change="!UI.uploadDir && (UI.uploadDir = DEFAULTS.uploadDir)" />
                <span class="dim small-tip">
                  从资源管理器拖进来的、截图、局域网里传的文件存在这里。可以用 <code>{tmp}</code> 系统临时目录、<code>{cwd}</code> 工作目录、<code>{session}</code> 会话 id、<code>{date}</code> 日期、<code>{home}</code> 用户目录；相对路径按工作目录算。
                </span>
              </div>
              <div class="item">
                <span class="label">单个文件上传上限</span>
                <input v-model.number="UI.uploadMaxMB" type="number" min="1" class="input num" />
                <span class="val">MB</span>
              </div>
            </div>
            <p class="dim tip">本机打开时，在资源管理器里复制文件再到输入框 <b>Ctrl + V</b>，用的是原文件路径，不会上传；从右侧文件树拖进来、输入 <b>@</b> 引用也一样。</p>
          </section>
        </div>
      </aside>
    </div>
  </Transition>
</template>

<style scoped>
.settings-mask { position: fixed; inset: 0; z-index: 55; background: rgba(15, 23, 42, 0.12); display: flex; justify-content: flex-end; }
.settings-drawer { width: 420px; max-width: 94vw; height: 100%; background: var(--panel-2); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; outline: none; }
.head { display: flex; align-items: center; gap: 8px; padding: 16px 16px 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel); }
.title { font-size: calc(var(--fs) + 3px); font-weight: 600; }
.hint { font-size: var(--fs-xs); }
.body { flex: 1; overflow-y: auto; padding: 8px 16px 24px; }
section { margin-top: 14px; }
h3 { font-size: var(--fs-sm); font-weight: 600; color: var(--text-2); margin: 0 4px 8px; }
.card { background: var(--panel); border-radius: var(--r-md); border: 1px solid var(--line); overflow: hidden; }
.item { display: flex; align-items: center; gap: 12px; padding: 11px 14px; min-height: 48px; border-bottom: 1px solid var(--line-2); cursor: default; }
.item:last-child { border-bottom: 0; }
label.item { cursor: pointer; }
.item.col { flex-direction: column; align-items: stretch; gap: 8px; }
.label { flex: 1; min-width: 0; }
.item.col .label { flex: none; }
.val { width: 54px; text-align: right; color: var(--text-2); font-variant-numeric: tabular-nums; font-size: var(--fs-sm); }
.range { width: 150px; accent-color: var(--accent); cursor: pointer; }

.seg { display: inline-flex; background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--r-md); padding: 2px; gap: 2px; }
.seg button { border: 0; background: transparent; padding: 4px 10px; border-radius: var(--r-sm); cursor: pointer; color: var(--text-2); font-size: var(--fs-sm); white-space: nowrap; }
.seg button:hover { color: var(--text); }
.seg button.on { background: var(--panel); color: var(--accent-text); box-shadow: var(--shadow-sm); font-weight: 600; }
[data-theme='dark'] .seg button.on { background: var(--elev); }

.swatches { display: flex; gap: 10px; flex-wrap: wrap; }
/* 整体样式：三张并排的小卡片，选中的那张用主题色描一圈 */
.styles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 12px 14px 4px; }
.style { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; text-align: left; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--panel-2); cursor: pointer; transition: border-color 0.15s, background 0.15s; }
.style:hover { border-color: var(--text-3); }
.style.on { border-color: var(--accent); background: var(--accent-softer); }
.sty-name { font-weight: 600; color: var(--text); }
.style.on .sty-name { color: var(--accent-text); }
.sty-desc { font-size: var(--fs-xs); color: var(--text-3); line-height: 1.5; }
.sw { width: 28px; height: 28px; border-radius: 50%; border: 0; cursor: pointer; position: relative; padding: 0; transition: transform 0.12s; }
.sw:hover { transform: scale(1.1); }
.sw.on { box-shadow: 0 0 0 2px var(--panel), 0 0 0 4px var(--text-2); }
.sw.custom { background: conic-gradient(red, yellow, lime, cyan, blue, magenta, red); display: inline-flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; text-shadow: 0 0 3px rgba(0, 0, 0, 0.6); }
.sw.custom input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
select.input { cursor: pointer; }

.preview { padding: 12px 14px; background: var(--chat-bg); font-size: var(--fs); border-top: 1px solid var(--line-2); }
.tip { font-size: var(--fs-xs); margin: 10px 4px 0; line-height: 1.7; }
.small { font-size: var(--fs-sm); }
.tip b { font-weight: 600; color: var(--text-2); }
.small-tip { font-size: var(--fs-xs); line-height: 1.7; }
.small-tip code { font-family: var(--font-code); font-size: 11px; background: var(--hover); padding: 0 4px; border-radius: var(--r-xs); }
.input.mono { font-family: var(--font-code); font-size: var(--fs-sm); }
.input.num { width: 90px; }

.drawer-enter-active, .drawer-leave-active { transition: background 0.2s; }
.drawer-enter-active .settings-drawer, .drawer-leave-active .settings-drawer { transition: transform 0.22s ease; }
.drawer-enter-from, .drawer-leave-to { background: transparent; }
.drawer-enter-from .settings-drawer, .drawer-leave-to .settings-drawer { transform: translateX(100%); }
</style>
