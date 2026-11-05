import vm from 'node:vm';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as vue from 'vue';
import { parse } from 'vue/compiler-sfc';

async function harness({ blocked = false } = {}) {
  const noop = () => {};
  const events = [], calls = [], navigations = [];
  let result = { path: 'pi-session-测试 #1.html' }, failure = null;
  const tab = { opener: {}, closed: false, location: { replace: url => navigations.push(url) }, close() { this.closed = true; } };
  const context = vm.createContext({
    console, URL, URLSearchParams, setTimeout: noop, clearTimeout: noop,
    location: { search: '', href: 'http://localhost/' },
    localStorage: { getItem: () => null, setItem: noop },
    document: { addEventListener: noop, title: '' },
    window: { open: (...args) => { events.push({ type: 'open', args }); return blocked ? null : tab; } },
  });
  const api = {
    CID: 'owner', http: { get: async () => [] },
    rawUrl: p => '/api/fs/raw?path=' + encodeURIComponent(p) + '&token=test-token',
    call: async (method, args) => {
      calls.push({ method, args });
      events.push({ type: 'rpc', cmd: args.cmd });
      assert.equal(method, 'rpc');
      if (args.cmd.type === 'export_html') {
        if (failure) throw new Error(failure);
        return { success: true, data: await result };
      }
      return { success: true, data: {} };
    },
  };
  const synthetic = values => new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context });
  const apiModule = synthetic({ connect: noop, fire: noop, upload: noop, ...api });
  const settings = synthetic({ UI: {}, view: vue.reactive({}) });
  const util = new vm.SourceTextModule(await fs.readFile(new URL('../web/src/util.js', import.meta.url), 'utf8'), { context });
  await util.link(async name => name === './api.js' ? apiModule : name === 'dompurify' ? synthetic({ default: { addHook: noop } }) : synthetic(await import(name)));
  const mod = new vm.SourceTextModule(await fs.readFile(new URL('../web/src/store.js', import.meta.url), 'utf8'), { context });
  await mod.link(async name => name === './util.js' ? util : name === './api.js' ? apiModule : name === './settings.js' ? settings : synthetic(vue));
  await mod.evaluate();
  const { S } = mod.namespace;
  S.agentId = 'a1';
  S.agent = { id: 'a1', cwd: 'C:/work/项目', owner: 'owner', alive: true };
  S.cwd = S.agent.cwd;
  S.info.sep = '/';
  return { ...mod.namespace, tab, events, calls, navigations, result: v => result = v, fail: v => failure = v };
}

function exportedPath(url) {
  const u = new URL(url, 'http://localhost');
  assert.equal(u.pathname, '/api/fs/raw');
  assert.equal(u.searchParams.get('token'), 'test-token');
  return u.searchParams.get('path');
}

test('/export resolves pi relative output against the session cwd and opens a tab before awaiting RPC', async () => {
  const h = await harness();
  assert.equal(await h.submit('/export'), true);
  assert.equal(h.events[0].type, 'open');
  assert.equal(h.events[0].args[0], 'about:blank');
  assert.equal(h.events[1].cmd.type, 'export_html');
  assert.equal(h.tab.opener, null);
  assert.equal(exportedPath(h.navigations[0]), 'C:/work/项目/pi-session-测试 #1.html');
  const toast = h.S.toasts.at(-1);
  assert.equal(toast.action.label, '打开 HTML');
  assert.equal(toast.action.href, h.navigations[0]);
  assert.match(toast.text, /C:\/work\/项目/);
});

test('popup blocking still leaves a working authenticated export link', async () => {
  const h = await harness({ blocked: true });
  await h.exportHtml('exports/session.html');
  assert.equal(h.calls[0].args.cmd.outputPath, 'exports/session.html');
  assert.equal(h.navigations.length, 0);
  assert.equal(exportedPath(h.S.toasts.at(-1).action.href), 'C:/work/项目/pi-session-测试 #1.html');
  assert.equal(h.S.toasts.at(-1).kind, 'info');
});

test('absolute Windows, UNC and POSIX paths are not prefixed with the cwd', async () => {
  for (const file of ['D:\\导出\\chat #1.html', '\\\\server\\share\\chat.html', '/tmp/chat.html']) {
    const h = await harness();
    h.result({ path: file });
    await h.exportHtml();
    assert.equal(exportedPath(h.navigations[0]), file);
  }
});

test('relative output keeps the originating directory even if the current session changes mid-export', async () => {
  const h = await harness();
  h.S.cwd = 'C:\\work\\original';
  h.S.info.sep = '\\';
  let resolve;
  h.result(new Promise(r => resolve = r));
  const exporting = h.exportHtml();
  h.S.cwd = 'D:\\other';
  resolve({ path: 'exports\\session.html' });
  await exporting;
  assert.equal(exportedPath(h.navigations[0]), 'C:\\work\\original\\exports\\session.html');
});

test('export failure and malformed results close the blank tab and do not report success', async () => {
  for (const failedRpc of [true, false]) {
    const h = await harness();
    if (failedRpc) h.fail('Nothing to export yet');
    else h.result({});
    await h.exportHtml();
    assert.equal(h.tab.closed, true);
    assert.equal(h.navigations.length, 0);
    assert.equal(h.S.toasts.at(-1).kind, 'error');
    assert.equal(h.S.toasts.at(-1).action, null);
    assert.match(h.S.toasts.at(-1).text, failedRpc ? /Nothing to export/ : /未返回文件路径/);
  }
});

test('closing the pending tab does not turn a successful export into an error', async () => {
  const h = await harness();
  let resolve;
  h.result(new Promise(r => resolve = r));
  const exporting = h.exportHtml();
  h.tab.closed = true;
  resolve({ path: 'chat.html' });
  await exporting;
  assert.equal(h.navigations.length, 0);
  assert.equal(h.S.toasts.at(-1).kind, 'info');
  assert.equal(exportedPath(h.S.toasts.at(-1).action.href), 'C:/work/项目/chat.html');
});

test('toast links are native new-tab anchors, while existing undo buttons keep their callbacks', async () => {
  const { descriptor } = parse(await fs.readFile(new URL('../web/src/components/Toasts.vue', import.meta.url), 'utf8'));
  const template = descriptor.template.content;
  assert.match(template, /<a v-if="t.action\?\.href"[^>]*:href="t.action.href"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  assert.match(template, /<button v-else-if="t.action"[^\n]*t.action.run\(\)/);
  assert.ok(!template.includes('@click.prevent'), 'opening links must keep native browser navigation');
});
