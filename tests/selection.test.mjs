import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const read = file => fs.readFile(new URL('../web/src/' + file, import.meta.url), 'utf8');

test('active rows, parent folders and menu highlights share user-bubble colors across themes', async () => {
  const [css, main] = await Promise.all([read('selection.css'), read('boot.js')]);
  assert.match(css, /--selection-bg: var\(--bubble-me\)/);
  assert.match(css, /--selection-text: var\(--bubble-me-text\)/);
  assert.match(css, /background: var\(--selection-bg\)/);
  assert.match(css, /color: var\(--selection-text\)/);
  for (const selector of ['.sess.active', '.dirhead.active', '.tab.active', '.ib.on', '.mi.cur', '.mi.active', '.option.current', '.select-option.current', '.tree-row.active', '.node.active', '.ctxmenu .mi:not(.dis):is(:hover, .open)']) {
    assert.ok(css.includes(selector), selector);
  }
  assert.match(css, /\.ctxmenu \.mi \{ color: var\(--text\); \}/, 'unselected submenus retain theme text rather than inheriting dark selected text');
  assert.match(css, /& > :is\(/, 'only direct row decorations inherit selected text');
  assert.match(css, /&\.danger \{ color: var\(--err\); \}/);
  assert.doesNotMatch(css, /\.dot\.on|\.sw\.on|\.git-|!important/);
  const selection = main.indexOf("import './selection.css'");
  for (const prior of ["import './github.css'", "import './github-warm.css'", "import './pi.css'", "import App from './App.vue'"]) {
    assert.ok(selection > main.indexOf(prior), prior + ' must load before shared selected styles');
  }
});
