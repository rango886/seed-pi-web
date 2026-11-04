import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import { prefixSvgIds } from '../web/src/diagram-svg.js';

const markup = '<svg id="chart"><defs><marker id="edge"/><clipPath id="edge-long"/></defs><path marker-end="url(#edge)" clip-path="url(#edge-long)"/><use href="#edge" xlink:href="#edge-long"/></svg>';

test('cached copies and lightbox SVGs have independent ids and local references', () => {
  const first = prefixSvgIds(markup, 'dgm1-');
  const second = prefixSvgIds(markup, 'dgm2-');
  assert.match(first, /id="dgm1-chart"/);
  assert.match(first, /url\(#dgm1-edge\)/);
  assert.match(first, /url\(#dgm1-edge-long\)/);
  assert.match(first, /href="#dgm1-edge"/);
  assert.match(first, /xlink:href="#dgm1-edge-long"/);
  assert.ok(!second.includes('dgm1-'));
  assert.match(prefixSvgIds(first, 'lb1-'), /url\(#lb1-dgm1-edge-long\)/);
  assert.equal(prefixSvgIds('<svg><text>no ids</text></svg>', 'dgm3-'), '<svg><text>no ids</text></svg>');
  assert.equal(prefixSvgIds('<svg id="a.b"><use href="#a.b"/></svg>', 'new-'), '<svg id="new-a.b"><use href="#new-a.b"/></svg>');
  const accessible = prefixSvgIds('<svg aria-labelledby="title external" aria-describedby="desc"><title id="title"/><desc id="desc"/><style>#title.label {fill:red}</style><g data-id="series"/></svg>', 'copy-');
  assert.match(accessible, /aria-labelledby="copy-title external"/);
  assert.match(accessible, /aria-describedby="copy-desc"/);
  assert.match(accessible, /#copy-title\.label/);
  assert.match(accessible, /data-id="series"/);
});

async function harness() {
  const boxes = [];
  const calls = [];
  let notify, resolveImport, rejectImport, attempts = 0;
  const context = vm.createContext({
    document: {
      body: {}, addEventListener() {},
      getElementsByClassName: () => boxes.filter((box) => box.isConnected),
      querySelectorAll: () => boxes.filter((box) => box.isConnected),
    },
    MutationObserver: class { constructor(callback) { notify = callback; } observe() {} },
  });
  const zoomModule = new vm.SyntheticModule(['enableZoom'], function () {
    this.setExport('enableZoom', (box) => {
      const call = { box, svg: box.firstElementChild, destroyed: false };
      calls.push(call);
      return { destroy() { call.destroyed = true; }, refresh() {} };
    });
  }, { context });
  await zoomModule.link(() => {});
  await zoomModule.evaluate();
  const source = await fs.readFile(new URL('../web/src/diagram.js', import.meta.url), 'utf8');
  const mod = new vm.SourceTextModule(source, { context, importModuleDynamically() {
    attempts++;
    return new Promise((resolve, reject) => { resolveImport = () => resolve(zoomModule); rejectImport = reject; });
  } });
  await mod.link((name) => {
    const values = name === './settings.js' ? { openLightbox() {} } : { prefixSvgIds };
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await mod.evaluate();
  mod.namespace.startDiagramBinder();
  function makeSvg(box, html = markup) {
    return {
      nodeType: 1, localName: 'svg', getAttribute: () => '0 0 400 300',
      get outerHTML() { return html; },
      set outerHTML(value) { box.firstElementChild = makeSvg(box, value); },
    };
  }
  return {
    calls,
    get attempts() { return attempts; },
    resolve: () => resolveImport(), reject: () => rejectImport(new Error('temporary module load failure')),
    box() {
      const box = { nodeType: 1, isConnected: true, dataset: {},
        matches: (selector) => selector === '.md-diagram', closest() { return this; },
      };
      box.firstElementChild = makeSvg(box);
      boxes.push(box);
      return box;
    },
    insert(box) { notify([{ target: {}, addedNodes: [box], removedNodes: [] }]); },
    remove(box) { box.isConnected = false; notify([{ target: {}, addedNodes: [], removedNodes: [box] }]); },
    replaceSvg(box) {
      const old = box.firstElementChild;
      box.firstElementChild = makeSvg(box);
      notify([{ target: box, addedNodes: [box.firstElementChild], removedNodes: [old] }]);
    },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('switching away while pele loads does not poison initialization on return', async () => {
  const h = await harness();
  const box = h.box();
  h.insert(box);
  assert.equal(box.dataset.dgm, undefined, 'not bound before async initialization finishes');
  h.remove(box);
  h.resolve();
  await flush();
  assert.equal(h.calls.length, 0);
  box.isConnected = true;
  h.insert(box);
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(box.dataset.dgm, '1');
  h.insert(box);
  await flush();
  assert.equal(h.calls.length, 1, 'the same SVG is not initialized twice');
  h.remove(box);
  assert.equal(h.calls[0].destroyed, true, 'old session releases its zoom observer');
});

test('in-place SVG replacement binds the new SVG and ignores stale async work', async () => {
  const h = await harness();
  const box = h.box();
  h.insert(box);
  h.replaceSvg(box);
  h.resolve();
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].svg, box.firstElementChild);
  h.replaceSvg(box);
  await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].destroyed, true);
  assert.equal(h.calls[1].svg, box.firstElementChild);
});

test('a failed module load can be retried when the diagram is reinserted', async () => {
  const h = await harness();
  const box = h.box();
  h.insert(box);
  h.reject();
  await flush();
  assert.equal(box.dataset.dgm, undefined);
  h.remove(box);
  box.isConnected = true;
  h.insert(box);
  assert.equal(h.attempts, 2);
  h.resolve();
  await flush();
  assert.equal(h.calls.length, 1);
});
