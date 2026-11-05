import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import * as vue from 'vue';
import { parse, compileScript } from 'vue/compiler-sfc';
import { useBlockDisplay, DISPLAY_MODES } from '../web/src/block-display.js';

async function settings(t, saved = {}) {
  const values = new Map();
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
    const exports = name === 'vue' ? vue : { resetDiagramCache() {} };
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [k, v] of Object.entries(exports)) this.setExport(k, v);
    }, { context });
  });
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  await scope.run(() => mod.evaluate());
  return { ...mod.namespace, values, root, storage };
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

test('collapsed thinking keeps a single-line preview and expands the complete text without changing its default', async (t) => {
  const UI = vue.reactive({ thinkingDisplay: 'collapsed' });
  const text = 'First thought.\n\n  Second thought.\t' + 'More thoughts. '.repeat(50);
  const props = vue.reactive({ block: { thinking: text }, streaming: true });
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
  props.block.thinking += '\nNew streamed thought';
  await vue.nextTick();
  assert.equal(s.open.value, false, 'streaming cannot force a manually collapsed block open');
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
  assert.match(thinking, /v-if="!open && preview" class="ellipsis grow blk-sum think-prev"/);
  assert.match(thinking, /v-if="open && text"/);
  assert.doesNotMatch(base + pi + tool + thinking + settings, /block-expand|block-preview|半折叠|收起为预览|展开全部/);
});
