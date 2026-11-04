// Run with --experimental-vm-modules (same as new-session.test.mjs).
import vm from 'node:vm';
import fs from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as vue from 'vue';

async function modules() {
  const noop = () => {};
  const calls = [];
  const api = { CID: 'test', http: { get: async (url, q) => { calls.push({ url, q }); return url.includes('/git/') ? { hunks: [] } : { text: 'file' }; } } };
  const settings = { view: vue.reactive({}), UI: {} };
  const context = vm.createContext({ console, URL, URLSearchParams,
    location: { search: '', href: 'http://localhost/' },
    localStorage: { getItem: () => null, setItem: noop },
    document: { addEventListener: noop, title: '' }, window: {}, setTimeout: noop, clearTimeout: noop,
  });
  const utility = { normPath: (p) => (p || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase(), stripAnsi: String, stripAttachments: String };
  const code = await fs.readFile(new URL('../web/src/store.js', import.meta.url), 'utf8');
  const store = new vm.SourceTextModule(code, { context });
  await store.link(async (name) => {
    const match = [...code.matchAll(/import \{([^}]+)\} from '([^']+)'/g)].find((x) => x[2] === name);
    const names = match[1].split(',').map((s) => s.trim());
    const values = name === 'vue' ? vue : name === './api.js' ? api : name === './util.js' ? utility : settings;
    return new vm.SyntheticModule(names, function () { for (const k of names) this.setExport(k, values[k] ?? noop); }, { context });
  });
  await store.evaluate();
  const git = new vm.SourceTextModule(await fs.readFile(new URL('../web/src/git.js', import.meta.url), 'utf8'), { context });
  await git.link(async (name) => {
    if (name === './store.js') return store;
    const values = name === 'vue' ? vue : name === './api.js' ? api : settings;
    const names = name === 'vue' ? ['reactive', 'computed', 'watch', 'onMounted', 'onUnmounted'] : name === './api.js' ? ['http'] : ['view'];
    return new vm.SyntheticModule(names, function () { for (const k of names) this.setExport(k, values[k]); }, { context });
  });
  await git.evaluate();
  return { store: store.namespace, git: git.namespace, calls };
}

test('normal preview, staged, working and total diffs have independent reusable tabs and correct closing', async () => {
  const { store: m, calls } = await modules();
  const { S } = m;
  S.cwd = 'C:/repo';
  m.openFile('C:/repo/a.txt');
  m.openDiff('C:/repo/a.txt', { mode: 'staged' });
  m.openDiff('C:/repo/a.txt', { mode: 'working' });
  m.openDiff('C:/repo/a.txt', { mode: 'head' });
  assert.equal(S.tabs.length, 4);
  assert.equal(new Set(S.tabs.map((t) => t.id)).size, 4);
  assert.equal(S.tabs.filter((t) => !t.diff).length, 1);
  m.openDiff('c:\\repo\\a.txt', { mode: 'staged', cwd: 'c:\\repo' });
  assert.equal(S.tabs.length, 4);
  assert.equal(S.activeTab, S.tabs[1].id);
  assert.ok(calls.some((c) => c.url === '/api/git/diff' && c.q.mode === 'staged'));
  assert.ok(calls.some((c) => c.url === '/api/fs/read'));
  m.closeTab(S.tabs[1].id);
  assert.equal(S.tabs.length, 3);
  assert.equal(S.activeTab, S.tabs[1].id);
  m.openFile('c:\\repo\\a.txt');
  assert.equal(S.tabs.length, 3);
  assert.equal(S.activeTab, S.tabs[0].id);
  await m.closeAllTabs(S.tabs[2].id);
  assert.equal(S.tabs.length, 1);
  assert.equal(S.activeTab, S.tabs[0].id);
  m.closeTab(S.tabs[0].id);
  assert.equal(S.activeTab, 'chat');
});

test('VS Code style groups retain MM in both groups; decorations aggregate directories and ignored ancestors', async () => {
  const { store: { S }, git: { G, changeGroups, gitMark } } = await modules();
  S.cwd = 'C:/repo/src'; S.info.platform = 'win32'; G.cwd = S.cwd;
  G.data = { available: true, root: 'C:/repo', ignored: ['node_modules', 'src/ignored.txt'], entries: [
    { path: 'src/mm.txt', x: 'M', y: 'M', status: 'M', sub: 'N...' },
    { path: 'src/new.txt', x: '?', y: '?', status: 'U', sub: 'N...' },
    { path: 'src/conflict.txt', x: 'U', y: 'U', status: '!', conflict: true },
    { path: 'renamed.txt', oldPath: 'old/old.txt', x: 'R', y: '.', status: 'R' },
    { path: 'copied.txt', oldPath: 'source.txt', x: 'C', y: '.', status: 'C' },
    { path: 'case.txt', oldPath: 'Case.txt', x: 'R', y: '.', status: 'R' },
    { path: 'submodule', x: '.', y: '.', status: 'M', sub: 'S.MU' },
  ] };
  assert.deepEqual(Array.from(changeGroups.value, (g) => g.title), ['合并更改', '暂存的更改', '更改']);
  assert.equal(changeGroups.value[1].entries.filter((e) => e.path === 'src/mm.txt').length, 1);
  assert.equal(changeGroups.value[2].entries.filter((e) => e.path === 'src/mm.txt').length, 1);
  assert.equal(changeGroups.value[2].entries.find((e) => e.path === 'src/new.txt').code, 'U');
  assert.ok(changeGroups.value[2].entries.some((e) => e.path === 'submodule'));
  assert.equal(gitMark('c:\\REPO\\src\\mm.txt').code, 'M');
  assert.equal(gitMark('C:/repo/src', true).code, '!');
  assert.equal(gitMark('C:/repo/old/old.txt').code, 'D');
  assert.equal(gitMark('C:/repo/old', true).code, 'D');
  assert.equal(gitMark('C:/repo/source.txt'), null, 'copies do not delete the source');
  assert.equal(gitMark('C:/repo/case.txt').code, 'R', 'case-only rename is not a deletion');
  assert.equal(gitMark('C:/repo/.git/config').ignored, true);
  assert.equal(gitMark('C:/repo/node_modules/foo/index.js').ignored, true);
  assert.equal(gitMark('C:/repo/src/ignored.txt').ignored, true);
  assert.equal(gitMark('C:/repo/src/clean.txt'), null);
  S.cwd = 'C:/other';
  assert.equal(gitMark('C:/repo/src/mm.txt'), null, 'must not leak status after switching projects');
});
