import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import * as vue from 'vue';
import { parse, compileScript } from 'vue/compiler-sfc';

async function store() {
  const code = await fs.readFile(new URL('../web/src/store.js', import.meta.url), 'utf8');
  const noop = () => {};
  const storage = new Map(), deletes = [];
  const context = vm.createContext({
    console, URL, URLSearchParams, setTimeout: noop, clearTimeout: noop,
    location: { search: '', href: 'http://localhost/' },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    document: { addEventListener: noop, title: '' }, window: {},
  });
  let remove = async () => ({ ok: true });
  const api = { CID: 'owner', http: {
    get: async () => [],
    del: async (...args) => { deletes.push(args); return remove(...args); },
  } };
  const util = { normPath: p => (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(), stripAnsi: String, stripAttachments: String };
  const mod = new vm.SourceTextModule(code + '\nexport { onServerMsg as dispatch };', { context });
  await mod.link(async name => {
    const names = [...code.matchAll(/import \{([^}]+)\} from '([^']+)'/g)].find(m => m[2] === name)[1].split(',').map(s => s.trim());
    const values = name === 'vue' ? vue : name === './api.js' ? api : name === './util.js' ? util : { view: vue.reactive({}), UI: {} };
    return new vm.SyntheticModule(names, function () {
      for (const key of names) this.setExport(key, values[key] ?? noop);
    }, { context });
  });
  await mod.evaluate();
  mod.namespace.S.cwd = '/repo';
  return { ...mod.namespace, deletes, storage, remove: fn => { remove = fn; } };
}

const row = { file: '/sessions/chat.jsonl', title: '测试会话' };

test('normal deletion confirms with title brackets only; cancelling and duplicate clicks do not delete', async () => {
  const h = await store();
  const pending = h.deleteSession(row);
  assert.equal(h.S.dialogs.length, 1);
  assert.equal(h.S.dialogs[0].message, '确定删除「测试会话」文件会被永久删除');
  await h.deleteSession(row, { ctrlKey: true });
  assert.equal(h.deletes.length, 0, 'a pending confirmation blocks duplicate deletion');
  h.S.dialogs.pop()._resolve({ confirmed: false });
  await pending;
  assert.equal(h.deletes.length, 0);
  const confirmed = h.deleteSession(row);
  h.S.dialogs.pop()._resolve({ confirmed: true });
  await confirmed;
  assert.equal(h.deletes.length, 1);
  assert.equal(h.deletes[0][0], '/api/sessions');
  assert.equal(h.deletes[0][1].file, row.file);
});

test('Ctrl deletes without a dialog, waits for the server, preserves state on failure and allows retry', async () => {
  const h = await store();
  h.S.sessions = [row];
  h.S.lazy = { cwd: '/repo', file: row.file };
  h.S.agent = { cwd: '/repo', sessionFile: row.file };
  h.S.messages = [{ role: 'user', content: 'history' }];
  h.remove(async () => { throw new Error('delete failed'); });
  await h.deleteSession(row, { ctrlKey: true });
  assert.equal(h.S.dialogs.length, 0);
  assert.equal(h.S.sessions.length, 1);
  assert.equal(h.S.lazy.file, row.file);
  assert.equal(h.S.messages.length, 1);
  assert.equal(h.S.toasts.at(-1).kind, 'error');
  let finish;
  h.remove(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.deleteSession(row, { ctrlKey: true });
  await h.deleteSession(row, { ctrlKey: true });
  assert.equal(h.deletes.length, 2, 'one failed request and one retry, not a duplicate');
  assert.equal(h.S.lazy.file, row.file, 'no optimistic clearing before deletion succeeds');
  finish({ ok: true });
  await pending;
  assert.equal(h.S.lazy.file, null);
  assert.equal(h.S.messages.length, 0);
  assert.equal(h.S.toasts.filter(t => t.kind === 'error').length, 1);
});

test('deletion broadcasts clear live/lazy/detached views and remembered paths without disturbing other chats', async () => {
  for (const mode of ['live', 'lazy', 'detached', 'other']) {
    const h = await store();
    const file = mode === 'other' ? '/sessions/other.jsonl' : row.file;
    h.S.sessions = [row];
    h.storage.set('seed-pi-web-session', row.file);
    h.storage.set('seed-pi-web-last-session', JSON.stringify({ '/repo': row.file, '/other': '/sessions/other.jsonl' }));
    if (mode === 'detached') h.S.detached = { cwd: '/repo', file };
    else h.S.agent = { cwd: '/repo', sessionFile: file };
    if (mode === 'lazy') h.S.lazy = { cwd: '/repo', file };
    if (mode === 'live') { h.S.agentId = 'a1'; h.S.running = true; }
    h.S.messages = [{ role: 'user', content: 'history' }];
    h.dispatch({ t: 'session_deleted', file: row.file.toUpperCase() });
    assert.equal(h.S.sessions.length, 0);
    assert.equal(h.storage.get('seed-pi-web-session'), '');
    assert.deepEqual(JSON.parse(h.storage.get('seed-pi-web-last-session')), { '/other': '/sessions/other.jsonl' });
    assert.equal(h.S.messages.length, mode === 'other' ? 1 : 0);
    if (mode !== 'other') {
      assert.equal(h.S.agentId, null);
      assert.equal(h.S.lazy.file, null);
      assert.equal(h.S.running, false);
      assert.equal(h.S.detached, null);
    }
  }
});

test('context menu forwards the actual click event, including Ctrl, before closing', async () => {
  const source = await fs.readFile(new URL('../web/src/components/ContextMenu.vue', import.meta.url), 'utf8');
  const code = compileScript(parse(source).descriptor, { id: 'test' }).content;
  const view = { ctx: { items: [] } }, noop = () => {};
  const context = vm.createContext({});
  const mod = new vm.SourceTextModule(code, { context });
  await mod.link(async name => {
    const values = name === 'vue' ? { ...vue, onMounted: noop, onUnmounted: noop, watch: noop }
      : name === '../settings.js' ? { view } : { default: {} };
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await mod.evaluate();
  const state = mod.namespace.default.setup({}, { expose: noop });
  const event = { ctrlKey: true };
  let received;
  state.run({ run: e => { received = e; assert.equal(view.ctx, null); } }, 0, event);
  assert.equal(received, event);
  assert.match(source, /@click="run\(it, i, \$event\)"/);
  assert.match(source, /@click="run\(c, j, \$event\)"/);
});

test('directory delete removes every session in the folder, skips busy ones, confirms once and Ctrl skips the dialog', async () => {
  const h = await store();
  const a = { file: '/sessions/a.jsonl', cwd: '/repo/', title: 'a' };
  const b = { file: '/sessions/b.jsonl', cwd: '\\repo', title: 'b', archived: true };
  const busy = { file: '/sessions/busy.jsonl', cwd: '/repo', title: 'busy' };
  const other = { file: '/sessions/other.jsonl', cwd: '/other', title: 'other' };
  h.S.sessions = [a, b, busy, other];
  h.S.agents = [{ id: 'x', sessionFile: busy.file, running: true }];
  const pending = h.deleteDirSessions('/repo');
  assert.equal(h.S.dialogs.length, 1);
  assert.match(h.S.dialogs[0].message, /2 个会话/);
  assert.match(h.S.dialogs[0].message, /1 个正在使用/);
  h.S.dialogs.pop()._resolve({ confirmed: false });
  await pending;
  assert.equal(h.deletes.length, 0);
  await h.deleteDirSessions('/repo', { ctrlKey: true });
  assert.equal(h.S.dialogs.length, 0);
  assert.deepEqual(h.deletes.map((d) => d[1].file), [a.file, b.file]);
  assert.deepEqual(h.S.sessions.map((s) => s.file), [busy.file, other.file]);
});

test('Pi Markdown links are not underlined normally or on hover', async () => {
  const css = await fs.readFile(new URL('../web/src/pi.css', import.meta.url), 'utf8');
  assert.match(css, /:root\[data-md='pi'\] \.md a,\s*:root\[data-md='pi'\] \.md a:hover \{[^}]*text-decoration: none;/);
});
