// Run: node --experimental-vm-modules --test tests/new-session.test.mjs
import vm from 'node:vm';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as vue from 'vue';
import { parse } from 'vue/compiler-sfc';

test('new session lives in the sidebar before the directory picker, and the composer stays message-only', async () => {
  const load = async (name) => parse(await fs.readFile(new URL('../web/src/components/' + name, import.meta.url), 'utf8')).descriptor;
  const composer = await load('Composer.vue');
  const template = composer.template.content;
  assert.ok(!template.includes('newSession'), 'the composer bar no longer hosts new session');
  assert.ok(!template.includes('<DirectoryMenu'), 'the composer bar no longer hosts the directory picker');
  const sidebar = (await load('SidePanel.vue')).template.content;
  // 新会话按钮（图标 + 文案）在侧栏 actions 行里，紧跟目录选择器
  assert.match(sidebar, /@click="newHere"><Icon name="newchat"[^>]*\/><span class="ellipsis">当前<\/span><\/button>\s*<DirectoryMenu v-if="UI\.dirShow" @select="closeDrawer" \/>/);
  assert.ok(sidebar.indexOf('@click="newHere"') < sidebar.indexOf('class="search"'), 'new session sits above the session list');
  assert.ok(!sidebar.includes('class="modes"'));
  assert.match(sidebar, /<SessionDisplayMenu[^>]*@mode-change="setSessionMode"/);
});

test('new sessions and directory selection preserve the intended context', async () => {
  const code = await fs.readFile(new URL('../web/src/store.js', import.meta.url), 'utf8');
  const noop = () => {};
  const storage = new Map();
  const context = vm.createContext({
    console, URL, URLSearchParams,
    location: { search: '', href: 'http://localhost/' },
    setTimeout: noop, clearTimeout: noop,
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    document: { addEventListener: noop, title: '' }, window: {},
  });
  const calls = [];
  let fail = false;
  let agentState = {};
  const api = {
    http: { get: async () => [] }, CID: 'test',
    call: async (method, args) => {
      calls.push({ method, args });
      if (fail) throw new Error('directory missing');
      if (method === 'create_session') return { lazy: { cwd: args.cwd, file: null, messages: [] } };
      if (method === 'ensure_agent') return { agent: { id: 'a1', cwd: args.cwd, alive: true }, messages: [] };
      if (method === 'rpc') {
        const cmd = args.cmd;
        if (cmd.type === 'set_model') agentState.model = { provider: cmd.provider, id: cmd.modelId };
        if (cmd.type === 'set_thinking_level') agentState.thinkingLevel = cmd.level;
        return { success: true, data: cmd.type === 'get_state' ? agentState : cmd.type === 'get_available_thinking_levels' ? { levels: ['off', 'low', 'high'] } : {} };
      }
      throw new Error('unexpected RPC: ' + method);
    },
  };
  const util = {
    normPath: (p) => (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(),
    stripAnsi: String, stripAttachments: String,
  };
  const settings = { view: vue.reactive({}), UI: {} };
  const mod = new vm.SourceTextModule(code, { context });
  await mod.link(async (name) => {
    const match = [...code.matchAll(/import \{([^}]+)\} from '([^']+)'/g)].find((x) => x[2] === name);
    const names = match[1].split(',').map((s) => s.trim());
    const values = name === 'vue' ? vue : name === './api.js' ? api : name === './util.js' ? util : settings;
    return new vm.SyntheticModule(names, function () {
      for (const key of names) this.setExport(key, values[key] ?? noop);
    }, { context });
  });
  await mod.evaluate();
  const { S, newSession, newSessionIn, chooseDirectory, setModel, setThinking } = mod.namespace;
  S.cwd = 'C:/project';
  S.activeTab = 'file';
  S.composer.text = 'old draft';
  await newSession();
  assert.equal(S.toasts.length, 0, S.toasts.map((t) => t.text).join('; '));
  assert.equal(S.cwd, 'C:/project');
  assert.equal(S.dirPicker, false);
  assert.equal(S.activeTab, 'chat');
  assert.equal(S.composer.text, '');
  assert.equal(S.composerFocus, 1);
  assert.equal(calls[0].method, 'create_session');
  assert.equal(calls[0].args.cwd, 'C:/project');

  const n = calls.length;
  const model = { provider: 'test', id: 'reasoner', thinkingLevels: ['off', 'low', 'high'] };
  S.models = [model];
  await setModel(model);
  await setThinking('high');
  await vue.nextTick();
  assert.equal(calls.length, n, 'choosing a model and thinking level must not start an agent');
  assert.equal(S.state.model.id, 'reasoner');
  assert.equal(S.state.thinkingLevel, 'high');
  assert.equal(S.lazy.pendingModel.id, 'reasoner');
  assert.equal(S.lazy.pendingThinking, 'high');
  assert.deepEqual([...S.thinkingLevels], ['off', 'low', 'high']);

  S.composer.text = 'unsent';
  S.composer.attachments = [{ path: 'C:/asset.png', status: 'ready' }];
  await vue.nextTick();
  await chooseDirectory('C:/other');
  await vue.nextTick();
  assert.equal(S.cwd, 'C:/other');
  assert.equal(S.composer.text, 'unsent');
  assert.equal(S.composer.attachments[0].path, 'C:/asset.png');

  const beforeSame = calls.length;
  await chooseDirectory('c:\\other\\');
  assert.equal(calls.length, beforeSame, 'same directory does not start another conversation');

  S.messages = [{ role: 'user', content: 'history' }];
  S.agent.saved = true;
  await chooseDirectory('C:/third');
  assert.equal(S.cwd, 'C:/third');
  assert.equal(S.messages.length, 0);
  assert.ok(S.toasts.some((t) => t.text.includes('原对话已保留')));

  fail = true;
  const oldCwd = S.cwd;
  S.composer.text = 'keep on failure';
  await newSessionIn('C:/missing');
  assert.equal(S.cwd, oldCwd);
  assert.equal(S.composer.text, 'keep on failure');

  fail = false;
  S.cwd = '';
  S.info.home = '';
  await newSession();
  assert.equal(S.dirPicker, true);
  assert.equal(S.dirPickerMode, 'new');

  S.cwd = 'C:/history';
  S.lazy = { cwd: S.cwd, file: 'C:/history/session.jsonl' };
  S.models = [model];
  S.state = { model, thinkingLevel: 'low' };
  const beforeEdit = calls.length;
  await setModel(model);
  await setThinking('high');
  assert.equal(calls.length, beforeEdit, 'editing history configuration must not start an agent');
  await mod.namespace.submit('hello');
  assert.equal(S.toasts.filter((t) => t.kind === 'error').length, 1, 'only the intentional missing-directory error remains');
  const commands = calls.slice(beforeEdit).filter((c) => c.method === 'rpc').map((c) => c.args.cmd.type);
  assert.deepEqual(commands.slice(0, 2), ['set_model', 'set_thinking_level']);
  assert.equal(commands.at(-1), 'prompt', 'settings are applied before the first message');
  assert.equal(S.agentId, 'a1');
  assert.equal(S.state.thinkingLevel, 'high');
});
