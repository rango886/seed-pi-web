// Test the real directive with a small DOM fixture; template parsing is supplied as trees.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

class Node {
  constructor(tag, attrs = {}, children = []) {
    this.nodeType = tag === '#text' ? 3 : 1;
    this.nodeName = tag === '#text' ? tag : tag.toUpperCase();
    this.localName = tag;
    this.attrs = { ...attrs };
    this.childNodes = [];
    this.nodeValue = tag === '#text' ? children : null;
    if (this.nodeType === 1) children.forEach((n) => this.appendChild(n));
  }
  get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() {
    const siblings = this.parentElement?.childNodes || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(value) { this.replaceChildren(new Node('#text', {}, value)); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
  setAttribute(name, value) { this.attrs[name] = value; }
  removeAttribute(name) { delete this.attrs[name]; }
  appendChild(node) {
    node.remove();
    this.childNodes.push(node);
    node.parentElement = this;
  }
  replaceChild(node, old) {
    node.remove();
    this.childNodes[this.childNodes.indexOf(old)] = node;
    node.parentElement = this;
    old.parentElement = null;
  }
  replaceChildren(...nodes) {
    this.childNodes.forEach((n) => { n.parentElement = null; });
    this.childNodes = [];
    nodes.forEach((n) => this.appendChild(n));
  }
  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.childNodes;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentElement = null;
    }
  }
  matches(selector) {
    if (selector.startsWith('[')) return this.hasAttribute(selector.slice(1, -1));
    const [tag, cls] = selector.split('.');
    return this.localName === tag && (!cls || (this.attrs.class || '').split(' ').includes(cls));
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map((s) => s.trim());
    return this.childNodes.flatMap((n) => [
      ...(n.nodeType === 1 && selectors.some((s) => n.matches(s)) ? [n] : []),
      ...n.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const text = (value) => new Node('#text', {}, value);
const element = (tag, attrs, ...children) => new Node(tag, attrs, children.map((n) => typeof n === 'string' ? text(n) : n));
const block = (code, lang = 'javascript') => element('pre', { class: 'code' },
  element('div', { class: 'code-bar' }, element('span', {}, lang), element('button', { class: 'copy-btn', 'data-copy': '' }, '复制')),
  element('code', { class: 'hljs' }, element('span', { class: 'hljs-keyword' }, code)),
);

async function harness() {
  const fixtures = new Map();
  const document = { createElement(tag) {
    assert.equal(tag, 'template');
    return { set innerHTML(html) { this.content = fixtures.get(html)(); } };
  } };
  const context = vm.createContext({ document });
  const source = await fs.readFile(new URL('../web/src/markdown-html.js', import.meta.url), 'utf8');
  const mod = new vm.SourceTextModule(source, { context });
  await mod.link(() => { throw new Error('unexpected import'); });
  await mod.evaluate();
  const root = element('div', {});
  let resets = 0, previous;
  Object.defineProperty(root, 'innerHTML', { set(html) {
    resets++;
    this.replaceChildren(...fixtures.get(html)().childNodes);
  } });
  return {
    root,
    get resets() { return resets; },
    update(html, ...builders) {
      fixtures.set(html, () => element('fragment', {}, ...builders.map((fn) => fn())));
      mod.namespace.vMarkdownHtml[previous === undefined ? 'mounted' : 'updated'](root, { value: html, oldValue: previous });
      previous = html;
    },
  };
}

test('streaming code keeps its container, toolbar, button and copied feedback', async () => {
  const h = await harness();
  h.update('first', () => block('const a'));
  const pre = h.root.firstChild;
  const bar = pre.firstChild;
  const button = pre.querySelector('button');
  const code = pre.querySelector('code');
  button.textContent = '已复制';
  button._t = 123;
  pre.scrollLeft = 80;
  for (let i = 0; i < 20; i++) {
    h.update(`chunk-${i}`, () => block(`const a = ${i};`));
    assert.equal(h.root.firstChild, pre);
    assert.equal(pre.firstChild, bar);
    assert.equal(pre.querySelector('button'), button);
    assert.equal(pre.querySelector('code'), code);
    assert.equal(code.textContent, `const a = ${i};`);
    assert.equal(button.textContent, '已复制');
    assert.equal(button._t, 123);
    assert.equal(pre.scrollLeft, 80);
  }
  h.update('finished', () => block('const a = 19;'), () => element('p', {}, '完成'));
  assert.equal(pre.querySelector('button'), button);
  assert.equal(h.resets, 1, 'no innerHTML reset after the code block appears');
  assert.equal(h.root.childNodes[1].textContent, '完成');
});

test('plain text fast path switches to patching when a code block appears', async () => {
  const h = await harness();
  h.update('plain', () => element('p', {}, '示例'));
  h.update('code', () => element('p', {}, '示例'), () => block('let'));
  const pre = h.root.querySelector('pre.code');
  h.update('more', () => element('p', {}, '示例'), () => block('let a = 1;'));
  assert.equal(h.root.querySelector('pre.code'), pre);
  assert.equal(h.resets, 2);
  h.update('removed', () => element('p', {}, '没有代码'));
  assert.equal(h.root.querySelector('pre.code'), null);
  assert.equal(h.root.textContent, '没有代码');
});

test('patching still updates language labels and can replace a draft with a diagram', async () => {
  const h = await harness();
  h.update('draft', () => block('graph', 'mermaid'));
  h.update('changed', () => block('graph TD', 'text'));
  assert.equal(h.root.querySelector('span').textContent, 'text');
  h.update('diagram', () => element('div', { 'data-dgm-key': 'diagram-1' }, 'rendered'));
  const diagram = h.root.firstChild;
  diagram.textContent = 'runtime SVG';
  h.update('later', () => element('div', { 'data-dgm-key': 'diagram-1' }, 'rendered'), () => block('next'));
  assert.equal(h.root.firstChild, diagram);
  assert.equal(diagram.textContent, 'runtime SVG');
  h.update('new-diagram', () => element('div', { 'data-dgm-key': 'diagram-2' }, 'new'));
  assert.notEqual(h.root.firstChild, diagram);
});
