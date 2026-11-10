import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import * as vue from 'vue';
import { parse, compileScript } from 'vue/compiler-sfc';
import * as preferences from '../web/src/session-list.js';

function storageOf(entries = []) {
  const data = new Map(entries);
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), data };
}

test('three views default to unarchived, migrate old preferences, and persist independently', () => {
  const storage = storageOf([
    ['seed-pi-web-sort', 'name'], ['seed-pi-web-session-layout-all', 'group'],
    ['seed-pi-web-dir-label-fav', 'path'], ['seed-pi-web-collapsed-dirs-fav', '["/repo"]'],
  ]);
  const { readSessionView: read, saveSessionView: save } = preferences;
  for (const mode of ['all', 'dir', 'fav']) {
    const ui = read(storage, mode);
    assert.equal(ui.archive, 'active');
    assert.equal(ui.sort, 'name');
    assert.equal(ui.showCount, true);
    assert.equal(ui.showTime, true);
    assert.equal(ui.showPath, true);
  }
  assert.equal(read(storage, 'all').layout, 'group');
  assert.equal(read(storage, 'fav').dirLabel, 'path');
  assert.deepEqual(read(storage, 'fav').collapsed, ['/repo']);
  save(storage, 'all', { ...read(storage, 'all'), sort: 'time', archive: 'archived', showTime: false, showPath: false, collapsed: ['/other'] });
  assert.equal(read(storage, 'all').archive, 'archived');
  assert.equal(read(storage, 'all').showTime, false);
  assert.equal(read(storage, 'all').showPath, false);
  for (const mode of ['dir', 'fav']) {
    assert.equal(read(storage, mode).archive, 'active');
    assert.equal(read(storage, mode).sort, 'name');
    assert.equal(read(storage, mode).showTime, true);
    assert.equal(read(storage, mode).showPath, true);
  }
  save(storage, 'dir', { ...read(storage, 'dir'), archive: 'all', showCount: false });
  assert.equal(read(storage, 'dir').archive, 'all');
  assert.equal(read(storage, 'dir').showCount, false);
  assert.equal(read(storage, 'fav').showCount, true);
  for (const invalid of ['broken', 'null', '[]', '{"collapsed":true,"archive":"invalid"}']) {
    storage.setItem('seed-pi-web-session-view-all', invalid);
    assert.equal(read(storage, 'all').archive, 'active');
    assert.deepEqual(read(storage, 'all').collapsed, []);
  }
});

test('archive filtering treats legacy/unsaved sessions as active; count and time have independent separators', () => {
  const { matchesArchive, matchesStar, sessionInfo } = preferences;
  const list = [{ file: 'old' }, { file: 'archived', archived: true }, { file: 'new', unsaved: true }];
  assert.deepEqual(list.filter((s) => matchesArchive(s, 'active')).map((s) => s.file), ['old', 'new']);
  assert.deepEqual(list.filter((s) => matchesArchive(s, 'archived')).map((s) => s.file), ['archived']);
  assert.equal(list.filter((s) => matchesArchive(s, 'all')).length, 3);
  const starred = [{ file: 'plain' }, { file: 'star', starred: true }, { file: 'both', starred: true, archived: true }];
  assert.equal(starred.filter((s) => matchesStar(s, 'all')).length, 3);
  assert.deepEqual(starred.filter((s) => matchesStar(s, 'starred') && matchesArchive(s, 'active')).map((s) => s.file), ['star']);
  assert.deepEqual(starred.filter((s) => matchesStar(s, 'starred') && matchesArchive(s, 'all')).map((s) => s.file), ['star', 'both']);
  assert.equal(preferences.readSessionView(storageOf(), 'all').star, 'all');
  const s = { messages: 0, modified: 'today' };
  assert.equal(sessionInfo(s, { showCount: true, showTime: true }, () => '12:30'), '0 条 · 12:30');
  assert.equal(sessionInfo(s, { showCount: true, showTime: false }, () => '12:30'), '0 条');
  assert.equal(sessionInfo(s, { showCount: false, showTime: true }, () => '12:30'), '12:30');
  assert.equal(sessionInfo(s, { showCount: false, showTime: false }, () => '12:30'), '');
  assert.equal(sessionInfo({ unsaved: true }, {}, () => ''), '未保存');
});

async function setup(t, file, { props = {}, imports = {}, storage = storageOf(), document = {}, timers = { setTimeout, clearTimeout } } = {}) {
  const source = await fs.readFile(new URL('../web/src/components/' + file, import.meta.url), 'utf8');
  const code = compileScript(parse(source).descriptor, { id: 'test' }).content;
  const noop = () => {};
  const context = vm.createContext({ console, document, localStorage: storage, ...timers,
    window: { innerWidth: 1000, innerHeight: 800, addEventListener: noop, removeEventListener: noop },
  });
  const mod = new vm.SourceTextModule(code, { context });
  await mod.link(async (name) => {
    const values = name === 'vue' ? { ...vue, onMounted: noop, onUnmounted: noop }
      : name.endsWith('.vue') ? { default: {} } : name === '../session-list.js' ? preferences : imports[name];
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

test('sidebar switches independent settings and intersects mode, archive and search filters before grouping', async (t) => {
  const now = new Date().toISOString();
  const S = vue.reactive({ sessionMode: 'all', cwd: '/repo', favorites: ['/repo'], agents: [], sessions: [
    { file: 'a', title: 'Zebra', cwd: '/repo', modified: now, messages: 2 },
    { file: 'b', title: 'Alpha', cwd: '/repo', modified: now, messages: 3, archived: true },
    { file: 'c', title: 'Other', cwd: '/other', modified: now, messages: 1 },
  ] });
  const storage = storageOf();
  let menu;
  const actions = [];
  const { state: s } = await setup(t, 'SidePanel.vue', { storage, imports: {
    '../store.js': { S, openSession() {}, newSession() {}, newSessionIn() {}, newTempSession() {}, deleteSession: (...args) => actions.push(args), setSessionArchived: (...args) => actions.push(args), setSessionStarred: (...args) => actions.push(['star', ...args]), dirAllArchived: () => false, setDirArchived: (...args) => actions.push(['dir-archive', ...args]), deleteDirSessions: (...args) => actions.push(['dir-delete', ...args]), renameSession() {}, sessionStatus() {}, setSessionMode() {}, isFav: (cwd) => S.favorites.includes(cwd) },
    '../settings.js': { UI: {}, view: vue.reactive({}), toggleSide() {}, closeDrawer() {}, openMenu(x, y, items) { menu = items; } },
  } });
  const files = () => s.groups.value.flatMap((g) => g.items.map((row) => row.file));
  assert.deepEqual([...files()], ['a', 'c']);
  s.saveSorting({ sort: 'name' });
  assert.equal(s.showSessionPath.value, true);
  s.saveUI({ archive: 'all', showCount: false, dirLabel: 'path', showPath: false });
  assert.equal(s.showSessionPath.value, false);
  assert.equal(s.sortBy.value, 'name');
  assert.deepEqual([...files()], ['b', 'c', 'a']);
  S.sessionMode = 'fav';
  assert.equal(s.sortBy.value, 'time');
  assert.equal(s.cur.value.archive, 'active');
  assert.equal(s.cur.value.showCount, true);
  assert.equal(s.byDir.value, true);
  assert.equal(s.cur.value.showPath, true);
  assert.equal(s.showSessionPath.value, false, 'directory headers remain separate from row information');
  s.saveUI({ layout: 'flat' });
  assert.equal(s.showSessionPath.value, true, 'favorites keep their own path visibility');
  s.saveUI({ layout: 'group' });
  assert.deepEqual([...files()], ['a']);
  s.saveUI({ archive: 'archived' });
  assert.deepEqual([...files()], ['b']);
  s.toggleDir('/repo');
  assert.equal(s.isCollapsed('/repo'), true);
  S.sessionMode = 'dir';
  assert.equal(s.cur.value.archive, 'active');
  assert.equal(s.byDir.value, false);
  assert.equal(s.flat.value, false);
  assert.equal(s.showSessionPath.value, false);
  assert.deepEqual([...files()], ['a']);
  s.saveUI({ archive: 'all', showTime: false });
  s.q.value = 'alpha repo';
  assert.deepEqual([...files()], ['b']);
  s.q.value = '';
  S.sessionMode = 'all';
  assert.equal(s.sortBy.value, 'name');
  assert.equal(s.cur.value.showCount, false);
  assert.equal(s.cur.value.showTime, true);
  assert.equal(s.isCollapsed('/repo'), false);
  assert.equal(s.cur.value.dirLabel, 'path');
  assert.equal(s.showSessionPath.value, false, 'all restores its hidden path without changing the path format');
  assert.equal(preferences.readSessionView(storage, 'all').showPath, false);
  s.saveUI({ showPath: true });
  assert.equal(s.showSessionPath.value, true);
  S.sessions[0].archived = true;
  S.sessionMode = 'dir';
  s.saveUI({ archive: 'active' });
  assert.deepEqual([...files()], []);
  assert.match(s.emptyText.value, /未归档/);
  s.saveUI({ archive: 'archived' });
  assert.deepEqual([...files()].sort(), ['a', 'b']);
  s.sessionMenu({ clientX: 0, clientY: 0 }, S.sessions[0]);
  menu.find((it) => it.label === '取消归档').run();
  assert.equal(actions[0][1], false);
  const click = { ctrlKey: true };
  menu.find((it) => it.label === '删除').run(click);
  assert.equal(actions[1][0], S.sessions[0]);
  assert.equal(actions[1][1], click, 'delete uses modifiers from the menu click, not the original right click');
  assert.ok(!menu.some((it) => it.label === '显示模式'), 'current directory has no layout menu');
  assert.equal(preferences.readSessionView(storage, 'all').showCount, false);
  assert.equal(preferences.readSessionView(storage, 'fav').archive, 'archived');
});

test('star filter intersects archive filter, explains hidden archived stars, and toggles from the session menu', async (t) => {
  const now = new Date().toISOString();
  const S = vue.reactive({ sessionMode: 'dir', cwd: '/repo', favorites: [], agents: [], sessions: [
    { file: 'a', title: 'A', cwd: '/repo', modified: now, messages: 1 },
    { file: 'b', title: 'B', cwd: '/repo', modified: now, messages: 1, starred: true, archived: true },
  ] });
  let menu;
  const actions = [];
  const { state: s } = await setup(t, 'SidePanel.vue', { storage: storageOf(), imports: {
    '../store.js': { S, openSession() {}, newSession() {}, newSessionIn() {}, newTempSession() {}, deleteSession() {}, setSessionArchived() {}, setSessionStarred: (...args) => actions.push(args), dirAllArchived: () => false, setDirArchived() {}, deleteDirSessions() {}, renameSession() {}, sessionStatus() {}, setSessionMode() {}, isFav: () => false },
    '../settings.js': { UI: {}, view: vue.reactive({}), toggleSide() {}, closeDrawer() {}, openMenu(x, y, items) { menu = items; } },
  } });
  const files = () => s.groups.value.flatMap((g) => g.items.map((row) => row.file));
  s.saveUI({ star: 'starred' });
  assert.deepEqual([...files()], []);
  assert.match(s.emptyText.value, /都已归档/);
  s.saveUI({ archive: 'all' });
  assert.deepEqual([...files()], ['b']);
  s.sessionMenu({ clientX: 0, clientY: 0 }, S.sessions[0]);
  menu.find((it) => it.label === '加星标').run();
  assert.deepEqual(actions[0], [S.sessions[0], true]);
  s.sessionMenu({ clientX: 0, clientY: 0 }, S.sessions[1]);
  assert.ok(menu.some((it) => it.label === '取消星标'));
});

test('sidebar compensates for actual scrollbar width, including overlay scrollbars', async (t) => {
  const { state: s } = await setup(t, 'SidePanel.vue', { imports: {
    '../store.js': { S: {}, openSession() {}, newSession() {}, newSessionIn() {}, newTempSession() {}, deleteSession() {}, setSessionArchived() {}, setSessionStarred() {}, dirAllArchived: () => false, setDirArchived() {}, deleteDirSessions() {}, renameSession() {}, sessionStatus() {}, setSessionMode() {}, isFav() {} },
    '../settings.js': { UI: {}, view: {}, toggleSide() {}, closeDrawer() {}, openMenu() {} },
  } });
  for (const width of [10, 8, 0, 10]) {
    s.listElement.value = { offsetWidth: 272, clientWidth: 272 - width };
    s.syncListGutter();
    assert.equal(s.listScrollbarWidth.value, width);
    const rightPadding = Math.max(0, 12 - s.listScrollbarWidth.value);
    assert.equal(rightPadding + width, 12, 'scrollbar and padding share the same gutter');
  }
  s.listElement.value = null;
  s.syncListGutter();
  const source = await fs.readFile(new URL('../web/src/components/SidePanel.vue', import.meta.url), 'utf8');
  assert.match(source, /scrollbar-gutter: stable/);
  assert.match(source, /calc\(var\(--side-gutter\) - var\(--list-scrollbar-width, 0px\)\)/);
  assert.match(source, /ref="listElement" class="list"/);
});

test('sidebar scrolling reveals the thumb and resets its idle timeout without changing its gutter', async (t) => {
  const pending = new Map();
  let nextId = 0;
  const { state: s } = await setup(t, 'SidePanel.vue', { timers: {
    setTimeout(callback, ms) { const id = ++nextId; pending.set(id, { callback, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
  }, imports: {
    '../store.js': { S: {}, openSession() {}, newSession() {}, newSessionIn() {}, newTempSession() {}, deleteSession() {}, setSessionArchived() {}, setSessionStarred() {}, dirAllArchived: () => false, setDirArchived() {}, deleteDirSessions() {}, renameSession() {}, sessionStatus() {}, setSessionMode() {}, isFav() {} },
    '../settings.js': { UI: {}, view: {}, toggleSide() {}, closeDrawer() {}, openMenu() {} },
  } });
  assert.equal(s.listScrolling.value, false);
  s.listElement.value = { offsetWidth: 272, clientWidth: 262 };
  s.syncListGutter();
  s.onListScroll();
  assert.equal(s.listScrolling.value, true);
  assert.equal(pending.size, 1);
  const firstId = nextId;
  s.onListScroll();
  assert.equal(pending.has(firstId), false, 'continued scrolling cancels the old hide timer');
  assert.equal(pending.size, 1);
  const timer = pending.get(nextId);
  assert.equal(timer.ms, 800);
  timer.callback();
  assert.equal(s.listScrolling.value, false);
  assert.equal(s.listScrollbarWidth.value, 10, 'hiding the thumb must not resize the scrollbar gutter');
});

test('sidebar hides only the thumb at rest and shows it for hover, scrolling and keyboard focus', async () => {
  const source = await fs.readFile(new URL('../web/src/components/SidePanel.vue', import.meta.url), 'utf8');
  assert.match(source, /\.list \{ --list-scroll-thumb: transparent/);
  assert.match(source, /\.list:is\(:hover, \.scrolling, :focus-visible, :has\(:focus-visible\)\)/);
  assert.match(source, /\.list::-webkit-scrollbar-thumb \{ background-color: var\(--list-scroll-thumb\)/);
  assert.match(source, /@supports not selector\(::-webkit-scrollbar\)/);
  assert.match(source, /scrollbar-color: var\(--list-scroll-thumb\) transparent/);
  assert.doesNotMatch(source, /scrollbar-width: none|::-webkit-scrollbar\s*\{[^}]*width:\s*0/);
  assert.match(source, /:class="\{ scrolling: listScrolling \}"/);
  assert.match(source, /@scroll.passive="onListScroll"/);
  assert.match(source, /onUnmounted\(\(\) => \{[^}]*clearTimeout\(scrollHideTimer\)/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /forced-colors: active/);
});

test('sidebar header shares the search and list gutters and uses a font-independent centered pi mark', async () => {
  const source = await fs.readFile(new URL('../web/src/components/SidePanel.vue', import.meta.url), 'utf8');
  const icons = await fs.readFile(new URL('../web/src/components/Icon.vue', import.meta.url), 'utf8');
  const brand = source.match(/\.brand \{([^}]+)\}/)[1];
  const logo = source.match(/\.logo \{([^}]+)\}/)[1];
  const toggle = source.match(/\.brand > \.ib \{([^}]+)\}/)[1];
  assert.match(brand, /padding: 10px var\(--side-gutter\);/);
  assert.doesNotMatch(brand, /--side-inset/);
  assert.match(source, /\.search \{[^}]*margin: 0 var\(--side-gutter\) 8px/);
  for (const rule of [logo, toggle]) {
    assert.match(rule, /width: 28px; height: 28px;/);
  }
  assert.match(toggle, /padding: 0;/);
  assert.match(logo, /align-items: center; justify-content: center; flex: none/);
  assert.doesNotMatch(logo, /font-/);
  assert.match(source, /<span class="logo" role="img" aria-label="pi"><Icon name="pi" :size="18" aria-hidden="true" \/><\/span>/);
  assert.doesNotMatch(source, /class="name"|\.name \{/);
  assert.match(icons, /pi: 'M4 6h16M8 6 7 18M16 6v9c0 2 1 3 3 3h1'/);
});

test('display dropdown hides directory-only options, emits patches, stays open and supports keyboard dismissal', async (t) => {
  const props = vue.reactive({ mode: 'all', settings: preferences.readSessionView(storageOf(), 'all') });
  const document = { activeElement: null };
  const { state: s, events } = await setup(t, 'SessionDisplayMenu.vue', { props, document });
  assert.equal(s.sections.value.length, 6);
  const scope = s.sections.value[0];
  assert.equal(scope.label, '会话范围');
  assert.deepEqual([...scope.options.map((option) => option.value)], ['all', 'dir', 'fav']);
  assert.equal(s.checked(scope, scope.options[0]), true);
  assert.equal(s.checked(scope, scope.options[1]), false);
  const allInfo = s.sections.value.find((section) => section.label === '会话信息');
  const pathOption = allInfo.options.find((option) => option.key === 'showPath');
  assert.ok(pathOption);
  assert.equal(s.checked(allInfo, pathOption), true);
  s.choose(allInfo, pathOption);
  assert.equal(events.pop()[1].showPath, false);
  props.mode = 'dir';
  await vue.nextTick();
  assert.deepEqual([...s.sections.value.map((section) => section.label)], ['会话范围', '归档筛选', '星标筛选', '会话信息']);
  assert.ok(!s.sections.value.at(-1).options.some((option) => option.key === 'showPath'));
  const buttons = Array.from({ length: 5 }, () => ({ focus() { document.activeElement = this; } }));
  const trigger = { getBoundingClientRect: () => ({ right: 990, top: 100, bottom: 126 }), focus() { document.activeElement = trigger; }, contains: () => false };
  s.trigger.value = trigger;
  s.panel.value = { offsetWidth: 216, offsetHeight: 220, querySelectorAll: () => buttons, querySelector: () => buttons[0], contains: (el) => buttons.includes(el) };
  await s.open();
  assert.equal(s.opened.value, true);
  assert.equal(s.position.value.right, '10px');
  assert.equal(s.position.value.maxWidth, '982px');
  assert.equal(s.position.value.left, undefined, 'anchor the right edge independently of the measured menu width');
  assert.equal(document.activeElement, buttons[0]);
  s.keydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(document.activeElement, buttons[1]);
  s.keydown({ key: 'End', preventDefault() {} });
  assert.equal(document.activeElement, buttons[4]);
  const archive = s.sections.value.find((section) => section.key === 'archive');
  s.choose(archive, archive.options[1]);
  assert.equal(events[0][0], 'change');
  assert.equal(events[0][1].archive, 'archived');
  assert.equal(s.opened.value, true, 'keep open for changing several settings');
  const info = s.sections.value.find((section) => section.label === '会话信息');
  s.choose(info, info.options[0]);
  assert.equal(events[1][1].showCount, false);
  props.settings.archive = 'archived';
  s.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(s.opened.value, false);
  assert.equal(document.activeElement, trigger);
  await s.open();
  props.mode = 'fav';
  await vue.nextTick();
  assert.equal(s.opened.value, false, 'switching mode dismisses the previous settings menu');
  assert.equal(s.sections.value.length, 6);
  assert.ok(s.sections.value.at(-1).options.some((option) => option.key === 'showPath'));
  await s.open();
  const scopeAfterSwitch = s.sections.value[0];
  assert.equal(s.checked(scopeAfterSwitch, scopeAfterSwitch.options[2]), true);
  s.choose(scopeAfterSwitch, scopeAfterSwitch.options[0]);
  const modeEvent = events.pop();
  assert.equal(modeEvent[0], 'mode-change');
  assert.equal(modeEvent[1], 'all');
  assert.equal(s.opened.value, false);
  assert.equal(document.activeElement, trigger, 'scope selection returns focus to the trigger');
  await s.open();
  s.outside({ target: {} });
  assert.equal(s.opened.value, false);
  trigger.getBoundingClientRect = () => ({ right: 208.5, top: 100, bottom: 126 });
  await s.open();
  assert.equal(s.position.value.right, '791.5px');
  assert.equal(s.position.value.maxWidth, '200.5px', 'a narrow sidebar shrinks the menu instead of shifting its right edge');
  const source = await fs.readFile(new URL('../web/src/components/SessionDisplayMenu.vue', import.meta.url), 'utf8');
  const triggerTemplate = parse(source).descriptor.template.content.split('<Teleport')[0];
  assert.doesNotMatch(triggerTemplate, /<Icon/, 'display trigger is text only');
  assert.match(triggerTemplate, /sorting \? '排序' : '显示'/);
  assert.match(triggerTemplate, /:aria-label="menuLabel"/);
  const sidebar = await fs.readFile(new URL('../web/src/components/SidePanel.vue', import.meta.url), 'utf8');
  assert.match(sidebar, /<SessionDisplayMenu sorting[^>]*@change="saveSorting"/);
  assert.doesNotMatch(sidebar, /toggleSort|sortLabel/);
});

test('sort preferences persist independently and reject malformed folder orders', () => {
  const storage = storageOf();
  const { readSessionView: read, saveSessionView: save } = preferences;
  assert.equal(read(storage, 'all').folderSort, 'time');
  assert.deepEqual(read(storage, 'all').folderOrder, []);
  for (const sort of ['time', 'time-asc', 'name', 'name-desc']) {
    save(storage, 'all', { ...read(storage, 'all'), sort, folderSort: 'custom', folderOrder: ['/b', '/a'] });
    assert.equal(read(storage, 'all').sort, sort);
    assert.equal(read(storage, 'all').folderSort, 'custom');
    assert.deepEqual(read(storage, 'all').folderOrder, ['/b', '/a']);
    assert.equal(read(storage, 'fav').folderSort, 'time');
    assert.deepEqual(read(storage, 'fav').folderOrder, []);
  }
  storage.setItem('seed-pi-web-session-view-all', JSON.stringify({ sort: 'bad', folderSort: 'bad', folderOrder: ['/a', 3, null, '/a', '/b'] }));
  assert.equal(read(storage, 'all').sort, 'time');
  assert.equal(read(storage, 'all').folderSort, 'time');
  assert.deepEqual(read(storage, 'all').folderOrder, ['/a', '/b']);
});

test('session and folder sort directions are independent; custom order handles new and hidden folders', () => {
  const sessions = [
    { title: 'Zebra', modified: '2026-01-03' },
    { title: 'Alpha', modified: '2026-01-01' },
    { title: 'Beta', modified: '2026-01-02' },
  ];
  const names = (sort) => [...sessions].sort(preferences.compareSessions(sort)).map((s) => s.title);
  assert.deepEqual(names('time'), ['Zebra', 'Beta', 'Alpha']);
  assert.deepEqual(names('time-asc'), ['Alpha', 'Beta', 'Zebra']);
  assert.deepEqual(names('name'), ['Alpha', 'Beta', 'Zebra']);
  assert.deepEqual(names('name-desc'), ['Zebra', 'Beta', 'Alpha']);
  const folders = [{ path: '/Zebra', last: 3 }, { path: '/Alpha', last: 1 }, { path: '/Beta', last: 2 }];
  const paths = (sort, order) => [...folders].sort(preferences.compareSessionFolders(sort, order)).map((g) => g.path);
  assert.deepEqual(paths('time'), ['/Zebra', '/Beta', '/Alpha']);
  assert.deepEqual(paths('time-asc'), ['/Alpha', '/Beta', '/Zebra']);
  assert.deepEqual(paths('name'), ['/Alpha', '/Beta', '/Zebra']);
  assert.deepEqual(paths('name-desc'), ['/Zebra', '/Beta', '/Alpha']);
  assert.deepEqual(paths('custom', ['/beta/', '/ALPHA']), ['/Beta', '/Alpha', '/Zebra']);
  const move = preferences.moveSessionFolder;
  assert.deepEqual(move(['/a', '/hidden', '/b'], ['/a', '/b', '/new'], '/new', '/a'), ['/new', '/a', '/hidden', '/b']);
  assert.deepEqual(move(['/a', '/hidden', '/b'], ['/a', '/b'], '/a', '/b', true), ['/hidden', '/b', '/a']);
  assert.deepEqual(move(['C:\\Repo\\B', 'C:\\Repo\\A'], ['c:/repo/b', 'c:/repo/a'], 'c:/repo/a', 'c:/repo/b'), ['c:/repo/a', 'c:/repo/b']);
});

test('sort dropdown separates session and folder settings and hides folder options in current directory', async (t) => {
  const props = vue.reactive({ sorting: true, mode: 'all', settings: preferences.readSessionView(storageOf(), 'all') });
  const { state: s, events } = await setup(t, 'SessionDisplayMenu.vue', { props });
  assert.equal(s.menuLabel.value, '会话和文件夹排序');
  assert.deepEqual([...s.sections.value.map((section) => section.key)], ['sort', 'folderSort']);
  assert.equal(s.sections.value[0].options.length, 4);
  assert.equal(s.sections.value[1].options.length, 5);
  s.opened.value = true;
  assert.deepEqual([...s.sections.value[1].options.map((option) => option.label)], ['时间正序', '时间倒序', '名称正序', '名称倒序', '自定义排序']);
  s.choose(s.sections.value[0], s.sections.value[0].options[0]);
  assert.equal(events.pop()[1].sort, 'time-asc');
  s.choose(s.sections.value[1], s.sections.value[1].options[4]);
  assert.equal(events.pop()[1].folderSort, 'custom');
  assert.equal(s.opened.value, true);
  props.mode = 'dir';
  await vue.nextTick();
  assert.equal(s.opened.value, false);
  assert.deepEqual([...s.sections.value.map((section) => section.key)], ['sort']);
});

test('sidebar drags folders above and below targets, persists custom order and supports keyboard moves', async (t) => {
  const S = vue.reactive({ sessionMode: 'all', cwd: '/a', agents: [], sessions: [
    { file: 'a', cwd: '/a', title: 'Zebra', modified: '2026-01-01' },
    { file: 'a2', cwd: '/a', title: 'Alpha', modified: '2026-01-04' },
    { file: 'b', cwd: '/b', title: 'Beta', modified: '2026-01-03' },
    { file: 'c', cwd: '/c', title: 'Other', modified: '2026-01-02' },
  ] });
  const storage = storageOf();
  const { state: s } = await setup(t, 'SidePanel.vue', { storage, imports: {
    '../store.js': { S, openSession() {}, newSession() {}, newSessionIn() {}, newTempSession() {}, deleteSession() {}, setSessionArchived() {}, setSessionStarred() {}, dirAllArchived: () => false, setDirArchived() {}, deleteDirSessions() {}, renameSession() {}, sessionStatus() {}, setSessionMode() {}, isFav: () => true },
    '../settings.js': { UI: {}, view: {}, toggleSide() {}, closeDrawer() {}, openMenu() {} },
  } });
  const paths = () => [...s.groups.value.map((g) => g.path)];
  s.saveUI({ layout: 'group', folderSort: 'name-desc' });
  assert.deepEqual(paths(), ['/c', '/b', '/a']);
  s.saveSorting({ sort: 'name', folderSort: 'custom' });
  await vue.nextTick();
  assert.deepEqual(paths(), ['/c', '/b', '/a'], 'first custom selection preserves the previous folder order');
  assert.deepEqual([...s.groups.value[2].items.map((row) => row.file)], ['a2', 'a']);
  let prevented = 0;
  const data = {};
  const event = { target: { closest: () => null }, dataTransfer: { setData: (k, v) => { data[k] = v; } }, preventDefault() { prevented++; }, currentTarget: { getBoundingClientRect: () => ({ top: 10, height: 30 }) }, clientY: 12 };
  s.startFolderDrag(event, '/a');
  assert.equal(data['text/plain'], '/a');
  assert.equal(event.dataTransfer.effectAllowed, 'move');
  s.overFolder(event, '/c');
  assert.equal(s.folderDrop.value.after, false);
  s.dropFolder(event, '/c');
  assert.deepEqual(paths(), ['/a', '/c', '/b']);
  assert.equal(s.draggingFolder.value, '');
  assert.equal(s.folderDrop.value, null);
  assert.deepEqual(preferences.readSessionView(storage, 'all').folderOrder, paths());
  s.startFolderDrag(event, '/a');
  event.clientY = 38;
  s.overFolder(event, '/b');
  assert.equal(s.folderDrop.value.after, true);
  s.dropFolder(event, '/b');
  assert.deepEqual(paths(), ['/c', '/b', '/a']);
  s.moveFolderKey({ altKey: true, key: 'ArrowUp', preventDefault() {} }, '/a');
  assert.deepEqual(paths(), ['/c', '/a', '/b']);
  s.saveSorting({ folderSort: 'time' });
  assert.deepEqual(paths(), ['/a', '/b', '/c']);
  s.saveSorting({ folderSort: 'custom' });
  assert.deepEqual(paths(), ['/c', '/a', '/b'], 'switching away does not erase custom order');
  s.q.value = 'Zebra';
  assert.deepEqual(paths(), ['/a']);
  assert.deepEqual(preferences.readSessionView(storage, 'all').folderOrder, ['/c', '/a', '/b']);
  s.q.value = '';
  S.sessionMode = 'fav';
  await vue.nextTick();
  assert.equal(s.cur.value.folderSort, 'time');
  assert.equal(s.draggingFolder.value, '');
  S.sessionMode = 'dir';
  s.saveSorting({ sort: 'time-asc' });
  assert.deepEqual([...s.groups.value.flatMap((g) => g.items.map((row) => row.file))], ['a', 'a2']);
  s.saveSorting({ sort: 'name-desc' });
  assert.deepEqual([...s.groups.value.flatMap((g) => g.items.map((row) => row.file))], ['a', 'a2']);
  assert.ok(prevented >= 4);
});

test('session actions respond to hover and keyboard focus, not lingering mouse focus or active state', async () => {
  const source = await fs.readFile(new URL('../web/src/components/SidePanel.vue', import.meta.url), 'utf8');
  assert.match(source, /\.sess:is\(:hover, :focus-visible, :has\(:focus-visible\)\) \.sess-action \{ display: inline-flex; \}/);
  assert.doesNotMatch(source, /\.sess(?::focus-within|\.active) \.sess-action/);
  assert.match(source, /:draggable="customFolders"/);
  assert.match(source, /@dragend="endFolderDrag"/);
});

test('active session also highlights its directory, including collapsed groups and lazy/detached sessions', async (t) => {
  const now = new Date().toISOString();
  const S = vue.reactive({ sessionMode: 'all', agents: [], agent: { sessionFile: 'C:\\sessions\\a.jsonl' }, sessions: [
    { file: 'c:/sessions/a.jsonl', cwd: '/repo', title: 'First', modified: now },
    { file: 'c:/sessions/b.jsonl', cwd: '/other', title: 'Second', modified: now },
  ] });
  const { state: s } = await setup(t, 'SidePanel.vue', { imports: {
    '../store.js': { S, openSession() {}, newSession() {}, newSessionIn() {}, newTempSession() {}, deleteSession() {}, setSessionArchived() {}, setSessionStarred() {}, dirAllArchived: () => false, setDirArchived() {}, deleteDirSessions() {}, renameSession() {}, sessionStatus() {}, setSessionMode() {}, isFav: () => true },
    '../settings.js': { UI: {}, view: {}, toggleSide() {}, closeDrawer() {}, openMenu() {} },
  } });
  s.saveUI({ layout: 'group' });
  const activeGroups = () => [...s.groups.value.filter(s.isActiveGroup).map((g) => g.path)];
  assert.equal(s.isActiveSession(S.sessions[0]), true, 'session and directory use the same normalized file identity');
  assert.deepEqual(activeGroups(), ['/repo']);
  s.toggleDir('/repo');
  assert.equal(s.isCollapsed('/repo'), true);
  assert.deepEqual(activeGroups(), ['/repo'], 'collapsing does not remove the active directory highlight');
  S.agent.sessionFile = 'c:/sessions/b.jsonl';
  assert.deepEqual(activeGroups(), ['/other']);
  assert.equal(s.isActiveSession(S.sessions[0]), false);
  S.agent = null;
  S.lazy = { file: 'c:/sessions/a.jsonl' };
  assert.deepEqual(activeGroups(), ['/repo']);
  S.lazy = null;
  S.detached = { file: 'c:/sessions/b.jsonl' };
  assert.deepEqual(activeGroups(), ['/other']);
  S.detached = null;
  assert.deepEqual(activeGroups(), []);
  assert.equal(s.isActiveSession({}), false, 'no session does not highlight a row with a missing file');
  const source = await fs.readFile(new URL('../web/src/components/SidePanel.vue', import.meta.url), 'utf8');
  assert.match(source, /active: isActiveGroup\(g\)/);
  assert.match(source, /active: isActiveSession\(s\)/);
});
