import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import * as vue from 'vue';
import { parse, compileScript } from 'vue/compiler-sfc';

async function harness(t) {
  const noop = () => {};
  const storage = new Map(), calls = [];
  const context = vm.createContext({
    console, URL, URLSearchParams, setTimeout: noop, clearTimeout: noop,
    location: { search: '', href: 'http://localhost/' },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    document: { addEventListener: noop, title: '' }, window: {},
  });
  let namespace, fail = false, navigation = {}, entryError = null;
  let entries = [{ id: 'question', type: 'message', message: question() }];
  let snapshot = { leafId: 'answer', nodes: [{ id: 'question', text: 'question', versions: ['question'], targetId: 'answer' }], messages: [] };
  const api = {
    CID: 'owner', http: { get: async () => [] },
    rawUrl: p => '/raw/' + p,
    call: async (method, args) => {
      calls.push({ method, args });
      if (method !== 'rpc') throw new Error('unexpected method: ' + method);
      const cmd = args.cmd;
      if (cmd.type === 'web_edit' || cmd.type === 'web_navigate') {
        if (fail) throw new Error('navigation rejected');
        snapshot = { ...snapshot, leafId: 'new-leaf', messages: [] };
        namespace.dispatch({ t: 'branch_changed', agentId: 'a1', snapshot });
      }
      if (cmd.type === 'get_entries') {
        if (entryError) throw new Error(entryError);
        return { success: true, data: { entries: await entries } };
      }
      if (cmd.type === 'web_navigate') return { success: true, data: navigation };
      if (cmd.type === 'get_web_snapshot') return { success: true, data: snapshot };
      if (cmd.type === 'get_state') return { success: true, data: { model: { id: 'model', provider: 'test' }, thinkingLevel: 'high' } };
      if (cmd.type === 'get_available_thinking_levels') return { success: true, data: { levels: ['low', 'high'] } };
      if (cmd.type === 'get_session_stats') return { success: true, data: { tokens: {}, cost: 0.6 } };
      if (cmd.type === 'fork') namespace.S.agent.sessionFile = 'new-session';
      return { success: true, data: {} };
    },
  };
  const synthetic = (values) => new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context });
  const apiModule = synthetic({ connect: noop, fire: noop, upload: noop, ...api });
  const settings = synthetic({ UI: {}, view: vue.reactive({}) });
  const util = new vm.SourceTextModule(await fs.readFile(new URL('../web/src/util.js', import.meta.url), 'utf8'), { context });
  await util.link(async name => name === './api.js' ? apiModule : name === 'dompurify' ? synthetic({ default: { addHook: noop } }) : synthetic(await import(name)));
  const code = await fs.readFile(new URL('../web/src/store.js', import.meta.url), 'utf8');
  const store = new vm.SourceTextModule(code + '\nexport { onServerMsg as dispatch, openLazy as showLazy };', { context });
  await store.link(async name => name === './util.js' ? util : name === './api.js' ? apiModule : name === './settings.js' ? settings : synthetic(vue));
  await store.evaluate();
  namespace = store.namespace;
  const S = namespace.S;
  S.connected = true;
  S.agentId = 'a1';
  S.agent = { id: 'a1', sessionFile: 'session', cwd: 'C:/test', owner: 'owner', alive: true };
  S.cwd = 'C:/test';
  S.state = { model: { provider: 'test', id: 'model' }, thinkingLevel: 'high' };
  S.conversation = snapshot;
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  return { ...namespace, calls, storage, fail: v => fail = v, snapshot: v => snapshot = v, navigation: v => navigation = v, entries: v => entries = v, entryError: v => entryError = v };
}

const image = { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' };
function question() { return { _entryId: 'question', role: 'user', content: [{ type: 'text', text: 'original\n\n<attachments>\n[1] file: C:/notes.txt\n</attachments>' }, image] }; }

test('inline editing and cancel never navigate; attachments and embedded images are copied independently', async t => {
  const h = await harness(t);
  await h.beginEdit(question());
  assert.equal(h.calls.length, 0);
  assert.equal(h.S.edit.text, 'original');
  assert.equal(h.S.edit.attachments[0].path, 'C:/notes.txt');
  assert.equal(h.S.edit.images[0].data, image.data);
  h.S.edit.images[0].data = 'changed';
  assert.equal(image.data, 'aGVsbG8=');
  h.cancelEdit();
  assert.equal(h.S.edit, null);
  assert.equal(h.calls.length, 0);
});

test('empty edits are rejected, image-only edits send no bogus empty attachment block, and errors retain the draft', async t => {
  const h = await harness(t);
  await h.beginEdit(question());
  h.S.edit.text = '';
  h.S.edit.attachments = [];
  h.S.edit.images = [];
  assert.equal(await h.sendEdit(), false);
  assert.equal(h.calls.length, 0);
  h.S.edit.images = [{ ...image }];
  h.fail(true);
  assert.equal(await h.sendEdit(), false);
  assert.equal(h.S.edit.images.length, 1);
  assert.equal(h.S.edit.error, 'navigation rejected');
  assert.equal(h.S.branchBusy, false);
  const cmd = h.calls.find(c => c.args.cmd.type === 'web_edit').args.cmd;
  assert.equal(cmd.message, '');
  assert.equal(cmd.images[0].data, image.data);
  assert.equal(cmd.expectedLeafId, 'answer');
  h.fail(false);
  assert.equal(await h.sendEdit(), true);
  assert.equal(h.S.edit, null);
});

test('Fork moves to a separate session and restores the selected prompt, files and legacy images into the composer', async t => {
  const h = await harness(t);
  await vue.nextTick();
  await h.forkMessage(question());
  assert.ok(h.calls.some(c => c.args.cmd.type === 'fork' && c.args.cmd.entryId === 'question'));
  assert.equal(h.S.composer.text, 'original');
  assert.equal(h.S.composer.attachments.length, 1);
  assert.equal(h.S.composer.attachments[0].path, 'C:/notes.txt');
  assert.equal(h.S.composer.images[0].data, image.data);
  assert.equal(h.S.branchBusy, false);
});

test('tree navigation restores the selected prompt, files and images ready to send without generation', async t => {
  const h = await harness(t);
  await vue.nextTick();
  h.navigation({ editorText: question().content[0].text, editorImages: [image] });
  const focusStates = [];
  const stopFocusWatch = vue.watch(() => h.S.composerFocus, () => focusStates.push(h.S.branchBusy), { flush: 'sync' });
  t.after(stopFocusWatch);
  assert.equal(await h.switchBranch('question', { toId: 'question', prepare: true }), true);
  const cmd = h.calls.find(c => c.args.cmd.type === 'web_navigate').args.cmd;
  assert.equal(cmd.targetId, 'question');
  assert.equal(cmd.expectedLeafId, 'answer');
  assert.equal(h.S.composer.text, 'original');
  assert.equal(h.S.composer.attachments.length, 1);
  assert.equal(h.S.composer.attachments[0].path, 'C:/notes.txt');
  assert.equal(h.S.composer.images[0].data, image.data);
  assert.equal(h.S.composerFocus, 1);
  assert.deepEqual(focusStates, [false], 'focus is requested only after the restored input is enabled');
  assert.equal(h.S.branchJump.bottom, true);
  assert.ok(!h.calls.some(c => ['prompt', 'web_edit'].includes(c.args.cmd.type)), 'switching never sends the restored prompt');
  assert.equal(h.S.state.thinkingLevel, 'high');
});

test('an already-running bridge without editorText restores a visible prompt from the transcript before it is replaced', async t => {
  const h = await harness(t);
  await vue.nextTick();
  h.S.messages = [question()];
  h.entries([]); // no history RPC is needed when the complete message is visible
  assert.equal(await h.switchBranch('question', { prepare: true }), true);
  assert.equal(h.S.messages.length, 0, 'navigation replaced the sent transcript');
  assert.equal(h.S.composer.text, 'original');
  assert.equal(h.S.composer.attachments[0].path, 'C:/notes.txt');
  assert.equal(h.S.composer.images[0].data, image.data);
  assert.equal(h.S.composerFocus, 1);
  assert.ok(!h.calls.some(c => c.args.cmd.type === 'get_entries'));
});

test('an old bridge restores an inactive branch from the full history, not the shortened tree preview', async t => {
  const h = await harness(t);
  await vue.nextTick();
  const text = '第一行\n\n' + '完整的原始问题。'.repeat(100) + '\n    保留缩进';
  h.S.conversation.nodes[0].text = 'shortened preview…';
  h.entries([{ id: 'question', type: 'message', message: { role: 'user', content: [{ type: 'text', text: text + '\n\n<attachments>\n[1] file: C:/notes.txt\n</attachments>' }, image] } }]);
  assert.equal(await h.switchBranch('question', { prepare: true }), true);
  assert.equal(h.S.composer.text, text);
  assert.equal(h.S.composer.attachments[0].path, 'C:/notes.txt');
  assert.equal(h.S.composer.images[0].data, image.data);
  const commands = h.calls.map(c => c.args.cmd.type);
  assert.ok(commands.indexOf('get_entries') < commands.indexOf('web_navigate'), 'read the prompt before moving the cursor');
  assert.ok(!commands.some(cmd => ['prompt', 'web_edit'].includes(cmd)));
});

test('a missing or unreadable original prompt fails before navigation and preserves unsent content', async t => {
  const h = await harness(t);
  await vue.nextTick();
  h.S.composer.text = 'unsent draft';
  await h.beginEdit(question());
  h.S.edit.text = 'unsent inline edit';
  h.entries([]);
  for (const error of [null, 'failed to read history']) {
    h.entryError(error);
    const moving = h.switchBranch('question', { prepare: true });
    h.S.dialogs.pop()._resolve({ confirmed: true });
    assert.equal(await moving, undefined);
    assert.equal(h.S.composer.text, 'unsent draft');
    assert.equal(h.S.edit.text, 'unsent inline edit');
    assert.equal(h.S.conversation.leafId, 'answer');
    assert.equal(h.S.branchBusy, false);
  }
  assert.ok(!h.calls.some(c => c.args.cmd.type === 'web_navigate'));
});

test('changing sessions while the original prompt loads cannot navigate or overwrite the replacement session', async t => {
  const h = await harness(t);
  await vue.nextTick();
  let resolveEntries;
  h.entries(new Promise(resolve => { resolveEntries = resolve; }));
  const moving = h.switchBranch('question', { prepare: true });
  await vue.nextTick();
  h.S.agent.sessionFile = 'other-session';
  h.S.composer.text = 'new session draft';
  resolveEntries([{ id: 'question', type: 'message', message: question() }]);
  await moving;
  assert.equal(h.S.composer.text, 'new session draft');
  assert.equal(h.S.composerFocus, 0);
  assert.ok(!h.calls.some(c => c.args.cmd.type === 'web_navigate'));
});

test('an unanswered current user node still restores an image-only prompt instead of being treated as a no-op', async t => {
  const h = await harness(t);
  await vue.nextTick();
  h.S.conversation.leafId = 'question';
  h.entries([{ id: 'question', type: 'message', message: { role: 'user', content: [image] } }]);
  assert.equal(await h.switchBranch('question', { prepare: true }), true);
  assert.ok(h.calls.some(c => c.args.cmd.type === 'web_navigate'));
  assert.equal(h.S.composer.text, '');
  assert.equal(h.S.composer.images[0].data, image.data);
});

test('cancelling or rejecting a switch retains unsent edits; confirming replaces the draft only after navigation succeeds', async t => {
  const h = await harness(t);
  await vue.nextTick();
  h.S.composer.text = 'unsent draft';
  await h.beginEdit(question());
  h.S.edit.text = 'unsent inline edit';
  let moving = h.switchBranch('question', { prepare: true });
  h.S.dialogs.pop()._resolve({ confirmed: false });
  await moving;
  assert.equal(h.calls.length, 0);
  assert.equal(h.S.composer.text, 'unsent draft');
  assert.equal(h.S.edit.text, 'unsent inline edit');
  h.fail(true);
  moving = h.switchBranch('question', { prepare: true });
  h.S.dialogs.pop()._resolve({ confirmed: true });
  await moving;
  assert.equal(h.S.composer.text, 'unsent draft');
  assert.equal(h.S.edit.text, 'unsent inline edit');
  assert.equal(h.S.branchJump, null);
  h.fail(false);
  h.navigation({ editorText: 'selected prompt', editorImages: [] });
  h.entries([{ id: 'question', type: 'message', message: { role: 'user', content: 'selected prompt' } }]);
  h.S.composer.attachments = [{ id: 'old-draft-file', status: 'ready', path: 'C:/old.txt' }];
  h.S.composer.images = [{ ...image }];
  moving = h.switchBranch('question', { prepare: true });
  h.S.dialogs.pop()._resolve({ confirmed: true });
  assert.equal(await moving, true);
  assert.equal(h.S.composer.text, 'selected prompt');
  assert.equal(h.S.composer.attachments.length, 0);
  assert.equal(h.S.composer.images.length, 0);
  assert.equal(h.S.edit, null);
  assert.equal(h.S.branchBusy, false);
});

test('lazy tree inspection does not start pi, and viewer/running states cannot start editing', async t => {
  const h = await harness(t);
  h.S.agentId = null;
  h.S.lazy = { file: 'session', cwd: 'C:/test' };
  await h.openBranches();
  assert.equal(h.S.branchesOpen, true);
  assert.equal(h.calls.length, 0);
  h.S.agent.owner = 'someone-else';
  await h.beginEdit(question());
  assert.equal(h.S.edit, null);
  h.S.agent.owner = 'owner';
  h.S.running = true;
  await h.beginEdit(question());
  assert.equal(h.S.edit, null);
});

test('/tree always opens the web branch window, even if a pi extension registers the same command', async t => {
  const h = await harness(t);
  h.S.commands = [{ name: 'tree', description: 'native tree', source: 'extension' }];
  h.S.activeTab = 'file';
  h.S.running = true;
  const originalMessages = h.S.messages;
  assert.equal(await h.submit('/tree'), true);
  assert.equal(h.S.branchesOpen, true);
  assert.equal(h.S.activeTab, 'chat');
  assert.equal(h.S.messages, originalMessages, 'opening the window leaves the transcript unchanged');
  assert.equal(h.S.running, true);
  const commands = h.allCommands().filter(c => c.name === 'tree');
  assert.equal(commands.length, 1, 'the slash menu exposes one unambiguous web command');
  assert.equal(commands[0].desc, '打开对话分支窗口');
  assert.ok(h.calls.every(c => c.args.cmd.type === 'get_web_snapshot'), 'the command neither sends a prompt nor navigates');
  h.S.agentId = null;
  h.S.lazy = { file: 'session', cwd: 'C:/test' };
  h.S.branchesOpen = false;
  h.calls.length = 0;
  assert.equal(await h.submit('/tree'), true);
  assert.equal(h.S.branchesOpen, true);
  assert.equal(h.calls.length, 0, 'opening a lazy tree never starts pi');
});

test('context cache is scoped to both current leaf and model, not merely the session file', async t => {
  const h = await harness(t);
  h.storage.set('seed-pi-web-context-usage', JSON.stringify({ session: { leafId: 'a', model: 'test/model', usage: { percent: 80 } } }));
  const base = { cwd: 'C:/test', file: 'session', messages: [], models: [], state: { model: { provider: 'test', id: 'model' } }, stats: { tokens: {} } };
  h.showLazy({ ...base, conversation: { leafId: 'b', nodes: [] } });
  assert.equal(h.S.stats.contextUsage, undefined);
  h.showLazy({ ...base, conversation: { leafId: 'a', nodes: [] } });
  assert.equal(h.S.stats.contextUsage.percent, 80);
  h.showLazy({ ...base, state: { model: { provider: 'test', id: 'another' } }, conversation: { leafId: 'a', nodes: [] } });
  assert.equal(h.S.stats.contextUsage, undefined);
});

test('label and model-restore notifications update metadata without replacing or scrolling the transcript', async t => {
  const h = await harness(t);
  const m = { _entryId: 'question', _k: 42, role: 'user', timestamp: 1, content: 'original' };
  h.S.messages = [m];
  const original = h.S.messages;
  h.dispatch({ t: 'branch_changed', agentId: 'a1', kind: 'web_label', snapshot: { leafId: 'label', nodes: [{ id: 'question', label: 'renamed', versions: ['question'] }], messages: [m] } });
  assert.equal(h.S.messages, original);
  assert.equal(h.S.messages[0]._k, 42);
  assert.equal(h.S.conversation.nodes[0].label, 'renamed');
});

async function setupBranches(t) {
  const descriptor = parse(await fs.readFile(new URL('../web/src/components/ConversationBranches.vue', import.meta.url), 'utf8')).descriptor;
  const code = compileScript(descriptor, { id: 'tree-test' }).content;
  const S = vue.reactive({ messages: [], conversation: { nodes: Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, parentId: i ? `n${i - 1}` : null, text: `unique${i}`, label: '', versions: [`n${i}`], active: i < 10 })) } });
  const context = vm.createContext({ console });
  const switches = [], labels = [], menus = [], jumps = [], notices = [];
  const disabled = vue.ref(false);
  const store = { S, conversationNodes: vue.computed(() => new Map(S.conversation.nodes.map(n => [n.id, n]))), branchDisabled: disabled, switchBranch: (...args) => { switches.push(args); return true; }, labelBranch: n => labels.push(n.id), restoreBranchSelection() {}, toast: (...args) => notices.push(args) };
  const settings = { openMenu: (x, y, items) => menus.push({ x, y, items }) };
  const mod = new vm.SourceTextModule(code, { context });
  await mod.link(async name => {
    const values = name === 'vue' ? vue : name.endsWith('.vue') ? { default: {} } : name === '../settings.js' ? settings : store;
    return new vm.SyntheticModule(Object.keys(values), function () { for (const [k, v] of Object.entries(values)) this.setExport(k, v); }, { context });
  });
  await mod.evaluate();
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  const s = scope.run(() => mod.namespace.default.setup({}, { expose() {}, emit: (...args) => jumps.push(args) }));
  return { s, S, switches, labels, menus, jumps, disabled, notices };
}

test('long straight paths collapse without hiding the current question; expanding a segment expands the whole segment', async t => {
  const { s, S, switches } = await setupBranches(t);
  assert.ok(s.rows.value.some(row => row.chain));
  assert.ok(s.rows.value.some(row => row.n?.id === 'n9'), 'the current endpoint cannot be buried in an auto-collapsed chain');
  S.conversation.nodes[0].targetId = 'n19';
  S.conversation.nodes[0].turnTargetId = 'answer0';
  await s.navigate(S.conversation.nodes[0]);
  assert.equal(switches[0][0], 'n0', 'explicit switching restores the question before sending, not its answer or descendant');
  assert.equal(switches[0][1].toId, 'n0');
  assert.equal(switches[0][1].prepare, true);
  assert.equal(s.preparedId.value, 'n0');
  s.expandChain('n0');
  assert.equal(s.rows.value.length, 20);
  s.toggle('n0');
  assert.equal(s.rows.value.length, 1);
  s.query.value = 'unique14';
  assert.equal(s.rows.value.length, 15, 'search reveals a matching node and its full ancestry regardless of folds');
});

test('node clicks only locate visible messages, including in read-only or busy states; inactive branches never switch', async t => {
  const { s, S, switches, labels, jumps, notices, disabled } = await setupBranches(t);
  const current = S.conversation.nodes[0], other = S.conversation.nodes[19];
  S.messages = [{ _entryId: current.id }];
  const conversation = S.conversation, messages = S.messages;
  s.jump(current);
  assert.deepEqual(jumps, [['jump', current.id]]);
  disabled.value = true;
  s.jump(current);
  assert.equal(jumps.length, 2, 'jumping is available while running or viewing');
  s.jump(other);
  assert.equal(jumps.length, 2, 'inactive messages cannot be located without changing the context');
  assert.equal(notices.length, 1);
  assert.equal(switches.length, 0);
  assert.equal(labels.length, 0);
  assert.equal(S.conversation, conversation);
  assert.equal(S.messages, messages);
});

test('branch names append to the original prompt for display and remain searchable without replacing text', async t => {
  const { s, S } = await setupBranches(t);
  const n = S.conversation.nodes[7];
  assert.equal(s.nodeTitle(n), 'unique7');
  n.label = '保守方案';
  assert.equal(s.nodeTitle(n), 'unique7 · 保守方案');
  assert.equal(n.text, 'unique7');
  s.query.value = '保守方案';
  assert.equal(s.rows.value.at(-1).n.id, n.id);
  n.label = '';
  assert.equal(s.nodeTitle(n), 'unique7');
});

test('only context-menu switching prepares a prompt; rename and jump keep their separate actions', async t => {
  const { s, S, switches, labels, menus, jumps, disabled } = await setupBranches(t);
  const n = S.conversation.nodes[0];
  n.turnTargetId = 'answer0';
  n.targetId = 'n19';
  s.nodeMenu({ clientX: 120, clientY: 240 }, n);
  assert.equal(switches.length, 0, 'opening a context menu never navigates');
  assert.equal(menus[0].x, 120);
  assert.equal(menus[0].y, 240);
  const items = menus[0].items;
  assert.equal(items.map(it => it.label).join(','), '切换到这里,命名,跳转到消息');
  assert.equal(items[2].disabled, true, 'messages outside the displayed transcript cannot be located');
  await items[0].run();
  assert.equal(switches[0][0], n.id);
  assert.equal(switches[0][1].toId, n.id);
  assert.equal(switches[0][1].prepare, true);
  assert.equal(s.currentId.value, n.id, 'the pending question stays highlighted even though it is not in the sent transcript');
  items[1].run();
  assert.deepEqual(labels, [n.id]);
  s.toggle(n.id);
  assert.equal(switches.length, 1, 'folding is separate from switching');
  S.messages = [{ _entryId: n.id }];
  disabled.value = true;
  s.nodeMenu({ clientX: 1, clientY: 2 }, n);
  const busy = menus[1].items;
  assert.equal(busy[0].disabled, true);
  assert.equal(busy[1].disabled, true);
  assert.equal(busy[2].disabled, false, 'viewers and busy agents can still locate visible messages');
  busy[2].run();
  assert.deepEqual(jumps, [['jump', n.id]]);
  await s.navigate(n);
  assert.equal(switches.length, 1, 'busy or read-only states cannot switch');
  S.conversation.leafId = 'after-send';
  await vue.nextTick();
  assert.equal(s.preparedId.value, null, 'sending or external navigation clears the pending highlight');
});

test('bubble actions stay localized; tree clicks jump and switches are explicit context-menu actions', async () => {
  const read = async name => parse(await fs.readFile(new URL('../web/src/components/' + name, import.meta.url), 'utf8')).descriptor;
  const message = await read('MessageItem.vue');
  assert.match(message.template.content, /title="从此处分叉为新会话"[^>]*@click="forkMessage\(m\)">分叉<\/button>/);
  assert.doesNotMatch(message.template.content, />Fork<\/button>/);
  assert.match(message.styles[0].content, /\.user-actions\.versions \{ opacity: 1; \}/);
  assert.match(message.styles[0].content, /@media \(hover: none\)/);
  const menu = await fs.readFile(new URL('../web/src/menus.js', import.meta.url), 'utf8');
  assert.doesNotMatch(menu, /从某条消息分叉|pickFork/);
  assert.match(menu, /复制为新会话/);
  const tree = (await read('ConversationBranches.vue')).template.content;
  assert.match(tree, /@click="jump\(row.n\)"/);
  assert.doesNotMatch(tree, /@click="navigate\(row.n\)"/);
  const node = tree.match(/<button class="node"[^>]*>/)[0];
  assert.doesNotMatch(node, /:disabled=/);
  assert.match(tree, /class="node-text ellipsis">\{\{ row.n.text \}\}/);
  assert.match(tree, /v-if="row.n.label"[^>]*>· \{\{ row.n.label \}\}/);
  assert.doesNotMatch(tree, /row.n.label \|\| row.n.text/);
  assert.match(tree, /@contextmenu.prevent.stop="nodeMenu\(\$event, row.n\)"/);
  assert.match(tree, /@click.stop="toggle\(row.n.id\)"/);
  assert.doesNotMatch(tree, /preview|selectedId|切换到这里继续|返回上一条路径|定位当前|问题预览|切换会回到|切换只改变/);
  assert.doesNotMatch(tree, /<Icon name="(?:chat|more)"|最近访问|class="recent"/);
  assert.match(tree, /Math.min\(row.depth, 10\) \* 28 \+ 6/);
  assert.match(tree, /stroke-width="2.4"[^>]*><path d="M9 6l6 6-6 6"/);
  const styles = (await read('ConversationBranches.vue')).styles[0].content;
  assert.match(styles, /\.search \{[^}]*margin: 16px 14px;/);
  assert.match(styles, /\.tree-row \{[^}]*gap: 8px;[^}]*height: 28px;/);
  assert.match(styles, /\.arrow \{ width: 20px;/);
  const outline = (await read('ChatOutline.vue')).template.content;
  assert.doesNotMatch(outline, /本会话的问题|class="head"/);
  assert.doesNotMatch(styles, /-webkit-line-clamp/);
  assert.doesNotMatch((await read('UserMessageEditor.vue')).template.content, /修改会创建新分支/);
});

test('branches share the panel styling but sit directly above the same-width composer', async () => {
  const source = async name => fs.readFile(new URL('../web/src/' + name, import.meta.url), 'utf8');
  for (const name of ['RightPanel', 'ConversationBranches']) {
    const component = parse(await source(`components/${name}.vue`)).descriptor;
    assert.match(component.template.content, /<FloatingPanel/);
    assert.doesNotMatch(component.styles[0].content, /\.(?:rpanel|branches)\s*\{/);
  }
  const app = parse(await source('App.vue')).descriptor.template.content;
  assert.doesNotMatch(app, /<ConversationBranches/);
  assert.match(app, /class="ib panel-btn"[^>]*title="对话分支/);
  const chat = parse(await source('components/ChatView.vue')).descriptor.template.content;
  assert.match(chat, /<div ref="dockEl"[\s\S]*<ConversationBranches @jump="jumpEntry" \/>\s*<Composer \/>/);
  const branches = parse(await source('components/ConversationBranches.vue')).descriptor.template.content;
  assert.match(branches, /<FloatingPanel[^>]* inline /);
  assert.doesNotMatch(branches, /:low=/);
  const shell = parse(await source('components/FloatingPanel.vue')).descriptor.styles[0].content;
  assert.match(shell, /\.floating-panel\.inline \{[^}]*position: relative;[^}]*width: 100%;[^}]*max-height:/);
  assert.match(shell, /\.floating-panel\.inline \{[^}]*pointer-events: auto;/);
});
