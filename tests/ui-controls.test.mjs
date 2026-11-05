// Exercise the real SFC setup functions without a browser or a DOM test dependency.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import * as vue from 'vue';
import { parse, compileScript } from 'vue/compiler-sfc';

async function setup(t, file, { props = {}, imports = {}, document = {}, storage = new Map() } = {}) {
  const source = await fs.readFile(new URL('../web/src/components/' + file, import.meta.url), 'utf8');
  const code = compileScript(parse(source).descriptor, { id: 'test' }).content;
  const noop = () => {};
  const context = vm.createContext({ console, document,
    window: { innerWidth: 1000, innerHeight: 800, addEventListener: noop, removeEventListener: noop },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    ResizeObserver: class { constructor(cb) { this.cb = cb; } observe(el) { this.cb([{ contentRect: { height: el.clientHeight } }]); } disconnect() {} },
  });
  const mod = new vm.SourceTextModule(code, { context });
  await mod.link(async (name) => {
    const values = name === 'vue' ? { ...vue, onMounted: noop, onUnmounted: noop }
      : name.endsWith('.vue') ? { default: {} } : imports[name];
    assert.ok(values, 'missing mock: ' + name);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [k, v] of Object.entries(values)) this.setExport(k, v);
    }, { context });
  });
  await mod.evaluate();
  const events = [];
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  const state = scope.run(() => mod.namespace.default.setup(props, { expose: noop, emit: (...args) => events.push(args) }));
  return { state, events };
}

test('file sidebar splitter drags, clamps, persists, restores cursor and supports keyboard', async (t) => {
  const document = { body: { style: { cursor: 'auto', userSelect: '' } } };
  const storage = new Map();
  const { state: s } = await setup(t, 'RightPanel.vue', { document, storage, imports: {
    '../store.js': { S: vue.reactive({ cwd: '/repo', tabs: [], terms: [] }), openSession() {}, sessionStatus() {}, isFav() {}, toggleFavorite() {}, killAgent() {} },
    '../settings.js': { view: vue.reactive({ panel: 'files' }), openMenu() {} },
    '../git.js': { G: vue.reactive({ cwd: '/repo', data: { available: true } }) },
    '../file-download.js': { downloadPath() {}, packing: new Set() },
  } });
  s.sectionsEl.value = { clientHeight: 407 };
  await vue.nextTick();
  assert.equal(s.splitHeight.value, 400);
  assert.equal(s.canResize.value, true);
  let captured = false, focused = false;
  const el = { offsetHeight: 7, focus() { focused = true; }, setPointerCapture() { captured = true; }, hasPointerCapture() { return captured; }, releasePointerCapture() { captured = false; } };
  s.startResize({ button: 0, currentTarget: el, pointerId: 1, clientY: 100 });
  assert.equal(focused, true);
  assert.equal(document.body.style.cursor, 'row-resize');
  s.moveResize({ pointerId: 1, clientY: 200 });
  assert.ok(Math.abs(s.splitRatio.value - 0.67) < 0.0001);
  s.moveResize({ pointerId: 1, clientY: 10000 });
  assert.equal(s.splitRatio.value, 0.8, 'leave at least 80px for the file tree');
  s.moveResize({ pointerId: 1, clientY: -10000 });
  assert.equal(s.splitRatio.value, 0.18, 'leave at least 72px for changes');
  s.finishResize();
  assert.equal(captured, false);
  assert.equal(document.body.style.cursor, 'auto');
  assert.equal(document.body.style.userSelect, '');
  assert.equal(storage.get('seed-pi-web-files-split'), '0.18');
  s.resizeKey({ key: 'End', preventDefault() {} });
  assert.equal(s.splitRatio.value, 0.8);
  s.resizeKey({ key: 'ArrowUp', preventDefault() {} });
  assert.equal(s.splitRatio.value, 0.77);
  s.setRatio(0.42, true);
  assert.equal(storage.get('seed-pi-web-files-split'), '0.42');
  s.filesOpen.value = false;
  await vue.nextTick();
  assert.equal(s.canResize.value, false);
});

test('floating panels dismiss outside clicks but not panel, toggle, menu or dialog interactions', async t => {
  const props = vue.reactive({ open: true });
  const { state: s, events } = await setup(t, 'FloatingPanel.vue', { props });
  for (const selector of ['.floating-panel', '.panel-btn', '.ctxmenu', '.modal-mask']) {
    s.onDown({ target: { closest: selectors => selectors.split(', ').includes(selector) } });
  }
  assert.equal(events.length, 0);
  s.onDown({ target: { closest: () => null } });
  assert.deepEqual(events, [['close']]);
  props.open = false;
  s.onDown({ target: { closest: () => null } });
  assert.equal(events.length, 1, 'hidden panels do not dismiss other UI');
  props.open = true;
  props.inline = true;
  s.onDown({ target: { closest: () => null } });
  assert.equal(events.length, 1, 'inline branches stay open while typing in the composer');
});

test('custom select aligns to trigger, focuses current choice, selects with keyboard and dismisses', async (t) => {
  const document = { activeElement: null };
  const props = vue.reactive({ modelValue: 'working', label: '对比范围', disabled: false, options: [
    { value: 'staged', label: '已暂存' }, { value: 'working', label: '未暂存' }, { value: 'head', label: '全部变更' },
  ] });
  const { state: s, events } = await setup(t, 'SelectMenu.vue', { document, props });
  const buttons = props.options.map((o) => ({
    focus() { document.activeElement = this; }, matches: (selector) => selector === '.select-option', click() { s.choose(o.value); },
  }));
  const trigger = { getBoundingClientRect: () => ({ left: 950, top: 100, bottom: 126 }), focus() { document.activeElement = trigger; } };
  s.trigger.value = trigger;
  s.panel.value = { offsetHeight: 150, offsetWidth: 220, querySelectorAll: () => buttons, contains: (el) => buttons.includes(el) };
  await s.open();
  assert.equal(s.opened.value, true);
  assert.equal(s.position.value.left, '772px', 'keep menu within the viewport');
  assert.equal(document.activeElement, buttons[1]);
  s.keydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(document.activeElement, buttons[2]);
  s.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(s.opened.value, false);
  assert.deepEqual(events, [['update:modelValue', 'head']]);
  assert.equal(document.activeElement, trigger);
  await s.open();
  s.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(s.opened.value, false);
  await s.open();
  props.disabled = true;
  await vue.nextTick();
  assert.equal(s.opened.value, false, 'hide teleported menu when its tab is no longer active');
});
