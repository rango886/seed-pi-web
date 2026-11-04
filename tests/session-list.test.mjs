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
  const { matchesArchive, sessionInfo } = preferences;
  const list = [{ file: 'old' }, { file: 'archived', archived: true }, { file: 'new', unsaved: true }];
  assert.deepEqual(list.filter((s) => matchesArchive(s, 'active')).map((s) => s.file), ['old', 'new']);
  assert.deepEqual(list.filter((s) => matchesArchive(s, 'archived')).map((s) => s.file), ['archived']);
  assert.equal(list.filter((s) => matchesArchive(s, 'all')).length, 3);
  const s = { messages: 0, modified: 'today' };
  assert.equal(sessionInfo(s, { showCount: true, showTime: true }, () => '12:30'), '0 条 · 12:30');
  assert.equal(sessionInfo(s, { showCount: true, showTime: false }, () => '12:30'), '0 条');
  assert.equal(sessionInfo(s, { showCount: false, showTime: true }, () => '12:30'), '12:30');
  assert.equal(sessionInfo(s, { showCount: false, showTime: false }, () => '12:30'), '');
  assert.equal(sessionInfo({ unsaved: true }, {}, () => ''), '未保存');
});

async function setup(t, file, { props = {}, imports = {}, storage = storageOf(), document = {} } = {}) {
  const source = await fs.readFile(new URL('../web/src/components/' + file, import.meta.url), 'utf8');
  const code = compileScript(parse(source).descriptor, { id: 'test' }).content;
  const noop = () => {};
  const context = vm.createContext({ console, document, localStorage: storage,
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
    '../store.js': { S, openSession() {}, newSession() {}, deleteSession() {}, setSessionArchived: (...args) => actions.push(args), renameSession() {}, sessionStatus() {}, setSessionMode() {}, isFav: (cwd) => S.favorites.includes(cwd) },
    '../settings.js': { view: vue.reactive({}), toggleSide() {}, closeDrawer() {}, openMenu(x, y, items) { menu = items; } },
  } });
  const files = () => s.groups.value.flatMap((g) => g.items.map((row) => row.file));
  assert.deepEqual([...files()], ['a', 'c']);
  s.toggleSort();
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
  assert.ok(!menu.some((it) => it.label === '显示模式'), 'current directory has no layout menu');
  assert.equal(preferences.readSessionView(storage, 'all').showCount, false);
  assert.equal(preferences.readSessionView(storage, 'fav').archive, 'archived');
});

test('sidebar compensates for actual scrollbar width, including overlay scrollbars', async (t) => {
  const { state: s } = await setup(t, 'SidePanel.vue', { imports: {
    '../store.js': { S: {}, openSession() {}, newSession() {}, deleteSession() {}, setSessionArchived() {}, renameSession() {}, sessionStatus() {}, setSessionMode() {}, isFav() {} },
    '../settings.js': { view: {}, toggleSide() {}, closeDrawer() {}, openMenu() {} },
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

test('display dropdown hides directory-only options, emits patches, stays open and supports keyboard dismissal', async (t) => {
  const props = vue.reactive({ mode: 'all', settings: preferences.readSessionView(storageOf(), 'all') });
  const document = { activeElement: null };
  const { state: s, events } = await setup(t, 'SessionDisplayMenu.vue', { props, document });
  assert.equal(s.sections.value.length, 4);
  const allInfo = s.sections.value.find((section) => section.label === '会话信息');
  const pathOption = allInfo.options.find((option) => option.key === 'showPath');
  assert.ok(pathOption);
  assert.equal(s.checked(allInfo, pathOption), true);
  s.choose(allInfo, pathOption);
  assert.equal(events.pop()[1].showPath, false);
  props.mode = 'dir';
  await vue.nextTick();
  assert.deepEqual([...s.sections.value.map((section) => section.label)], ['归档筛选', '会话信息']);
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
  const archive = s.sections.value[0];
  s.choose(archive, archive.options[1]);
  assert.equal(events[0][0], 'change');
  assert.equal(events[0][1].archive, 'archived');
  assert.equal(s.opened.value, true, 'keep open for changing several settings');
  const info = s.sections.value[1];
  s.choose(info, info.options[0]);
  assert.equal(events[1][1].showCount, false);
  props.settings.archive = 'archived';
  assert.equal(s.label.value, '已归档');
  s.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(s.opened.value, false);
  assert.equal(document.activeElement, trigger);
  await s.open();
  props.mode = 'fav';
  await vue.nextTick();
  assert.equal(s.opened.value, false, 'switching mode dismisses the previous settings menu');
  assert.equal(s.sections.value.length, 4);
  assert.ok(s.sections.value.at(-1).options.some((option) => option.key === 'showPath'));
  await s.open();
  s.outside({ target: {} });
  assert.equal(s.opened.value, false);
  trigger.getBoundingClientRect = () => ({ right: 208.5, top: 100, bottom: 126 });
  await s.open();
  assert.equal(s.position.value.right, '791.5px');
  assert.equal(s.position.value.maxWidth, '200.5px', 'a narrow sidebar shrinks the menu instead of shifting its right edge');
  const source = await fs.readFile(new URL('../web/src/components/SessionDisplayMenu.vue', import.meta.url), 'utf8');
  const triggerTemplate = parse(source).descriptor.template.content.split('<Teleport')[0];
  assert.ok(!triggerTemplate.includes('<Icon'), 'the display trigger is text only');
});
