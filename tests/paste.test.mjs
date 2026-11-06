import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import * as vue from 'vue';

async function store() {
  const code = await fs.readFile(new URL('../web/src/store.js', import.meta.url), 'utf8');
  const noop = () => {};
  const storage = new Map();
  const context = vm.createContext({
    console, URLSearchParams, AbortController, setTimeout: noop, clearTimeout: noop,
    URL: { createObjectURL: () => 'blob:preview' },
    location: { search: '', href: 'http://localhost/' },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    document: { addEventListener: noop, title: '' }, window: {},
  });
  const calls = { get: [], upload: [] };
  let clipboard = () => new Promise(() => {});
  const api = {
    CID: 'owner',
    http: { get: (url) => { calls.get.push(url); return url === '/api/clipboard/files' ? clipboard() : Promise.resolve([]); } },
    upload: (file, query, progress, signal) => { calls.upload.push(query.name); calls.signals = [...(calls.signals || []), signal]; return new Promise(() => {}); },
  };
  const util = {
    normPath: (p) => (p || '').replace(/\\/g, '/').toLowerCase(), stripAnsi: String, stripAttachments: String,
    attachKind: (name, dir) => (dir ? 'dir' : /\.png$/i.test(name || '') ? 'image' : 'file'),
    baseName: (p) => (p || '').split(/[\\/]/).pop(),
  };
  const mod = new vm.SourceTextModule(code, { context });
  await mod.link(async (name) => {
    const names = [...code.matchAll(/import \{([^}]+)\} from '([^']+)'/g)].find((m) => m[2] === name)[1].split(',').map((s) => s.trim());
    const values = name === 'vue' ? vue : name === './api.js' ? api : name === './util.js' ? util : { view: vue.reactive({}), UI: {} };
    return new vm.SyntheticModule(names, function () {
      for (const key of names) this.setExport(key, values[key] ?? noop);
    }, { context });
  });
  await mod.evaluate();
  return { ...mod.namespace, calls, setClipboard: (fn) => { clipboard = fn; } };
}

const file = (name, size, type = '') => ({ name, size, type });

test('screenshots show and start uploading immediately; the clipboard check runs in the background', async () => {
  const h = await store();
  h.S.info.local = true;
  h.setClipboard(async () => ({ files: [] }));
  const done = h.pasteFiles([file('image.png', 10, 'image/png')]);
  assert.equal(h.S.composer.attachments.length, 1, 'card appears synchronously');
  assert.equal(h.S.composer.attachments[0].preview, 'blob:preview');
  assert.match(h.calls.upload[0], /^paste-\d{8}-\d{6}\.png$/, 'upload starts before the clipboard answer');
  await done;
  assert.deepEqual(h.calls.get, ['/api/clipboard/files']);
  assert.equal(h.calls.upload.length, 1);
  assert.equal(h.calls.signals[0].aborted, false);
  assert.equal(h.S.composer.attachments[0].origin, 'upload');
});

test('a real local file named image.png cancels the speculative upload and uses the original path', async () => {
  const h = await store();
  h.S.info.local = true;
  h.setClipboard(async () => ({ files: [{ path: 'C:\\pics\\image.png', name: 'image.png', size: 10 }] }));
  await h.pasteFiles([file('image.png', 10, 'image/png')]);
  assert.equal(h.calls.signals[0].aborted, true);
  const [a] = h.S.composer.attachments;
  assert.equal(a.path, 'C:\\pics\\image.png');
  assert.equal(a.name, 'image.png');
  assert.equal(a.origin, 'clipboard');
  assert.equal(a.status, 'ready');
});

test('removing a card cancels its upload', async () => {
  const h = await store();
  h.uploadFiles([file('big.bin', 10)]);
  h.removeAttachment(h.S.composer.attachments[0]);
  assert.equal(h.calls.signals[0].aborted, true);
});
test('explorer files show a card before the clipboard answer, then switch to the original path', async () => {
  const h = await store();
  h.S.info.local = true;
  let answer;
  h.setClipboard(() => new Promise((resolve) => { answer = resolve; }));
  const done = h.pasteFiles([file('a.txt', 3), file('b.txt', 4)]);
  assert.equal(h.S.composer.attachments.length, 2, 'cards appear before the backend replies');
  assert.equal(h.S.composer.attachments[0].status, 'uploading');
  h.removeAttachment(h.S.composer.attachments[1]);
  answer({ files: [{ path: 'C:\\x\\a.txt', name: 'a.txt', size: 3 }, { path: 'C:\\x\\b.txt', name: 'b.txt', size: 4 }] });
  await done;
  assert.equal(h.S.composer.attachments.length, 1, 'cards removed while waiting stay removed');
  assert.equal(h.S.composer.attachments[0].path, 'C:\\x\\a.txt');
  assert.equal(h.S.composer.attachments[0].origin, 'clipboard');
  assert.equal(h.S.composer.attachments[0].status, 'ready');
  assert.deepEqual(h.calls.upload, []);
});

test('unmatched files upload after the clipboard check; extra clipboard files are added when everything matched', async () => {
  const h = await store();
  h.S.info.local = true;
  h.setClipboard(async () => ({ files: [{ path: '/x/a.txt', name: 'a.txt', size: 3 }] }));
  await h.pasteFiles([file('other.bin', 5)]);
  assert.deepEqual(h.calls.upload, ['other.bin']);
  assert.equal(h.S.composer.attachments.length, 1);
  h.S.composer.attachments.splice(0);
  h.setClipboard(async () => ({ files: [{ path: '/x/a.txt', name: 'a.txt', size: 3 }, { path: '/x/dir', name: 'dir', dir: true }] }));
  await h.pasteFiles([file('a.txt', 3)]);
  assert.deepEqual([...h.S.composer.attachments.map((a) => a.path)], ['/x/a.txt', '/x/dir']);
});
