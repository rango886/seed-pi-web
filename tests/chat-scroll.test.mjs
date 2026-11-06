// Exercise the real chat SFCs, including queued Vue updates and resize callbacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import * as vue from 'vue';
import { parse, compileScript } from 'vue/compiler-sfc';

async function setup(t, file = 'ChatView.vue', props = {}) {
  const source = await fs.readFile(new URL('../web/src/components/' + file, import.meta.url), 'utf8');
  const descriptor = parse(source).descriptor;
  const code = compileScript(descriptor, { id: 'test' }).content;
  const mounted = [], unmounted = [], observers = [], frames = [], timers = [], events = [];
  const noop = () => {};
  const S = vue.reactive({ messages: [], tick: 0, activeTab: 'chat', widgets: {}, queue: { steering: [], followUp: [] } });
  const context = vm.createContext({
    console,
    window: { addEventListener: noop, removeEventListener: noop },
    CSS: { escape: String },
    requestAnimationFrame: (cb) => (frames.push(cb), frames.length),
    cancelAnimationFrame: noop,
    setTimeout: (cb) => (timers.push(cb), timers.length),
    clearTimeout: noop,
    ResizeObserver: class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe(el) { this.el = el; }
      disconnect() {}
    },
  });
  const imports = {
    '../store.js': { S, openDirPicker: noop, restartExited: noop, viewer: false },
    '../settings.js': { UI: {}, view: {}, openLightbox: noop },
    '../util.js': { textOf: String, splitAttachments: (text) => ({ text, attachments: [] }) },
  };
  const mod = new vm.SourceTextModule(code, { context });
  await mod.link(async (name) => {
    const values = name === 'vue'
      ? { ...vue, onMounted: (cb) => mounted.push(cb), onUnmounted: (cb) => unmounted.push(cb) }
      : name.endsWith('.vue') ? { default: {} } : imports[name];
    assert.ok(values, 'missing mock: ' + name);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [k, v] of Object.entries(values)) this.setExport(k, v);
    }, { context });
  });
  await mod.evaluate();
  const scope = vue.effectScope();
  const state = scope.run(() => mod.namespace.default.setup(props, { expose: noop, emit: (...args) => events.push(args) }));
  t.after(() => { unmounted.forEach((cb) => cb()); scope.stop(); });
  return { state, S, descriptor, frames, timers, events, mount: () => mounted.forEach((cb) => cb()), resize: () => observers[0].cb() };
}

function scroller() {
  let top = 2400;
  return vue.markRaw({
    scrollHeight: 3000, clientHeight: 600, offsetWidth: 1000, clientWidth: 990,
    get scrollTop() { return top; },
    set scrollTop(value) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    scrollTo({ top }) { this.scrollTop = top; },
  });
}

async function chat(t) {
  const h = await setup(t);
  const el = scroller();
  h.state.scroller.value = el;
  h.state.inner.value = {};
  h.mount();
  return { ...h, el };
}

test('long replies follow the bottom, but resizing does not override manual reading', async (t) => {
  const { state: s, el, resize } = await chat(t);
  el.scrollHeight += 12000;
  resize();
  assert.equal(el.scrollTop, 14400);
  el.scrollTop = 4000;
  s.onScroll();
  assert.equal(s.away.value, true);
  el.scrollHeight += 2000;
  resize();
  assert.equal(el.scrollTop, 4000);
  el.scrollTop += 200;
  s.onScroll();
  resize();
  assert.equal(el.scrollTop, 4200, 'downward scrolling remains under user control');
  s.jumpBottom();
  s.onScroll();
  assert.equal(el.scrollTop, 16400);
  assert.equal(s.away.value, false);
});

test('expanding welcome shortcuts does not jump to the end of the list', async (t) => {
  const { state: s, el, resize } = await chat(t);
  el.scrollTop = 0;
  s.shortcutsOpen.value = true;
  el.scrollHeight += 1000;
  resize();
  assert.equal(el.scrollTop, 0);
});

test('queued streaming autoscroll rechecks whether the user has scrolled away', async (t) => {
  const { state: s, S, el } = await chat(t);
  S.tick++;
  await vue.nextTick(); // watcher has queued toBottom, but it has not run yet
  el.scrollTop = 1000;
  s.onScroll();
  await vue.nextTick();
  assert.equal(el.scrollTop, 1000, 'a stale nextTick must not pull the viewport back down');
});

test('switching to a short conversation clears the bottom button', async (t) => {
  const { state: s, S, el } = await chat(t);
  el.scrollTop = 100;
  s.onScroll();
  assert.equal(s.away.value, true);
  el.scrollHeight = 400;
  S.messages = [{ role: 'user', content: 'new conversation' }];
  await vue.nextTick();
  await vue.nextTick();
  assert.equal(el.scrollTop, 0);
  assert.equal(s.away.value, false);
});

test('switching a version keeps the fork question at its previous viewport offset', async (t) => {
  const { S, el, resize } = await chat(t);
  el.scrollHeight = 10000;
  el.scrollTop = 1000;
  el.getBoundingClientRect = () => ({ top: 0 });
  el.querySelector = (selector) => selector.includes('old')
    ? { getBoundingClientRect: () => ({ top: 300 }) }
    : { getBoundingClientRect: () => ({ top: 2200 - el.scrollTop }) };
  S.branchJump = { fromId: 'old', toId: 'new' };
  S.messages = [{ role: 'user', content: 'alternative' }];
  await vue.nextTick();
  await vue.nextTick();
  assert.equal(el.scrollTop, 1900);
  assert.equal(S.branchJump, null);
  resize();
  assert.equal(el.scrollTop, 1900, 'a resize after switching must not pull the reader to the end');
});

test('Home/End do not schedule corrections that overwrite subsequent manual scrolling', async (t) => {
  const { state: s, el, frames } = await chat(t);
  s.jumpTo(true);
  assert.equal(el.scrollTop, 0);
  el.scrollTop = 200;
  s.onScroll();
  frames.splice(0).forEach((cb) => cb());
  assert.equal(el.scrollTop, 200);
  s.jumpTo(false);
  assert.equal(el.scrollTop, 2400);
  el.scrollTop -= 200;
  s.onScroll();
  frames.splice(0).forEach((cb) => cb());
  assert.equal(el.scrollTop, 2200);
});

test('chat messages use real layout heights, not offscreen placeholder heights', async (t) => {
  const { descriptor } = await setup(t);
  const css = descriptor.styles.map((style) => style.content).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /content-visibility\s*:\s*auto|contain-intrinsic-size/);
  assert.doesNotMatch(descriptor.template.content, /live:\s*i\s*>=/);
});

test('outline jumps do not leave delayed scroll corrections behind', async (t) => {
  const el = scroller();
  const wrapper = {
    getBoundingClientRect: () => ({ top: 1000 - el.scrollTop }),
    classList: { remove() {}, add() {} }, offsetWidth: 100,
  };
  el.getBoundingClientRect = () => ({ top: 0 });
  el.querySelector = () => ({ closest: () => wrapper });
  const listeners = new Map();
  el.addEventListener = (type, cb) => listeners.set(type, cb);
  el.removeEventListener = (type) => listeners.delete(type);
  const { state: s, events, timers } = await setup(t, 'ChatOutline.vue', { scroller: el });
  s.jump('question');
  assert.deepEqual(events, [['jump']]);
  assert.equal(el.scrollTop, 988);
  el.scrollTop += 200; // user continues reading after the jump
  listeners.get('scrollend')?.();
  timers.forEach((cb) => cb());
  assert.equal(el.scrollTop, 1188, 'neither scrollend nor a timeout may undo manual scrolling');
});
