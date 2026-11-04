import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parse, compileStyle } from 'vue/compiler-sfc';

test('mobile chat gutters override desktop gutters with the same scoped specificity', async () => {
  const source = await fs.readFile(new URL('../web/src/components/ChatView.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const css = descriptor.styles.map((style) => {
    const result = compileStyle({ source: style.content, filename: 'ChatView.vue', id: 'data-v-test', scoped: style.scoped });
    assert.deepEqual(result.errors, []);
    return result.code;
  }).join('\n');
  const desktop = css.match(/(\.chat\[data-v-test\])\s*\{\s*--gut:\s*calc\(var\(--sp5\) \+ 48px\)/);
  assert.ok(desktop);
  const mobile = css.slice(css.indexOf('@media (max-width: 768px)'));
  assert.ok(mobile.includes(desktop[1] + ' { --gut: 16px;'), 'mobile gutter must have the same specificity as desktop');
  assert.match(mobile, /\.scroll\[data-v-test\]\s*\{\s*scrollbar-gutter: auto;/);
  assert.match(mobile, /padding: 0 calc\(var\(--gut\) - 6px\)/);
});
