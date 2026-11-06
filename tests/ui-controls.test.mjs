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
  const context = vm.createContext({ console, document, setTimeout, clearTimeout,
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

test('composer context ring stays visible without stats and updates when usage arrives', async (t) => {
  const source = await fs.readFile(new URL('../web/src/components/Composer.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const findRing = (nodes, ancestors = []) => {
    for (const node of nodes) {
      if (node.props?.some(p => p.name === 'ref' && p.value?.content === 'ringChip')) return [...ancestors, node];
      const found = findRing(node.children || [], [...ancestors, node]);
      if (found) return found;
    }
  };
  const path = findRing(descriptor.template.ast.children);
  assert.ok(path, 'context ring exists');
  for (const node of path) {
    assert.ok(!node.props?.some(p => p.type === 7 && ['if', 'else-if', 'else', 'show'].includes(p.name)), 'ring must not depend on stats or session state');
  }

  const S = vue.reactive({ composer: { text: '', attachments: [], images: [] }, stats: null, statusItems: {}, starting: false });
  const actions = Object.fromEntries('submit stop allCommands toast setThinking setDefaultThinking compact showSessionInfo takeOver openFile attachPaths uploadFiles pasteFiles removeAttachment clearAttachments moveAttachment'.split(' ').map(name => [name, () => {}]));
  const { state: s } = await setup(t, 'Composer.vue', { imports: {
    '../store.js': { ...actions, S, BUILTINS: [], ORIGIN_LABEL: {}, hasStatus: vue.computed(() => !!S.stats), contextUsage: vue.computed(() => S.stats?.contextUsage), otherAgents: vue.ref(0), viewer: vue.ref(false) },
    '../settings.js': { UI: {}, view: vue.reactive({ menu: null }), openMenu() {} },
    '../api.js': { http: {}, rawUrl() {} },
    '../util.js': { fmtTokens: String, levelName: String, joinPath() {}, fmtSize: String },
  } });
  assert.equal(s.ctxPct.value, null, 'unknown usage is not zero');
  assert.equal(s.usageRows.value[0].text, '暂无可用用量数据');
  s.usageClick();
  assert.equal(s.menu.value, 'usage', 'usage popup still opens before stats arrive');
  S.stats = { tokens: { input: 10, output: 5 } };
  assert.equal(s.usageRows.value[0].text, '暂无可用用量数据', 'totals alone do not establish current context');
  S.stats.contextUsage = { tokens: 0, contextWindow: 1000, percent: 0 };
  assert.equal(s.pctText.value, '0%');
  S.stats.contextUsage = { tokens: 750, contextWindow: 1000, percent: 75 };
  assert.equal(s.pctText.value, '75%');
  assert.equal(s.ctxLevel.value, 'warn');
  assert.match(s.usageRows.value[0].text, /750 \/ 1000/);
  S.stats.contextUsage.estimated = true;
  assert.equal(s.pctText.value, '75%', 'estimation details belong in the popup, not the compact percentage');
  assert.match(s.usageRows.value[1].text, /估算/);
  S.stats.contextUsage = { tokens: null, percent: null, contextWindow: 1000 };
  assert.equal(s.pctText.value, '—', 'null runtime usage is not 0% or a bogus token count');
  assert.equal(s.usageRows.value[0].text, '暂无可用用量数据');
  S.stats = null;
  assert.equal(s.ctxPct.value, null, 'switching to a session without stats clears old usage');
  assert.equal(s.usageRows.value[0].text, '暂无可用用量数据');
});

test('empty composer send button matches toolbar borders and surfaces in every theme', async () => {
  const read = path => fs.readFile(new URL('../web/src/' + path, import.meta.url), 'utf8');
  const [composer, github, pi] = await Promise.all([read('components/Composer.vue'), read('github.css'), read('pi.css')]);
  const disabled = composer.match(/\.send:disabled \{([^}]+)\}/)[1];
  assert.match(disabled, /border: 1px solid var\(--line\)/);
  assert.match(disabled, /background: var\(--panel-2\)/);
  assert.match(disabled, /color: var\(--text-2\)/);
  assert.match(composer, /:disabled="disabled \|\| !hasInput"/, 'empty input still cannot submit');
  const githubDisabled = github.match(/\.send:disabled \{([^}]+)\}/)[1];
  assert.match(githubDisabled, /background: var\(--gh-btn\)/);
  assert.match(githubDisabled, /border-color: var\(--line\)/);
  assert.match(githubDisabled, /color: var\(--text-2\)/);
  const piDisabled = pi.match(/\.send:disabled \{([^}]+)\}/)[1];
  assert.match(piDisabled, /background: transparent/);
  assert.match(piDisabled, /border-color: var\(--pi-dim\)/);
  assert.match(piDisabled, /color: var\(--pi-muted\)/);
});

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

test('toast dismissal only removes the selected notice, including keyboard-accessible close controls', async (t) => {
  const S = vue.reactive({ toasts: [{ id: 1, text: 'first' }, { id: 2, text: 'second' }, { id: 3, text: 'third' }] });
  const { state: s } = await setup(t, 'Toasts.vue', { imports: { '../store.js': { S } } });
  s.dismiss(2);
  assert.deepEqual(S.toasts.map((notice) => notice.id), [1, 3]);
  s.dismiss(999);
  assert.equal(S.toasts.length, 2);
  const source = await fs.readFile(new URL('../web/src/components/Toasts.vue', import.meta.url), 'utf8');
  assert.match(source, /<TransitionGroup name="notice" tag="div" class="toasts"/);
  assert.match(source, /:role="t.kind === 'error' \? 'alert' : 'status'"/);
  assert.match(source, /aria-atomic="true"/);
  assert.match(source, /<button type="button" class="toast-close"[^>]*aria-label="关闭通知"[^>]*@click.stop="dismiss\(t.id\)"/);
});

test('toast stack sits below the top-right toolbar, fits small viewports and uses theme tokens', async () => {
  const source = await fs.readFile(new URL('../web/src/components/Toasts.vue', import.meta.url), 'utf8');
  const pi = await fs.readFile(new URL('../web/src/pi.css', import.meta.url), 'utf8');
  const stack = source.match(/\.toasts \{([^}]+)\}/)[1];
  const card = source.match(/\.toast \{([^}]+)\}/)[1];
  assert.match(stack, /position: fixed/);
  assert.match(stack, /top: calc\(56px \+ env\(safe-area-inset-top, 0px\)\)/);
  assert.match(stack, /right: calc\(16px \+ env\(safe-area-inset-right, 0px\)\)/);
  assert.doesNotMatch(stack, /(?:^|;)\s*bottom:/);
  assert.match(stack, /width: min\(380px, calc\(100vw - 32px/);
  assert.match(stack, /max-height: calc\(100dvh/);
  assert.match(stack, /overflow-x: hidden/, 'horizontal slide transitions must not flash a bottom scrollbar');
  assert.match(stack, /overflow-y: auto/, 'long notification stacks must remain vertically scrollable');
  assert.match(stack, /pointer-events: none/);
  for (const token of ['--elev', '--text', '--line', '--r-md', '--shadow', '--font', '--fs-sm']) {
    assert.ok(card.includes(`var(${token})`), token);
  }
  assert.match(card, /pointer-events: auto/);
  assert.doesNotMatch(card, /border-left:/, 'use the same clean card borders as the rest of the UI');
  assert.match(source, /\.toast.error \{ --notice-color: var\(--err\)/);
  assert.match(source, /\.toast.warning \{ --notice-color: var\(--warn\)/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(pi, /:root\[data-ui='pi'\] \.toast,/);
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
