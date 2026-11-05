import vm from 'node:vm';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as vue from 'vue';

const commands = [
  { name: 'review', source: 'prompt', description: '检查代码', argumentHint: '<文件> [重点]' },
  { name: 'summarize', source: 'prompt', description: '总结内容' },
  { name: 'custom', source: 'extension' },
  { name: 'skill:test', source: 'skill' },
  { name: 'blocked', source: 'prompt' },
  { name: 'blocked', source: 'extension' },
];

async function harness() {
  const noop = () => {};
  const calls = [], storage = new Map();
  let result = commands, failure = null;
  const context = vm.createContext({
    console, URL, URLSearchParams, setTimeout: noop, clearTimeout: noop,
    location: { search: '', href: 'http://localhost/' },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    document: { addEventListener: noop, title: '' }, window: {},
  });
  const api = {
    CID: 'owner', http: { get: async () => [] },
    call: async (method, args) => {
      calls.push({ method, args });
      if (method === 'create_session') return { lazy: { cwd: args.cwd, file: null, messages: [] } };
      if (method === 'ensure_agent') return { agent: { id: 'a1', cwd: args.cwd, alive: true, owner: 'owner' }, messages: [] };
      assert.equal(method, 'rpc');
      if (args.cmd.type === 'get_commands') {
        if (failure) throw new Error(failure);
        return { success: true, data: { commands: await result } };
      }
      return { success: true, data: {} };
    },
  };
  const util = {
    stripAnsi: String, stripAttachments: String,
    normPath: p => (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(),
  };
  const settings = { UI: {}, view: vue.reactive({}) };
  const code = await fs.readFile(new URL('../web/src/store.js', import.meta.url), 'utf8');
  const mod = new vm.SourceTextModule(code, { context });
  await mod.link(async name => {
    const match = [...code.matchAll(/import \{([^}]+)\} from '([^']+)'/g)].find(x => x[2] === name);
    const names = match[1].split(',').map(s => s.trim());
    const values = name === 'vue' ? vue : name === './api.js' ? api : name === './util.js' ? util : settings;
    return new vm.SyntheticModule(names, function () {
      for (const key of names) this.setExport(key, values[key] ?? noop);
    }, { context });
  });
  await mod.evaluate();
  const { S } = mod.namespace;
  S.agentId = 'a1';
  S.agent = { id: 'a1', cwd: 'C:/test', sessionFile: 'C:/session.jsonl', owner: 'owner', alive: true };
  S.cwd = 'C:/test';
  return { ...mod.namespace, calls, commands: v => result = v, fail: v => failure = v };
}

const rpcCalls = h => h.calls.filter(c => c.method === 'rpc').map(c => c.args.cmd);

test('/prompt discovers only callable templates and selection only fills the composer, preserving attachments', async () => {
  const h = await harness();
  h.S.composer.attachments = [{ path: 'C:/notes.txt', status: 'ready' }];
  h.S.composer.images = [{ type: 'image', data: 'test', mimeType: 'image/png' }];
  assert.equal(await h.submit('/prompt'), true);
  assert.equal(h.S.picker.title, '选择提示词模板');
  assert.deepEqual(Array.from(h.S.picker.items, x => x.value.name), ['review', 'summarize']);
  assert.equal(h.S.picker.items[0].label, '/review <文件> [重点]');
  assert.match(h.S.picker.hint, /--help/);
  h.S.picker.onPick(h.S.picker.items[0].value);
  assert.equal(h.S.composer.text, '/review ');
  assert.equal(h.S.composerFocus, 1);
  assert.equal(h.S.composer.attachments[0].path, 'C:/notes.txt');
  assert.equal(h.S.composer.images.length, 1);
  assert.deepEqual(rpcCalls(h).map(c => c.type), ['get_commands']);
  assert.equal(h.allCommands().find(c => c.name === 'review').args, '<文件> [重点]');
});

test('/prompt name preserves raw quotes, dollar expressions and multiline args; sending delegates expansion to pi', async () => {
  const h = await harness();
  const args = '"src/my api.js"  \'API 兼容\' $1\n下一行';
  assert.equal(await h.submit('/prompt /review ' + args), true);
  assert.equal(h.S.composer.text, '/review ' + args);
  assert.ok(rpcCalls(h).every(c => c.type === 'get_commands'));
  const text = h.S.composer.text;
  assert.equal(await h.submit(text), true);
  const sent = rpcCalls(h).at(-1);
  assert.equal(sent.type, 'prompt');
  assert.equal(sent.message, text, 'the web UI must not expand template variables itself');
  h.S.running = true;
  assert.equal(await h.submit('/review "API 兼容"', { followUp: true }), true);
  assert.equal(rpcCalls(h).at(-1).streamingBehavior, 'followUp');
});

test('/prompt --help works without a directory or agent and documents all supported variable forms', async () => {
  const h = await harness();
  h.S.agentId = null;
  h.S.agent = null;
  h.S.cwd = '';
  assert.equal(await h.submit('/prompt --help'), true);
  assert.equal(h.calls.length, 0);
  const dialog = h.S.dialogs[0];
  assert.equal(dialog.method, 'info');
  for (const syntax of ['$1', '$@', '$ARGUMENTS', '${1:-默认值}', '${@:-默认值}', '${@:N}', '${@:N:L}']) {
    assert.ok(dialog.rows.some(([key]) => key.includes(syntax)), syntax);
  }
  assert.match(dialog.message, /不会执行 shell/);
});

test('empty templates show setup guidance; missing templates and discovery failures never send an ordinary prompt', async () => {
  const h = await harness();
  h.commands([]);
  assert.equal(await h.submit('/prompt'), true);
  assert.match(h.S.dialogs[0].message, /没有已加载/);
  assert.equal(h.S.picker, null);
  h.S.composer.text = 'keep draft';
  assert.equal(await h.submit('/prompt missing'), false);
  assert.equal(h.S.composer.text, 'keep draft');
  assert.match(h.S.toasts.at(-1).text, /找不到提示词模板/);
  h.fail('discovery failed');
  assert.equal(await h.submit('/prompt'), false);
  assert.equal(h.S.composer.text, 'keep draft');
  assert.equal(h.S.toasts.at(-1).text, 'discovery failed');
  assert.ok(rpcCalls(h).every(c => c.type === 'get_commands'));
});

test('/prompt starts a lazy agent only to discover templates, without calling a model', async () => {
  const h = await harness();
  await h.newSessionIn('C:/other');
  await vue.nextTick();
  assert.equal(h.S.agentId, null);
  const n = h.calls.length;
  assert.equal(await h.submit('/prompt'), true);
  assert.equal(h.S.agentId, 'a1');
  assert.ok(h.calls.slice(n).some(c => c.method === 'ensure_agent'));
  assert.equal(h.S.picker.items[0].value.name, 'review');
  assert.ok(!rpcCalls(h).some(c => c.type === 'prompt'));
});

test('switching sessions during discovery or while a picker is open cannot overwrite the new draft', async () => {
  const h = await harness();
  let resolve;
  h.commands(new Promise(r => resolve = r));
  const pending = h.submit('/prompt review');
  await vue.nextTick();
  await h.newSessionIn('C:/other');
  h.S.composer.text = 'new draft';
  resolve(commands);
  await pending;
  assert.equal(h.S.composer.text, 'new draft');
  assert.equal(h.S.picker, null);

  h.commands(commands);
  await h.submit('/prompt');
  const picker = h.S.picker;
  await h.newSessionIn('C:/third');
  h.S.composer.text = 'another draft';
  picker.onPick(picker.items[0].value);
  assert.equal(h.S.composer.text, 'another draft');
  assert.match(h.S.toasts.at(-1).text, /会话已切换/);
});

test('existing /prompt commands keep pi precedence and appear once in the slash menu', async () => {
  const h = await harness();
  h.S.commands = [{ name: 'prompt', source: 'extension', description: 'custom prompt' }];
  const entries = h.allCommands().filter(c => c.name === 'prompt');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, 'extension');
  assert.equal(await h.submit('/prompt custom'), true);
  assert.deepEqual(rpcCalls(h).map(c => c.type), ['prompt']);
  assert.equal(rpcCalls(h)[0].message, '/prompt custom');
  assert.equal(h.S.picker, null);
});
