<script setup>
import { UI, DEFAULTS, ACCENTS, FONT_PRESETS, view, resetSettings } from '../settings.js';

const close = () => (view.settingsOpen = false);
const isPreset = (v) => FONT_PRESETS.some((f) => f.value === v);
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
  ['radius', '气泡圆角', 0, 22, 1, (v) => `${v}px`],
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
          <button class="btn sm flat" @click="resetSettings">恢复默认</button>
          <button class="btn icon sm flat" title="关闭 (Esc)" @click="close">✕</button>
        </header>

        <div class="body">
          <!-- 外观 -->
          <section>
            <h3>外观</h3>
            <div class="card">
              <div class="item">
                <span class="label">主题</span>
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
                    :title="c"
                    @click="UI.accent = c"
                  />
                  <label class="sw custom" :class="{ on: !ACCENTS.includes(UI.accent.toLowerCase()) }" title="自定义颜色" :style="{ background: ACCENTS.includes(UI.accent.toLowerCase()) ? '' : UI.accent }">
                    <input v-model="UI.accent" type="color" />
                    <span v-if="ACCENTS.includes(UI.accent.toLowerCase())">+</span>
                  </label>
                </div>
              </div>
              <div class="item">
                <span class="label">我的气泡</span>
                <div class="seg">
                  <button v-for="[v, l] in [['accent', '主题色'], ['soft', '浅色调'], ['green', '微信绿']]" :key="v" :class="{ on: UI.userBubble === v }" @click="UI.userBubble = v">{{ l }}</button>
                </div>
              </div>
              <label class="item">
                <span class="label">显示头像</span>
                <input v-model="UI.avatars" type="checkbox" class="switch" />
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
                <select class="input" :value="isPreset(UI.font) ? UI.font : '__custom'" @change="$event.target.value !== '__custom' && (UI.font = $event.target.value)">
                  <option v-for="f in FONT_PRESETS" :key="f.value" :value="f.value">{{ f.label }}</option>
                  <option value="__custom">自定义…</option>
                </select>
                <input v-if="!isPreset(UI.font)" v-model.lazy="UI.font" class="input" placeholder="CSS 字体名，例如 'LXGW WenKai'" />
              </div>
              <div class="item col">
                <span class="label">代码字体</span>
                <select class="input" :value="isPreset(UI.codeFont) ? UI.codeFont : '__custom'" @change="$event.target.value !== '__custom' && (UI.codeFont = $event.target.value)">
                  <option v-for="f in FONT_PRESETS" :key="f.value" :value="f.value">{{ f.label }}</option>
                  <option value="__custom">自定义…</option>
                </select>
                <input v-if="!isPreset(UI.codeFont)" v-model.lazy="UI.codeFont" class="input" placeholder="CSS 字体名，例如 'JetBrains Mono'" />
              </div>
              <div v-for="[k, l, min, max, step, fmt] in textSliders" :key="k" class="item">
                <span class="label">{{ l }}</span>
                <input v-model.number="UI[k]" type="range" :min="min" :max="max" :step="step" class="range" @dblclick="UI[k] = DEFAULTS[k]" />
                <span class="val">{{ fmt(UI[k]) }}</span>
              </div>
              <div class="preview md">
                <p>预览 Preview：敏捷的棕色狐狸跳过了懒狗。The quick brown fox jumps over the lazy dog. <code>const x = 42</code></p>
                <p>第二段，用来看段落间距和行高是否舒服。0O 1lI {} [] =&gt; ===</p>
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
                <span class="label">始终显示模型和用量（默认悬停才显示）</span>
                <input v-model="UI.showMeta" type="checkbox" class="switch" />
              </label>
            </div>
            <p class="dim tip">小技巧：双击滑块恢复该项默认值。随时按 <b>Ctrl + ,</b> 打开这里。</p>
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

.seg { display: inline-flex; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 2px; gap: 2px; }
.seg button { border: 0; background: transparent; padding: 4px 10px; border-radius: 6px; cursor: pointer; color: var(--text-2); font-size: var(--fs-sm); white-space: nowrap; }
.seg button:hover { color: var(--text); }
.seg button.on { background: var(--panel); color: var(--accent-text); box-shadow: var(--shadow-sm); font-weight: 600; }
[data-theme='dark'] .seg button.on { background: var(--elev); }

.swatches { display: flex; gap: 10px; flex-wrap: wrap; }
.sw { width: 28px; height: 28px; border-radius: 50%; border: 0; cursor: pointer; position: relative; padding: 0; transition: transform 0.12s; }
.sw:hover { transform: scale(1.1); }
.sw.on { box-shadow: 0 0 0 2px var(--panel), 0 0 0 4px var(--text-2); }
.sw.custom { background: conic-gradient(red, yellow, lime, cyan, blue, magenta, red); display: inline-flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; text-shadow: 0 0 3px rgba(0, 0, 0, 0.6); }
.sw.custom input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
select.input { cursor: pointer; }

.preview { padding: 12px 14px; background: var(--chat-bg); font-size: var(--fs); border-top: 1px solid var(--line-2); }
.tip { font-size: var(--fs-xs); margin: 10px 4px 0; line-height: 1.7; }
.tip b { font-weight: 600; color: var(--text-2); }

.drawer-enter-active, .drawer-leave-active { transition: background 0.2s; }
.drawer-enter-active .settings-drawer, .drawer-leave-active .settings-drawer { transition: transform 0.22s ease; }
.drawer-enter-from, .drawer-leave-to { background: transparent; }
.drawer-enter-from .settings-drawer, .drawer-leave-to .settings-drawer { transform: translateX(100%); }
</style>
