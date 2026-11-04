import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import * as vue from 'vue';

async function store() {
  const code = await fs.readFile(new URL('../web/src/store.js', import.meta.url), 'utf8');
  const noop = () => {};
  const context = vm.createContext({
    console, URL, URLSearchParams, location: { search: '', href: 'http://localhost/' },
    setTimeout: noop, clearTimeout: noop,
    localStorage: { getItem: () => null, setItem: noop },
    document: { addEventListener: noop, title: '' }, window: {},
  });
  const rows = [{ file: '/sessions/chat.jsonl', title: 'Chat', cwd: '/repo', archived: false }];
  const posts = [], calls = [];
  let fail = false, handlers, get = async () => rows.map((s) => ({ ...s }));
  const api = {
    http: {
      get: (...args) => get(...args),
      post: async (url, body) => {
        posts.push({ url, body });
        if (fail) throw new Error('archive failed');
        rows[0].archived = body.archived;
        return { ok: true };
      },
    },
    connect: (h) => { handlers = h; }, CID: 'test',
    call: (...args) => { calls.push(args); throw new Error('archive must not use pi RPC'); },
  };
  const util = { normPath: (p) => (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(), stripAnsi: String };
  const settings = { view: vue.reactive({}), UI: {} };
  const mod = new vm.SourceTextModule(code, { context });
  await mod.link(async (name) => {
    const match = [...code.matchAll(/import \{([^}]+)\} from '([^']+)'/g)].find((m) => m[2] === name);
    const names = match[1].split(',').map((s) => s.trim());
    const values = name === 'vue' ? vue : name === './api.js' ? api : name === './util.js' ? util : settings;
    return new vm.SyntheticModule(names, function () {
      for (const key of names) this.setExport(key, values[key] ?? noop);
    }, { context });
  });
  await mod.evaluate();
  mod.namespace.start();
  return { ...mod.namespace, posts, calls, rows, message: (msg) => handlers.message(msg), fail: (value) => { fail = value; }, get: (fn) => { get = fn; } };
}

test('archiving updates the shared list without closing chat or stopping work, supports undo and handles failure', async () => {
  const s = await store();
  s.S.cwd = '/repo';
  s.S.lazy = { cwd: '/repo', file: '/sessions/chat.jsonl' };
  s.S.messages = [{ role: 'user', content: 'keep chat' }];
  s.S.running = true;
  await s.loadSessions();
  await s.setSessionArchived(s.S.sessions[0], true);
  assert.equal(s.posts[0].url, '/api/sessions/archive');
  assert.equal(s.posts[0].body.archived, true);
  assert.equal(s.S.sessions[0].archived, true);
  assert.equal(s.S.lazy.file, '/sessions/chat.jsonl');
  assert.equal(s.S.messages[0].content, 'keep chat');
  assert.equal(s.S.running, true);
  assert.equal(s.calls.length, 0);
  assert.equal(s.S.toasts.at(-1).action.label, '撤销');
  await s.S.toasts.at(-1).action.run();
  assert.equal(s.S.sessions[0].archived, false);
  s.fail(true);
  await s.setSessionArchived(s.S.sessions[0], true);
  assert.equal(s.S.sessions[0].archived, false);
  assert.equal(s.S.toasts.at(-1).kind, 'error');
  s.fail(false);
  await s.setSessionArchived(s.S.sessions[0], true);
  assert.equal(s.S.sessions[0].archived, true, 'failure does not leave the operation locked');
  s.message({ t: 'session_archive', file: '/sessions/chat.jsonl', archived: false });
  assert.equal(s.S.sessions[0].archived, false, 'updates from another browser apply to the list');
});

test('undo remains available while the list refresh is still in flight', { timeout: 5000 }, async () => {
  const s = await store();
  s.S.cwd = '/repo';
  await s.loadSessions();
  const pending = [];
  s.get(() => new Promise((resolve) => pending.push(resolve)));
  await s.setSessionArchived(s.S.sessions[0], true);
  assert.equal(s.S.sessions[0].archived, true);
  await s.S.toasts.at(-1).action.run();
  assert.equal(s.posts.length, 2);
  assert.equal(s.posts[1].body.archived, false);
  assert.equal(s.S.sessions[0].archived, false);
  pending[1]([{ ...s.rows[0], archived: false }]);
  pending[0]([{ ...s.rows[0], archived: true }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.S.sessions[0].archived, false, 'stale refresh cannot undo the restore');
});

test('switching views ignores out-of-order session responses', async () => {
  const s = await store();
  s.S.cwd = '/repo';
  const pending = [];
  s.get((url, query) => new Promise((resolve) => pending.push({ query, resolve })));
  const old = s.loadSessions();
  s.setSessionMode('all');
  assert.equal(pending[0].query.cwd, '/repo');
  assert.equal(pending[1].query.all, 1);
  pending[1].resolve([{ file: 'all-result' }]);
  await new Promise((resolve) => setImmediate(resolve));
  pending[0].resolve([{ file: 'old-directory-result' }]);
  await old;
  assert.equal(s.S.sessions[0].file, 'all-result');
});
