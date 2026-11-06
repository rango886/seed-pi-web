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
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
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

test('settings use flat grouped surfaces, no helper notes, collapsible previews and separate footer actions', async () => {
  const read = path => fs.readFile(new URL('../web/src/' + path, import.meta.url), 'utf8');
  const [source, app, side, settings] = await Promise.all([
    read('components/Settings.vue'), read('App.vue'), read('components/SidePanel.vue'), read('settings.js'),
  ]);
  const { descriptor, errors } = parse(source);
  assert.deepEqual(errors, []);
  const template = descriptor.template.content;
  assert.deepEqual([...template.matchAll(/<h3>(.*?)<\/h3>/g)].map(m => m[1]), ['外观', '布局', '文字', '使用习惯', '附件']);
  assert.doesNotMatch(template, /small-tip|class="dim tip"|（默认|下一轮接着|用户气泡自动/);
  assert.match(template, /<details class="text-preview">/);
  assert.doesNotMatch(template, /<details[^>]*\bopen\b/);
  const head = template.match(/<header[\s\S]*?<\/header>/)[0];
  assert.doesNotMatch(head, /exportSettings|resetSettings|fileInput.click/);
  const foot = template.match(/<footer[\s\S]*?<\/footer>/)[0];
  for (const action of ['exportSettings', 'fileInput.click()', 'resetSettings']) assert.ok(foot.includes(action));
  assert.match(source, /\.settings-drawer \{[^}]*background: var\(--panel\)/);
  assert.match(source, /section \+ section \{ border-top: 1px solid var\(--line\)/);
  assert.doesNotMatch(source.match(/\.card \{([^}]+)\}/)[1], /border|background|shadow/);
  assert.doesNotMatch(settings, /modern|现代/);
  assert.match(app, /--top-height: 36px/);
  assert.match(app, /\.top \{[^}]*min-height: var\(--top-height\)[^}]*padding: 4px 6px 4px 8px/);
  assert.match(side, /\.brand \{[^}]*padding: 10px var\(--side-gutter\)/);
});

test('composer drops the context ring for a pi-style bottom status bar; usage state still behaves', async (t) => {
  const source = await fs.readFile(new URL('../web/src/components/Composer.vue', import.meta.url), 'utf8');
  const app = await fs.readFile(new URL('../web/src/App.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /ref="contextChip"/, 'context ring removed from the input bar');
  assert.doesNotMatch(source, /class="chip cost"/, 'cost chip removed from the input bar');
  assert.doesNotMatch(source, /class="usage"|class="cwd ellipsis"/, 'status strip no longer lives in the composer');
  assert.match(app, /class="cwd ellipsis"/, 'cwd sits in the top bar');
  assert.match(app, /<TopStatus v-if="UI\.topStatus" \/>/, 'usage status sits in the top bar');
  assert.match(source, /placeholder="输入消息"/);
  const S = vue.reactive({ composer: { text: '', attachments: [], images: [] }, stats: null, statusItems: {}, starting: false });
  const actions = Object.fromEntries('submit stop allCommands toast setThinking setDefaultThinking compact showSessionInfo takeOver openFile attachPaths uploadFiles pasteFiles removeAttachment clearAttachments moveAttachment'.split(' ').map(name => [name, () => {}]));
  const { state: s } = await setup(t, 'Composer.vue', { imports: {
    '../store.js': { ...actions, S, BUILTINS: [], ORIGIN_LABEL: {}, openTerminal() {}, hasStatus: vue.computed(() => !!S.stats), contextUsage: vue.computed(() => S.stats?.contextUsage), otherAgents: vue.ref(0), viewer: vue.ref(false) },
    '../settings.js': { UI: {}, view: vue.reactive({ menu: null }), openMenu() {}, togglePanel() {} },
    '../api.js': { http: {}, rawUrl() {} },
    '../util.js': { fmtTokens: String, levelName: String, joinPath() {}, fmtSize: String },
  } });
  assert.equal(s.ctxPct.value, null, 'unknown usage is not zero');
  assert.equal(s.usageRows.value[0].text, '暂无可用用量数据');
  s.usageClick();
  assert.equal(s.menu.value, 'usage', 'usage popup still opens before stats arrive');
  s.usageLeave();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(s.menu.value, 'usage', 'click-pinned popup does not dismiss on mouse leave');
  s.usageClick();
  s.usageEnter();
  s.usageLeave();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(s.menu.value, null, 'hover popup closes within 80ms instead of the old 200ms delay');
  s.usageEnter();
  s.usageLeave();
  s.usageEnter();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(s.menu.value, 'usage', 'moving onto the popup cancels dismissal');
  s.usageClick();
  s.usageClick();
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

test('composer top edge resizes upward, clamps and resets without persisting height', async (t) => {
  const document = { body: { style: { cursor: 'auto', userSelect: '' } } };
  const storage = new Map([['seed-pi-web-composer-height', '220']]);
  const S = vue.reactive({ composer: { text: '', attachments: [], images: [] }, stats: null, statusItems: {} });
  const actions = Object.fromEntries('submit stop allCommands toast setThinking setDefaultThinking compact showSessionInfo takeOver openFile attachPaths uploadFiles pasteFiles removeAttachment clearAttachments moveAttachment'.split(' ').map(name => [name, () => {}]));
  const { state: s } = await setup(t, 'Composer.vue', { document, storage, imports: {
    '../store.js': { ...actions, S, BUILTINS: [], ORIGIN_LABEL: {}, openTerminal() {}, hasStatus: vue.ref(false), contextUsage: vue.ref(null), otherAgents: vue.ref(0), viewer: vue.ref(false) },
    '../settings.js': { UI: {}, view: vue.reactive({ menu: null }), openMenu() {}, togglePanel() {} },
    '../api.js': { http: {}, rawUrl() {} },
    '../util.js': { fmtTokens: String, levelName: String, joinPath() {}, fmtSize: String },
  } });
  const ta = { style: {}, scrollHeight: 80, offsetHeight: 220, getBoundingClientRect: () => ({ height: parseFloat(ta.style.height) || 220 }) };
  s.ta.value = ta;
  s.boxEl.value = { offsetHeight: 280 };
  s.autosize();
  assert.equal(s.manualHeight.value, 0, 'ignore previously saved height');
  assert.equal(ta.style.height, '80px', 'start with automatic height');
  let captured = false, focused = false;
  const el = { focus() { focused = true; }, setPointerCapture() { captured = true; }, hasPointerCapture() { return captured; }, releasePointerCapture() { captured = false; } };
  s.startComposerResize({ button: 0, currentTarget: el, pointerId: 1, clientY: 500 });
  assert.equal(focused, true);
  assert.equal(document.body.style.cursor, 'ns-resize');
  s.moveComposerResize({ pointerId: 2, clientY: 0 });
  assert.equal(s.manualHeight.value, 0, 'ignore other pointers');
  s.moveComposerResize({ pointerId: 1, clientY: 400 });
  assert.equal(s.manualHeight.value, 180, 'drag up to grow');
  assert.equal(ta.style.height, '180px');
  s.moveComposerResize({ pointerId: 1, clientY: -10000 });
  assert.equal(s.manualHeight.value, s.heightBounds().max);
  s.moveComposerResize({ pointerId: 1, clientY: 10000 });
  assert.equal(s.manualHeight.value, s.heightBounds().min);
  assert.equal(ta.style.overflowY, 'auto', 'small manual heights scroll long input');
  s.finishComposerResize();
  assert.equal(captured, false);
  assert.equal(s.resizing.value, false);
  assert.equal(document.body.style.cursor, 'auto');
  assert.equal(document.body.style.userSelect, '');
  assert.equal(storage.get('seed-pi-web-composer-height'), '220', 'dragging does not write height to storage');
  s.composerResizeKey({ key: 'End', preventDefault() {} });
  assert.equal(s.manualHeight.value, s.heightBounds().max);
  s.resetComposerHeight();
  assert.equal(s.manualHeight.value, 0);
  assert.equal(storage.get('seed-pi-web-composer-height'), '220', 'keyboard resizing and reset do not modify storage');
  assert.equal(ta.style.height, '80px', 'double click returns to content-driven height');
  ta.scrollHeight = 1000;
  s.autosize();
  assert.equal(ta.style.height, '320px', 'automatic height remains bounded');
  const source = await fs.readFile(new URL('../web/src/components/Composer.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /class="expand"|toggleBig|composer-big|seed-pi-web-composer-height/);
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) assert.ok(source.includes(`@${event}="finishComposerResize"`));
});

test('welcome uses the sidebar logo, aligned label-first shortcuts and current send-key setting', async (t) => {
  const source = await fs.readFile(new URL('../web/src/components/ChatView.vue', import.meta.url), 'utf8');
  const sidebar = await fs.readFile(new URL('../web/src/components/SidePanel.vue', import.meta.url), 'utf8');
  const welcome = source.slice(source.indexOf('class="welcome"'), source.indexOf('v-for="(m, i)'));
  assert.match(welcome, /<Icon name="pi"/);
  assert.match(sidebar, /class="logo"[^>]*><Icon name="pi"/);
  assert.doesNotMatch(welcome, /S\.cwd|wcwd|π|粘贴图片|侧栏文件点/);
  assert.match(welcome, /<span>\{\{ label \}\}<\/span><kbd>\{\{ key \}\}<\/kbd>/);
  assert.match(source, /\.tip \{[^}]*grid-template-columns: minmax\(0, 1fr\) max-content/);
  const kbd = source.match(/kbd \{([^}]+)\}/)[1];
  assert.doesNotMatch(kbd, /border|background|padding/);
  const UI = vue.reactive({ sendKey: 'enter' });
  const { state: s } = await setup(t, 'ChatView.vue', { imports: {
    '../store.js': { S: vue.reactive({ messages: [], tick: 0 }), openDirPicker() {}, restartExited() {}, viewer: vue.ref(false) },
    '../settings.js': { UI, view: {}, openLightbox() {} },
    '../util.js': { splitAttachments() {} },
  } });
  const rows = () => s.shortcutGroups.value.flatMap(group => group.rows);
  const keys = rows().map(([key]) => key);
  for (const key of ['Enter', 'Shift+Enter', 'Alt+Enter', 'Alt+N', 'Alt+Shift+N', '/', '!', '!!', '@', 'Ctrl+V', 'Ctrl+P', 'Ctrl+L', 'Ctrl+B', 'Ctrl+E', 'Ctrl+`', 'Ctrl+,', 'Esc', 'Home / End', 'Ctrl+Home / Ctrl+End', 'Tab / →', '0']) {
    assert.ok(keys.includes(key), 'documented shortcut: ' + key);
  }
  UI.sendKey = 'ctrlEnter';
  assert.equal(rows()[0][0], 'Ctrl+Enter');
  assert.equal(rows()[1][0], 'Enter');
  assert.equal(rows()[1][1], '换行');
  assert.equal(s.shortcutsOpen.value, false, 'shortcuts are collapsed by default');
  assert.match(welcome, /<button[^>]*class="big"[^>]*:aria-expanded="shortcutsOpen"[^>]*@click="shortcutsOpen = !shortcutsOpen"><Icon name="pi"/);
  assert.doesNotMatch(source, /shortcuts-toggle/);
  assert.match(welcome, /<div v-if="shortcutsOpen" id="welcome-shortcuts" class="tips">/);
  assert.match(source, /\.welcome \{[^}]*padding: 32px 0;[^}]*justify-content: center/);
  assert.match(source, /\.welcome \.big \{[^}]*border: 0;[^}]*cursor: pointer/);
});

test('sidebar directory trigger opens the full picker directly, while the icon keeps its quick menu', async (t) => {
  const calls = [];
  const props = vue.reactive({ variant: 'side', mode: 'new' });
  let requests = 0;
  const { state: s, events } = await setup(t, 'DirectoryMenu.vue', { props, imports: {
    '../store.js': { S: vue.reactive({ cwd: '/repo', favorites: [] }), newSessionIn() {}, chooseDirectory() {}, openDirPicker: mode => calls.push(mode) },
    '../api.js': { http: { get: async () => { requests++; return []; } } },
    '../util.js': { baseName: String, normPath: String },
  } });
  s.toggle();
  assert.deepEqual(calls, ['new']);
  assert.deepEqual(events, [['select']], 'close the sidebar drawer when the picker opens');
  assert.equal(s.opened.value, false, 'do not flash the quick menu');
  assert.equal(requests, 0, 'the picker loads its own recent directories');
  props.variant = 'icon';
  await s.open();
  assert.equal(s.opened.value, true, 'top bar keeps the quick menu');
  assert.equal(requests, 1);
});

test('directory picker has folder icons and ordered actions next to the path input', async () => {
  const source = await fs.readFile(new URL('../web/src/components/DirPicker.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const walk = function* (node) {
    yield node;
    for (const child of node.children || []) yield* walk(child);
  };
  const nodes = [...walk(descriptor.template.ast)];
  const hasClass = (node, name) => node.props?.some(p => p.name === 'class' && p.value?.content.split(' ').includes(name));
  const top = nodes.find(node => hasClass(node, 'top'));
  const buttons = top.children.filter(node => node.tag === 'button');
  assert.deepEqual(buttons.map(node => node.children[0].content), ['创建', '新标签']);
  assert.deepEqual(buttons.map(node => node.props.find(p => p.name === 'on' && p.arg.content === 'click').exp.content), ['openCurrent', 'newTab']);
  assert.ok(top.children.some(node => hasClass(node, 'pathbox')));
  assert.ok(!nodes.some(node => hasClass(node, 'modal-foot')), 'no duplicate footer actions');
  const rows = nodes.filter(node => hasClass(node, 'item'));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const children = row.children.filter(node => node.type === 1);
    assert.equal(children[0].tag, 'Icon');
    assert.ok(children[0].props.some(p => p.name === 'name' && p.value?.content === 'folder'));
    assert.ok(hasClass(children[1], 'path'), 'folder icon sits immediately before each path');
  }
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

test('file panel omits the cwd row while preserving root directory actions on its background', async (t) => {
  const S = vue.reactive({ cwd: '/repo', tabs: [], terms: [] });
  const menus = [], favorites = [], downloads = [];
  const { state: s } = await setup(t, 'RightPanel.vue', { imports: {
    '../store.js': { S, openSession() {}, sessionStatus() {}, isFav: () => false, toggleFavorite: path => favorites.push(path), killAgent() {} },
    '../settings.js': { view: vue.reactive({ panel: 'files' }), openMenu: (...args) => menus.push(args) },
    '../git.js': { G: vue.reactive({ cwd: '/repo', data: { available: true } }) },
    '../file-download.js': { downloadPath: (...args) => downloads.push(args), packing: new Set() },
  } });
  s.cwdMenu({ clientX: 10, clientY: 20 });
  assert.equal(menus.length, 1);
  assert.deepEqual(menus[0].slice(0, 2), [10, 20]);
  const items = menus[0][2];
  assert.deepEqual(Array.from(items, item => item.label), ['收藏这个目录', '复制路径', '下载整个目录（ZIP）']);
  items[0].run();
  items[2].run();
  assert.deepEqual(favorites, ['/repo']);
  assert.deepEqual(downloads, [['/repo', true]]);
  S.cwd = '';
  s.cwdMenu({ clientX: 10, clientY: 20 });
  assert.equal(menus.length, 1, 'no directory actions without a cwd');
  const source = await fs.readFile(new URL('../web/src/components/RightPanel.vue', import.meta.url), 'utf8');
  const template = parse(source).descriptor.template.content;
  assert.doesNotMatch(template, /\{\{ S\.cwd \}\}/);
  assert.match(template, /v-show="view.panel === 'files'" class="pane" @contextmenu.prevent.stop="cwdMenu\(\$event\)"/);
});

test('file panel and Git tree share the toolbar branch icon and standard line icons and chevrons', async () => {
  const read = path => fs.readFile(new URL('../web/src/' + path, import.meta.url), 'utf8');
  const [app, panel, git, tree, picker] = await Promise.all([
    read('App.vue'), read('components/RightPanel.vue'), read('components/GitChanges.vue'),
    read('components/TreeNode.vue'), read('components/DirTreeNode.vue'),
  ]);
  assert.match(app, /title="对话分支 \(\/tree\)"[^\n]+<Icon name="branching"/);
  assert.match(panel, /:icon="view.panel === 'files' \? 'branching' : 'cpu'"/);
  assert.match(git, /class="branch-symbol" name="branching" :size="16"/);
  for (const source of [panel, git, tree, picker]) {
    assert.match(source, /name="chevron" :size="14"/);
    assert.doesNotMatch(parse(source).descriptor.template.content, /[▸▾]|<svg/);
    assert.match(source, /\.open \{ transform: rotate\(90deg\); \}/);
  }
  assert.match(tree, /:name="iconOf\(entry.name, entry.dir\)" :size="16"/);
  assert.match(git, /:name="iconOf\(row.entry.path\)" :size="16"/);
  assert.match(git, /v-if="tree" class="fold-spacer" aria-hidden="true"/);
  assert.match(picker, /name="folder" :size="16"/);
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
