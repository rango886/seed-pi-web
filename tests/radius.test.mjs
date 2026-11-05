import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const read = (path) => fs.readFile(new URL('../web/src/' + path, import.meta.url), 'utf8');

function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp('(?:^|\\n)' + escaped + ' \\{([^}]+)\\}'));
  assert.ok(match, selector);
  return match[1];
}

test('all UI radius aliases use the global value and themes cannot multiply it', async () => {
  const [base, github, pi] = await Promise.all([read('style.css'), read('github.css'), read('pi.css')]);
  for (const name of ['xs', 'sm', 'md', 'lg', 'xl', 'pill', 'bubble']) {
    const declaration = `--r-${name}: var(--r);`;
    assert.ok(base.includes(declaration), declaration);
    assert.doesNotMatch(github + pi, new RegExp('--r-' + name + ':'));
  }
  assert.doesNotMatch(base + github + pi, /--r-[\w-]+:\s*calc\(var\(--r\)\s*\*/);
  assert.match(base, /--r-inner: max\(0px, calc\(var\(--r\) - 1px\)\)/);
  assert.match(base, /--r-inset: max\(0px, calc\(var\(--r\) - 2px\)\)/);
});

test('buttons, popups, message bubbles and pi Markdown use adjustable rather than fixed or circular corners', async () => {
  const [base, composer, chat, settings, picker, lightbox, message, pi, directory] = await Promise.all([
    read('style.css'), read('components/Composer.vue'), read('components/ChatView.vue'),
    read('components/Settings.vue'), read('components/DirPicker.vue'), read('components/Lightbox.vue'),
    read('components/MessageItem.vue'), read('pi.css'), read('components/DirectoryMenu.vue'),
  ]);
  for (const [css, selectors] of [
    [base, ['.btn', '.input', '.modal', '.pop', '.switch', '.mp-video .mp-big', '.mp-audio .mp-round']],
    [composer, ['.box', '.ibtn', '.chip', '.round', '.att .x']],
    [chat, ['.tobottom']], [settings, ['.sw']], [picker, ['.favdel']], [lightbox, ['.lb-nav']],
  ]) {
    for (const selector of selectors) assert.match(rule(css, selector), /border-radius: var\(--r(?:-[\w-]+)?\)/);
  }
  assert.doesNotMatch(message, /border-top-right-radius:/);
  assert.match(rule(message, '.bubble'), /border-radius: var\(--r-bubble\)/);
  assert.doesNotMatch(pi, /border-radius:\s*[1-9]\d*px/);
  for (const css of [composer, message]) {
    assert.match(rule(css, '.att .aline'), /border-radius: 0 0 var\(--r-inner\) var\(--r-inner\)/);
  }
  assert.match(base, /border-radius: var\(--r-inset\)/);
  assert.doesNotMatch(composer + directory, /transition: all/, 'radius changes must apply synchronously to all controls');
});

test('round status indicators keep their geometry while settings explain the global radius behavior', async () => {
  const [base, side, settings] = await Promise.all([read('style.css'), read('components/SidePanel.vue'), read('components/Settings.vue')]);
  for (const selector of ['.spin', '.dot']) assert.match(rule(base, selector), /border-radius: 50%/);
  assert.match(rule(side, '.st'), /border-radius: 50%/);
  assert.match(settings, /圆角值统一用于按钮、输入框、菜单、弹窗和气泡/);
  assert.match(settings, /设为 0 即直角/);
});
