import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import * as vue from 'vue';
import { parse, compileScript } from 'vue/compiler-sfc';
import { useBlockDisplay, DISPLAY_MODES } from '../web/src/block-display.js';

async function settings(t, saved = {}) {
  const values = new Map();
  let diagramResets = 0;
  const storage = new Map([['seed-pi-web-settings', JSON.stringify(saved)]]);
  const root = { dataset: {}, style: { setProperty: (k, v) => values.set(k, v) } };
  const link = {};
  const context = vm.createContext({
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    document: { documentElement: root, querySelector: () => link },
  });
  const source = await fs.readFile(new URL('../web/src/settings.js', import.meta.url), 'utf8');
  const mod = new vm.SourceTextModule(source, { context });
  await mod.link(async (name) => {
    const exports = name === 'vue' ? vue : { resetDiagramCache() { diagramResets++; } };
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [k, v] of Object.entries(exports)) this.setExport(k, v);
    }, { context });
  });
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  await scope.run(() => mod.evaluate());
  return { ...mod.namespace, values, root, storage, link, get diagramResets() { return diagramResets; } };
}

async function tool(t, UI, props, file = 'ToolCard.vue') {
  const source = await fs.readFile(new URL('../web/src/components/' + file, import.meta.url), 'utf8');
  const code = compileScript(parse(source).descriptor, { id: 'test-tool' }).content;
  const context = vm.createContext({ console });
  const mod = new vm.SourceTextModule(code, { context });
  const imports = {
    vue,
    '../store.js': { S: { cwd: '/repo', info: { sep: '/' } }, openFile() {} },
    '../settings.js': { UI },
    '../block-display.js': { useBlockDisplay },
    '../util.js': {
      toolSummary: (args) => args.command || '', toolPath: () => '',
      textOf: (blocks) => (blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
      imagesOf: (blocks) => (blocks || []).filter((b) => b.type === 'image'),
      stripAnsi: (text) => text, isAbsPath: () => false, joinPath: (...parts) => parts.join('/'),
    },
  };
  await mod.link(async (name) => {
    const exports = imports[name];
    assert.ok(exports, name);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [k, v] of Object.entries(exports)) this.setExport(k, v);
    }, { context });
  });
  await mod.evaluate();
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  return scope.run(() => mod.namespace.default.setup(props, { expose() {} }));
}

test('pi preset restores the export font, 12px/18px typography and 800px column without changing disclosure preferences', async (t) => {
  const s = await settings(t, { __v: 13, toolsOpen: true });
  assert.deepEqual(Array.from(s.STYLES, (style) => style.value), ['modern', 'pi', 'github']);
  s.useStyle('pi');
  await vue.nextTick();
  assert.equal(s.UI.font, s.PI_FONT);
  assert.equal(s.UI.codeFont, s.PI_FONT);
  assert.equal(s.UI.fontSize, 12);
  assert.equal(s.UI.codeFontSize, 12);
  assert.equal(s.UI.lineHeight, 1.5);
  assert.equal(s.UI.chatWidth, 800);
  assert.equal(s.UI.mdStyle, 'pi');
  assert.equal(s.UI.toolsDisplay, 'expanded');
  assert.equal(s.values.get('--fs'), '12px');
  assert.equal(s.root.dataset.ui, 'pi');
  s.UI.theme = 'dark';
  await vue.nextTick();
  assert.equal(s.values.get('--accent'), '#a798d7');
  s.UI.accent = '#123456';
  await vue.nextTick();
  assert.equal(s.values.get('--accent'), '#123456', 'custom accent survives appearance changes');
  s.UI.mdStyle = 'github';
  await vue.nextTick();
  assert.equal(s.root.dataset.ui, 'pi');
  assert.equal(s.root.dataset.md, 'github', 'Markdown remains independent');
});

test('global radius and favicon corners agree across styles, including zero and maximum radius', async (t) => {
  const s = await settings(t);
  for (const style of s.STYLES) {
    s.useStyle(style.value);
    for (const radius of [0, 8, 20]) {
      s.UI.radius = radius;
      await vue.nextTick();
      assert.equal(s.values.get('--r'), radius + 'px');
      const svg = decodeURIComponent(s.link.href.split(',')[1]);
      const expected = Math.min(16, radius * 32 / 28).toFixed(1);
      assert.ok(svg.includes(`rx="${expected}"`), style.value + ': favicon must match the sidebar logo');
    }
  }
});

test('removed styles and controls migrate even when restored from a current-version backup', async (t) => {
  const s = await settings(t, { __v: 15, uiStyle: 'wechat', hoverBox: true, thinkingOpen: true, toolsOpen: false });
  assert.equal(s.UI.uiStyle, 'pi');
  assert.equal(s.UI.fontSize, 12);
  assert.equal(s.UI.thinkingDisplay, 'expanded');
  assert.equal(s.UI.toolsDisplay, 'collapsed');
  for (const key of ['hoverBox', 'thinkingOpen', 'toolsOpen']) assert.equal(key in s.UI, false);
  const compact = await settings(t, { __v: 13, mdStyle: 'github-compact', fontSize: 16 });
  assert.equal(compact.UI.mdStyle, 'github');
  assert.equal(compact.UI.fontSize, 16, 'unrelated custom settings are kept');
  compact.useStyle('pi');
  compact.resetSettings();
  assert.equal(compact.UI.uiStyle, 'github');
});

test('font stacks keep named fonts before generic families, deduplicate and preserve quoted commas', async (t) => {
  const s = await settings(t);
  for (const [presets, mono] of [[s.FONT_PRESETS, false], [s.MONO_PRESETS, true]]) {
    for (const preset of presets) {
      const stack = s.buildFontStack(preset.value, mono);
      const firstGeneric = stack.search(/(?:^|, )(?:system-ui|sans-serif|ui-monospace|monospace)(?:,|$)/);
      const namedTail = mono ? "'Noto Sans Mono CJK SC'" : "'霞鹜文楷 屏幕阅读版'";
      assert.ok(firstGeneric > stack.indexOf(namedTail), preset.label + ': generic families must follow named fallbacks');
    }
  }
  const stack = s.buildFontStack("sans-serif, 'Segoe UI', Segoe UI, 'Example, Text', system-ui");
  assert.ok(stack.startsWith("'Segoe UI', 'Example, Text', 'PingFang SC'"));
  assert.equal(stack.split('Segoe UI').length, 2);
  assert.ok(stack.indexOf('sans-serif') > stack.indexOf('Noto Sans CJK SC'));
  assert.ok(s.buildFontStack("'serif', serif").includes("'serif'"), 'quoted family names are not generic keywords');
  assert.ok(s.buildFontStack('', true).startsWith("'Consolas'"), 'empty code font never inherits proportional UI fonts');
});

test('old typography migrates without losing custom fonts or changing the chat text size', async (t) => {
  const oldGitHub = "'PingFang SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
  const s = await settings(t, { __v: 15, font: oldGitHub, fontSize: 18, codeFont: "'My Mono'" });
  assert.equal(s.UI.font, s.GITHUB_FONT);
  assert.equal(s.UI.chatFont, '');
  assert.equal(s.UI.chatFontSize, 18);
  assert.equal(s.UI.codeFont, "'My Mono'");
  const custom = await settings(t, { __v: 15, font: "'My Body'", fontSize: 16 });
  assert.equal(custom.UI.font, "'My Body'");
  assert.equal(custom.values.get('--font-chat'), custom.values.get('--font'));
  assert.equal(custom.values.get('--fs-chat'), '16px');
  const pi = await settings(t, { __v: 15, uiStyle: 'pi', font: "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace", fontSize: 12 });
  assert.equal(pi.UI.font, pi.PI_FONT);
  assert.equal(pi.UI.chatFontSize, 12);
});

test('UI, chat and code fonts and sizes are independent; following UI remains reactive and persists', async (t) => {
  const s = await settings(t);
  s.UI.font = "'Segoe UI'";
  s.UI.chatFont = "'LXGW WenKai'";
  s.UI.codeFont = "'JetBrains Mono'";
  s.UI.fontSize = 13;
  s.UI.chatFontSize = 19;
  s.UI.codeFontSize = 15;
  await vue.nextTick();
  assert.ok(s.values.get('--font').startsWith("'Segoe UI'"));
  assert.ok(s.values.get('--font-chat').startsWith("'LXGW WenKai'"));
  assert.ok(s.values.get('--font-code').startsWith("'JetBrains Mono'"));
  assert.equal(s.values.get('--fs'), '13px');
  assert.equal(s.values.get('--fs-chat'), '19px');
  assert.equal(s.values.get('--fs-code'), '15px');
  const resets = s.diagramResets;
  s.UI.font = "'Arial'";
  await vue.nextTick();
  assert.equal(s.diagramResets, resets, 'unrelated UI font changes do not redraw chat diagrams');
  s.UI.chatFont = '';
  await vue.nextTick();
  assert.equal(s.values.get('--font-chat'), s.values.get('--font'));
  assert.ok(s.diagramResets > resets);
  s.useStyle('pi');
  await vue.nextTick();
  s.UI.chatFont = "'Microsoft YaHei UI'";
  s.UI.codeFont = "'Fira Code'";
  await vue.nextTick();
  assert.ok(s.values.get('--font-chat').startsWith("'Microsoft YaHei UI'"));
  assert.ok(s.values.get('--font-code').startsWith("'Fira Code'"));
  const saved = JSON.parse(s.storage.get('seed-pi-web-settings'));
  assert.equal(saved.chatFont, s.UI.chatFont);
  assert.equal(saved.__v, s.VER);
  s.resetSettings();
  await vue.nextTick();
  assert.equal(s.UI.chatFont, '');
  assert.equal(s.UI.chatFontSize, 14);
});

test('font selectors support independent custom values, following UI, and preset resets', async (t) => {
  const s = await settings(t);
  const source = await fs.readFile(new URL('../web/src/components/Settings.vue', import.meta.url), 'utf8');
  const code = compileScript(parse(source).descriptor, { id: 'test-font-settings' }).content;
  const context = vm.createContext({});
  const mod = new vm.SourceTextModule(code, { context });
  const imports = { vue, '../settings.js': s, '../store.js': { toast() {} }, '../block-display.js': { DISPLAY_MODES } };
  await mod.link((name) => {
    const exports = imports[name];
    assert.ok(exports, name);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await mod.evaluate();
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  const panel = scope.run(() => mod.namespace.default.setup({}, { expose() {} }));
  const chat = panel.fontFields.find((field) => field.key === 'chatFont');
  const codeField = panel.fontFields.find((field) => field.key === 'codeFont');
  assert.equal(panel.fontCustom.value.chatFont, false);
  panel.onFontPick({ target: { value: '__custom' } }, chat);
  assert.equal(panel.fontCustom.value.chatFont, true);
  s.UI.chatFont = "'My Chat Font'";
  await vue.nextTick();
  assert.equal(panel.fontCustom.value.chatFont, true);
  panel.onFontPick({ target: { value: "'Fira Code'" } }, codeField);
  await vue.nextTick();
  assert.equal(s.UI.chatFont, "'My Chat Font'");
  assert.equal(s.UI.codeFont, "'Fira Code'");
  assert.equal(panel.fontCustom.value.codeFont, false);
  panel.onFontPick({ target: { value: '' } }, chat);
  await vue.nextTick();
  assert.equal(s.UI.chatFont, '');
  assert.equal(panel.fontCustom.value.chatFont, false);
  s.useStyle('pi');
  await vue.nextTick();
  for (const field of panel.fontFields) assert.equal(panel.fontCustom.value[field.key], false);
  assert.equal(panel.textSliders.find(([key]) => key === 'userFontSize')[1], '用户消息字号');
  assert.equal(panel.textSliders.find(([key]) => key === 'chatFontSize')[1], '助手回复字号');
  for (const [key, label] of [['toolFontSize', '工具调用字号'], ['thinkingFontSize', '思考字号']]) {
    const slider = panel.textSliders.find(([field]) => field === key);
    assert.equal(slider[1], label);
    assert.equal(slider[2], 10);
    assert.equal(slider[3], 24);
    assert.equal(slider[5](18), '18px');
  }
});

test('chat text and diagrams use chat typography while pi code uses the code font instead of inheriting prose', async () => {
  const read = (path) => fs.readFile(new URL('../web/src/' + path, import.meta.url), 'utf8');
  const [base, pi, composer, message, editor, util] = await Promise.all([
    read('style.css'), read('pi.css'), read('components/Composer.vue'), read('components/MessageItem.vue'), read('components/UserMessageEditor.vue'), read('util.js'),
  ]);
  assert.match(base, /\.md \{ font-family: var\(--font-chat\); font-size: var\(--fs-chat\)/);
  assert.match(pi, /\[data-md='pi'\] \.md \{ font-family: var\(--font-chat\); font-size: var\(--fs-chat\)/);
  assert.match(pi, /\.md code \{[^}]*font-family: var\(--font-code\)/);
  assert.match(pi, /\.md pre\.code code \{[^}]*font-family: var\(--font-code\); font-size: var\(--fs-code\)/);
  assert.doesNotMatch(pi, /--pi-font|--pi-md-size/);
  assert.match(composer, /\.ta \{ font-family: var\(--font-chat\); font-size: var\(--fs-user\)/);
  assert.match(message, /\.pre \{ font-family: var\(--font-chat\)/);
  assert.match(editor, /textarea \{[^}]*font-family: var\(--font-chat\); font-size: var\(--fs-user\)/);
  assert.match(util, /const font = cs\.getPropertyValue\('--font-chat'\)/);
  assert.match(util, /const mono = cs\.getPropertyValue\('--font-code'\)/);
});

test('user bubbles use automatic pale accent backgrounds with black text in every style and theme', async (t) => {
  const s = await settings(t);
  const read = (path) => fs.readFile(new URL('../web/src/' + path, import.meta.url), 'utf8');
  const [base, pi, github, message, panel] = await Promise.all([
    read('style.css'), read('pi.css'), read('github.css'), read('components/MessageItem.vue'), read('components/Settings.vue'),
  ]);
  assert.match(base, /--bubble-me: color-mix\(in srgb, var\(--accent\) var\(--bubble-me-tint\), white\)/);
  assert.match(base, /--bubble-me-text: #111111/);
  assert.match(base, /--bubble-me-tint: 14%/);
  assert.match(base, /:root\[data-theme='dark'\] \{ --bubble-me-tint: 22%; \}/);
  assert.match(base, /\.me-bubble ::selection \{[^}]*color: var\(--bubble-me-text\)/);
  assert.doesNotMatch(pi + github, /--bubble-me(?:-text|-border)?:|--pi-user:/);
  assert.match(message, /\.me-bubble \{[^}]*color: var\(--bubble-me-text\)/);
  assert.match(message, /\.me-bubble \.att \{[^}]*--panel: color-mix\(in srgb, var\(--bubble-me\) 55%, white\); --text-2: var\(--bubble-me-text\)/);
  assert.match(panel, /用户气泡自动使用同色系浅底、黑色文字/);

  const luminance = (rgb) => rgb.map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const foreground = luminance([17 / 255, 17 / 255, 17 / 255]);
  // Pure black is the worst-case accent when mixed with white; also cover all presets and pi dark accent.
  for (const hex of [...s.ACCENTS, '#000000', '#ffffff', '#a798d7', '#ff0000', '#00ff00', '#0000ff']) {
    const accent = hex.slice(1).match(/../g).map((v) => parseInt(v, 16) / 255);
    for (const tint of [0.14, 0.22]) {
      const background = accent.map((v) => v * tint + 1 - tint);
      const contrast = (luminance(background) + 0.05) / (foreground + 0.05);
      assert.ok(contrast >= 7, `${hex} at ${tint * 100}%: ${contrast.toFixed(2)}:1 contrast`);
    }
  }
});

test('user and assistant message sizes are independent, persist, and share equal preset defaults', async (t) => {
  const s = await settings(t, { __v: 18, userFontSize: 18, chatFontSize: 22 });
  assert.equal(s.values.get('--fs-user'), '18px');
  assert.equal(s.values.get('--fs-chat'), '22px');
  const resets = s.diagramResets;
  s.UI.userFontSize = 20;
  await vue.nextTick();
  assert.equal(s.values.get('--fs-user'), '20px');
  assert.equal(s.values.get('--fs-chat'), '22px');
  assert.equal(s.diagramResets, resets, 'changing user text cannot affect assistant diagrams');
  s.UI.chatFontSize = 24;
  await vue.nextTick();
  assert.equal(s.values.get('--fs-user'), '20px');
  assert.equal(s.values.get('--fs-chat'), '24px');
  assert.ok(s.diagramResets > resets);
  const saved = JSON.parse(s.storage.get('seed-pi-web-settings'));
  assert.equal(saved.userFontSize, 20);
  assert.equal(saved.chatFontSize, 24);
  assert.equal(saved.__v, 18);
  for (const style of s.STYLES) {
    s.useStyle(style.value);
    await vue.nextTick();
    const expected = style.value === 'pi' ? 12 : 14;
    assert.equal(s.UI.userFontSize, expected);
    assert.equal(s.UI.chatFontSize, expected);
  }
  s.UI.userFontSize = 24;
  s.UI.chatFontSize = 18;
  s.resetSettings();
  await vue.nextTick();
  assert.equal(s.UI.userFontSize, 14);
  assert.equal(s.UI.chatFontSize, 14);
});

test('old chat size initializes equal user and assistant sizes without the former minus-one offset', async (t) => {
  for (const uiStyle of ['modern', 'github', 'pi']) {
    const s = await settings(t, { __v: 17, uiStyle, chatFontSize: 18 });
    assert.equal(s.UI.userFontSize, 18);
    assert.equal(s.UI.chatFontSize, 18);
  }
  const partial = await settings(t, { __v: 17, fontSize: 20 });
  assert.equal(partial.UI.userFontSize, 14, 'missing chat size used the global chat default, not the UI size');
  assert.equal(partial.UI.chatFontSize, 14);
  const ancient = await settings(t, { __v: 15, fontSize: 18 });
  assert.equal(ancient.UI.userFontSize, 18);
  assert.equal(ancient.UI.chatFontSize, 18);
  const custom = await settings(t, { __v: 17, userFontSize: 21, chatFontSize: 16 });
  assert.equal(custom.UI.userFontSize, 21);
  assert.equal(custom.UI.chatFontSize, 16);
});

test('user bubbles, composer and editor use user size while replies and diagrams retain assistant size', async () => {
  const read = (path) => fs.readFile(new URL('../web/src/' + path, import.meta.url), 'utf8');
  const [base, pi, message, composer, editor, panel, util] = await Promise.all([
    read('style.css'), read('pi.css'), read('components/MessageItem.vue'), read('components/Composer.vue'),
    read('components/UserMessageEditor.vue'), read('components/Settings.vue'), read('util.js'),
  ]);
  assert.match(message, /\.me-bubble \{[^}]*font-size: var\(--fs-user\)/);
  assert.match(pi, /\.msg \.me-bubble \{[^}]*font-size: var\(--fs-user\)/);
  assert.doesNotMatch(message + pi, /font-size: calc\(var\(--fs-chat\) - 1px\)/);
  assert.match(composer, /\.ta \{[^}]*font-size: var\(--fs-user\)/);
  assert.match(composer, /watch\(\(\) => \[S\.composer\.text, UI\.font, UI\.chatFont, UI\.userFontSize/);
  assert.match(editor, /textarea \{[^}]*font-size: var\(--fs-user\)/);
  assert.match(base, /\.md \{[^}]*font-size: var\(--fs-chat\)/);
  assert.match(util, /parseFloat\(cs\.getPropertyValue\('--fs-chat'\)\)/);
  assert.match(panel, /aria-label="用户消息字号预览"/);
  assert.match(panel, /aria-label="助手回复字号预览"/);
  assert.match(panel, /\.sample-bubble \{[^}]*font-size: var\(--fs-user\)/);
});

test('tool and thinking sizes are independent, persist, and reset with every style preset', async (t) => {
  const s = await settings(t, { __v: 17, toolFontSize: 17, thinkingFontSize: 19 });
  assert.equal(s.values.get('--fs-tool'), '17px');
  assert.equal(s.values.get('--fs-thinking'), '19px');
  s.UI.toolFontSize = 21;
  s.UI.thinkingFontSize = 15;
  await vue.nextTick();
  assert.equal(s.values.get('--fs-tool'), '21px');
  assert.equal(s.values.get('--fs-thinking'), '15px');
  const saved = JSON.parse(s.storage.get('seed-pi-web-settings'));
  assert.equal(saved.toolFontSize, 21);
  assert.equal(saved.thinkingFontSize, 15);
  const resets = s.diagramResets;
  s.UI.fontSize = 18;
  s.UI.codeFontSize = 16;
  s.UI.chatFontSize = 20;
  await vue.nextTick();
  assert.equal(s.values.get('--fs-tool'), '21px');
  assert.equal(s.values.get('--fs-thinking'), '15px');
  const afterChat = s.diagramResets;
  s.UI.thinkingFontSize = 22;
  await vue.nextTick();
  assert.equal(s.diagramResets, afterChat, 'block typography does not invalidate chat diagrams');
  assert.ok(afterChat > resets);
  for (const style of s.STYLES) {
    s.useStyle(style.value);
    await vue.nextTick();
    assert.equal(s.UI.toolFontSize, 12);
    assert.equal(s.UI.thinkingFontSize, 12);
  }
  s.UI.toolFontSize = 24;
  s.UI.thinkingFontSize = 10;
  s.resetSettings();
  await vue.nextTick();
  assert.equal(s.UI.toolFontSize, 12);
  assert.equal(s.UI.thinkingFontSize, 12);
});

test('old block typography migrates from its actual UI size without losing explicit sizes', async (t) => {
  for (const [uiStyle, fontSize, expected] of [['github', 18, 16], ['modern', 16, 14], ['pi', 18, 18], ['pi', 12, 12]]) {
    const s = await settings(t, { __v: 16, uiStyle, fontSize });
    assert.equal(s.UI.toolFontSize, expected);
    assert.equal(s.UI.thinkingFontSize, expected);
  }
  const defaults = await settings(t, { __v: 16 });
  assert.equal(defaults.UI.toolFontSize, 12);
  const partialPi = await settings(t, { __v: 16, uiStyle: 'pi' });
  assert.equal(partialPi.UI.thinkingFontSize, 14, 'missing fontSize used the global default, not the pi preset');
  const custom = await settings(t, { __v: 16, fontSize: 18, toolFontSize: 20, thinkingFontSize: 15 });
  assert.equal(custom.UI.toolFontSize, 20);
  assert.equal(custom.UI.thinkingFontSize, 15);
});

test('block headings, summaries, previews, diffs and output inherit their own size even in pi', async () => {
  const read = (path) => fs.readFile(new URL('../web/src/' + path, import.meta.url), 'utf8');
  const [base, pi, panel] = await Promise.all([read('style.css'), read('pi.css'), read('components/Settings.vue')]);
  assert.match(base, /\.blk \{ --fs-block: var\(--fs-sm\); font-size: var\(--fs-block\)/);
  assert.match(base, /\.tool-execution \{ --fs-block: var\(--fs-tool\); \}/);
  assert.match(base, /\.thinking-block \{ --fs-block: var\(--fs-thinking\); \}/);
  for (const selector of ['blk-chip', 'blk-sum', 'blk-body']) {
    const rule = base.match(new RegExp('\\.' + selector + ' \\{([^}]+)\\}'))[1];
    assert.match(rule, /font-size: inherit/);
  }
  assert.match(pi, /\[data-ui='pi'\] \.blk \{[^}]*font-size: var\(--fs-block\)/);
  assert.match(panel, /:aria-label="l"/);
  assert.match(panel, /class="preview process-samples"/);
  assert.match(panel, /工具调用预览 Tool output/);
  assert.match(panel, /思考预览 Thinking/);
});

test('two disclosure modes are independent, reactive and local overrides never change defaults', async () => {
  assert.deepEqual(DISPLAY_MODES.map((m) => m.value), ['collapsed', 'expanded']);
  assert.deepEqual(DISPLAY_MODES.map((m) => m.label), ['折叠', '展开']);
  const UI = vue.reactive({ tool: 'collapsed', thinking: 'collapsed' });
  const scope = vue.effectScope();
  try {
    const a = scope.run(() => useBlockDisplay(() => UI.tool));
    const b = scope.run(() => useBlockDisplay(() => UI.thinking));
    a.expand();
    assert.equal(a.mode.value, 'expanded');
    assert.equal(UI.tool, 'collapsed');
    assert.equal(b.mode.value, 'collapsed');
    a.toggle();
    assert.equal(a.mode.value, 'collapsed');
    a.toggle();
    assert.equal(a.mode.value, 'expanded');
    UI.tool = 'expanded';
    await vue.nextTick();
    assert.equal(a.local.value, null);
    assert.equal(a.mode.value, 'expanded');
    assert.equal(b.mode.value, 'collapsed');
  } finally { scope.stop(); }
});

test('old half-expanded preferences migrate to collapsed, while expanded preferences are retained', async (t) => {
  const s = await settings(t, { __v: 14, thinkingDisplay: 'preview', toolsDisplay: 'expanded' });
  assert.equal(s.UI.thinkingDisplay, 'collapsed');
  assert.equal(s.UI.toolsDisplay, 'expanded');
  const defaults = await settings(t);
  assert.equal(defaults.UI.thinkingDisplay, 'collapsed');
  assert.equal(defaults.UI.toolsDisplay, 'collapsed');
});

test('completed thinking keeps a compact summary and expands the complete text without changing its default', async (t) => {
  const UI = vue.reactive({ thinkingDisplay: 'collapsed' });
  const text = 'First thought.\n\n  Second thought.\t' + 'More thoughts. '.repeat(50);
  const props = vue.reactive({ block: { thinking: text }, streaming: false });
  const s = await tool(t, UI, props, 'ThinkingBlock.vue');
  assert.equal(s.open.value, false);
  assert.equal(s.preview.value.length, 200);
  assert.equal(s.preview.value.startsWith('First thought. Second thought.'), true);
  assert.doesNotMatch(s.preview.value, /[\n\t]/);
  s.toggle();
  assert.equal(s.open.value, true);
  assert.equal(s.text.value, text.trim());
  assert.equal(UI.thinkingDisplay, 'collapsed');
  s.toggle();
  props.streaming = true;
  props.block.thinking += '\nNew streamed thought';
  await vue.nextTick();
  assert.equal(s.open.value, false, 'streaming cannot force a manually collapsed block open');
});

test('collapsed thinking follows the latest six lines, font changes and remounts without opening itself', async (t) => {
  const UI = vue.reactive({ thinkingDisplay: 'collapsed', thinkingFontSize: 12, lineHeight: 1.5 });
  const props = vue.reactive({ block: { thinking: Array.from({ length: 30 }, (_, i) => `thought ${i + 1}`).join('\n') }, streaming: true });
  const s = await tool(t, UI, props, 'ThinkingBlock.vue');
  assert.equal(s.livePreview.value.split('\n').length, 6);
  assert.ok(s.livePreview.value.startsWith('thought 25\n'));
  assert.ok(s.livePreview.value.endsWith('thought 30'));
  const viewport = { scrollTop: 0, scrollHeight: 480 };
  s.tailEl.value = viewport;
  await vue.nextTick();
  assert.equal(viewport.scrollTop, 480, 'initial ref assignment follows already-streamed content');
  viewport.scrollHeight = 600;
  props.block.thinking += '\nthought 31';
  await vue.nextTick();
  assert.equal(viewport.scrollTop, 600);
  assert.ok(s.livePreview.value.startsWith('thought 26\n'));
  assert.ok(s.livePreview.value.endsWith('thought 31'));
  assert.equal(s.open.value, false);
  viewport.scrollTop = 0;
  viewport.scrollHeight = 720;
  UI.thinkingFontSize = 20;
  await vue.nextTick();
  assert.equal(viewport.scrollTop, 720, 'changing the font keeps the wrapped tail in view');
  s.tailEl.value = null;
  await vue.nextTick();
  s.tailEl.value = { scrollTop: 0, scrollHeight: 900 };
  await vue.nextTick();
  assert.equal(s.tailEl.value.scrollTop, 900);
  assert.equal(UI.thinkingDisplay, 'collapsed');
});

test('long wrapped thinking stays bounded and expanded reading is never pulled to the bottom', async (t) => {
  const UI = vue.reactive({ thinkingDisplay: 'collapsed' });
  const props = vue.reactive({ block: { thinking: 'Beginning. ' + 'Long thought. '.repeat(1000) + 'Latest thought.' }, streaming: true });
  const s = await tool(t, UI, props, 'ThinkingBlock.vue');
  assert.equal(s.livePreview.value.length, 2400);
  assert.ok(s.livePreview.value.endsWith('Latest thought.'));
  assert.ok(!s.livePreview.value.includes('Beginning.'));
  const viewport = { scrollTop: 0, scrollHeight: 800 };
  s.tailEl.value = viewport;
  await vue.nextTick();
  s.toggle();
  viewport.scrollTop = 100;
  props.block.thinking += ' Next thought.';
  await vue.nextTick();
  assert.equal(viewport.scrollTop, 100, 'expanded reading is not auto-scrolled');
  assert.ok(s.text.value.startsWith('Beginning.'));
  s.toggle();
  await vue.nextTick();
  assert.equal(viewport.scrollTop, 800, 'collapsing resumes the live tail');
  props.streaming = false;
  viewport.scrollTop = 50;
  await vue.nextTick();
  assert.equal(s.livePreview.value, '');
  assert.equal(viewport.scrollTop, 50);
  assert.ok(s.preview.value.startsWith('Beginning.'));
  props.block.thinking = '';
  props.streaming = true;
  await vue.nextTick();
  assert.equal(s.livePreview.value, '');
});

test('tools keep the live tail while collapsed, hide completed output and expand the full scrollable result', async (t) => {
  const UI = vue.reactive({ toolsDisplay: 'collapsed' });
  const text = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join('\n');
  const props = vue.reactive({ call: { name: 'powershell', arguments: { command: 'test' } }, exec: { status: 'running', partial: { content: [{ type: 'text', text }] } }, streaming: true });
  const s = await tool(t, UI, props);
  assert.equal(s.preview.value.startsWith('line 445\n'), true);
  assert.equal(s.open.value, false);
  s.toggle();
  assert.equal(s.open.value, true);
  s.toggle();
  assert.equal(s.open.value, false);
  props.exec.partial.content[0].text += '\nline 451';
  await vue.nextTick();
  assert.equal(s.open.value, false);
  assert.equal(s.preview.value.endsWith('line 451'), true);
  props.exec.status = 'success';
  await vue.nextTick();
  assert.equal(s.preview.value, '');
  s.toggle();
  assert.equal(s.open.value, true);
  assert.equal(s.resultText.value.split('\n').length, 451);
  UI.toolsDisplay = 'expanded';
  await vue.nextTick();
  UI.toolsDisplay = 'collapsed';
  await vue.nextTick();
  assert.equal(s.open.value, false);
});

test('errors surface once, but never override a deliberate manual collapse', async (t) => {
  const UI = vue.reactive({ toolsDisplay: 'collapsed' });
  const props = vue.reactive({ call: { name: 'read', arguments: {} }, exec: { status: 'error', result: { content: [{ type: 'text', text: 'failed' }] } } });
  const s = await tool(t, UI, props);
  assert.equal(s.open.value, true);
  s.toggle();
  props.exec.status = 'running';
  await vue.nextTick();
  props.exec.status = 'error';
  await vue.nextTick();
  assert.equal(s.open.value, false);
  assert.equal(s.statusLabel.value, '失败');
});

test('expanded diffs retain all edits without an extra expansion step', async (t) => {
  const props = { call: { name: 'edit', arguments: { edits: [
    { oldText: 'a\nb\nc\nd\ne\nf', newText: 'A\nB\nC\nD\nE\nF' },
    { oldText: 'last', newText: 'LAST' },
  ] } }, exec: { status: 'success' } };
  const s = await tool(t, vue.reactive({ toolsDisplay: 'collapsed' }), props);
  assert.equal(s.open.value, false);
  s.toggle();
  assert.equal(s.open.value, true);
  assert.equal(s.diffLines.value.length, 15);
  assert.equal(s.diffLines.value.at(-1).text, '+ LAST');
});

test('pi styles preserve renderer enhancements and remove only the requested options', async () => {
  const read = (path) => fs.readFile(new URL('../web/src/' + path, import.meta.url), 'utf8');
  const [css, settings, message, main, github, util] = await Promise.all([
    read('pi.css'), read('components/Settings.vue'), read('components/MessageItem.vue'), read('main.js'), read('github.css'), read('util.js'),
  ]);
  assert.match(settings, /\[\['default', '经典'\], \['github', 'GitHub'\], \['pi', 'pi'\]\]/);
  assert.match(settings, /<span class="label">Markdown<\/span>/);
  assert.doesNotMatch(settings + message, /hoverBox|thinkingOpen|toolsOpen|github-compact/);
  assert.doesNotMatch(github, /github-compact/);
  assert.doesNotMatch(main, /wechat/);
  assert.match(css, /--pi-page: #21252c/);
  assert.match(css, /--pi-page: #efeeee/);
  assert.match(css, /--pi-line: 18px/);
  assert.match(css, /font-size: 1em; font-weight: bold/);
  assert.match(css, /pre\.code:focus-within \.code-bar/);
  assert.match(css, /\.md \.md-table \{ max-width: 100%; overflow-x: auto/);
  assert.match(util, /renderer\.table = function/);
  assert.match(message, /v-markdown-html="md\(b, i\)"/);
  assert.match(css, /\.md-math\.block/);
  assert.match(css, /\.md-diagram/);
});

test('expanded blocks stay scrollable in pi and the base style, without half-expanded controls', async () => {
  const read = (path) => fs.readFile(new URL('../web/src/' + path, import.meta.url), 'utf8');
  const [base, pi, tool, thinking, settings] = await Promise.all([
    read('style.css'), read('pi.css'), read('components/ToolCard.vue'), read('components/ThinkingBlock.vue'), read('components/Settings.vue'),
  ]);
  assert.match(tool, /\.body \{ max-height: min\(440px, 50vh\); overflow: auto/);
  assert.match(base, /\.thinking-block \.blk-body \{ max-height: min\(380px, 50vh\); overflow: auto/);
  assert.match(pi, /\.thinking-block \.blk-body \{[^}]*max-height: min\(380px, 50vh\); overflow: auto/);
  assert.match(thinking, /v-if="!open && !streaming && preview" class="ellipsis grow blk-sum think-prev"/);
  assert.match(thinking, /v-if="!open && livePreview" ref="tailEl" class="blk-body prose thinking-tail"/);
  assert.match(thinking, /flush: 'post'/);
  for (const css of [base, pi]) {
    assert.match(css, /\.thinking-block \.blk-body\.thinking-tail \{ max-height: 6lh; overflow: hidden/);
  }
  assert.match(thinking, /v-if="open && text"/);
  assert.doesNotMatch(base + pi + tool + thinking + settings, /block-expand|block-preview|半折叠|收起为预览|展开全部/);
});
