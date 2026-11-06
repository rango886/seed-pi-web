import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parse } from 'vue/compiler-sfc';

test('composer pickers are compact, without instructional headers or footers', async () => {
  const read = name => fs.readFile(new URL('../web/src/components/' + name, import.meta.url), 'utf8');
  const [composer, model] = await Promise.all([read('Composer.vue'), read('ModelMenu.vue')]);
  const widths = composer.match(/const POP_W = \{ model: (\d+), thinking: (\d+), usage: 270 \}/);
  assert.ok(widths, 'popup alignment has explicit widths');
  assert.match(model, new RegExp(`\\.mm \\{[^}]*width: ${widths[1]}px;`));
  assert.match(composer, new RegExp(`\\.think-pop \\{[^}]*width: ${widths[2]}px;`));
  assert.ok(Number(widths[1]) <= 340);
  assert.ok(Number(widths[2]) <= 180);
  assert.match(model, /\.mi \{[^}]*height: 28px;/);
  assert.match(composer, /\.lv \{[^}]*height: 28px;/);
  assert.match(composer, /\.chip \{[^}]*font-size: var\(--fs-sm\);/);
  assert.match(composer, /\.think-pop \{[^}]*font-size: var\(--fs-sm\);/);
  assert.match(model, /\.mm \{[^}]*font-size: var\(--fs-sm\);/);
  for (const selector of ['gname', 'prov', 'tag']) {
    assert.match(model, new RegExp(`\\.${selector} \\{[^}]*font-size: inherit;`));
  }
  assert.match(composer, /\.small \{[^}]*font-size: inherit;/);
  assert.doesNotMatch(parse(model).descriptor.template.content, /class="foot"|↑↓ 选择/);
  const thinking = parse(composer).descriptor.template.content.match(/<div v-if="menu === 'thinking'"[\s\S]*?(?=<!--)/)[0];
  assert.doesNotMatch(thinking, /pop-title|右键可设为默认/);
  assert.match(thinking, /@contextmenu\.prevent\.stop="thinkMenu/);
  assert.match(model, /@keydown="onKey"/);
  assert.match(model, /@contextmenu\.prevent\.stop="modelMenu/);
});
