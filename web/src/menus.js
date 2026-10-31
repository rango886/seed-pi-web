// 右键菜单 / “⋯”菜单的内容。原来顶部菜单栏的功能都在这里。
import {
  S,
  newSession,
  pickSession,
  renameSession,
  pickFork,
  cloneSession,
  compact,
  exportHtml,
  showSessionInfo,
  copyLast,
  setThinking,
  restartAgent,
  openTerminal,
  quitAgent,
  BUILTINS,
} from './store.js';
import { view, toggleSide, UI } from './settings.js';
import { levelName } from './util.js';

const hotkeys = () => BUILTINS.find((b) => b.name === 'hotkeys').run();

export function openModelMenu() {
  S.activeTab = 'chat';
  view.menu = 'model';
}

/** 主菜单。extra 放在最前面（比如“复制选中文字”） */
export function mainMenu(extra = []) {
  const cur = S.state?.thinkingLevel;
  const idle = !S.running;
  return [
    ...extra,
    ...(extra.length ? ['-'] : []),
    { label: '新会话', icon: 'newchat', run: newSession, disabled: !idle },
    { label: '切换会话…', icon: 'history', key: 'Ctrl+P', run: pickSession },
    { label: '切换模型…', icon: 'model', key: 'Ctrl+L', run: openModelMenu },
    S.thinkingLevels.length > 1 && {
      label: '思考强度',
      icon: 'bulb',
      hint: levelName(cur),
      children: S.thinkingLevels.map((l) => ({ label: levelName(l), hint: l, check: l === cur, run: () => setThinking(l) })),
    },
    '-',
    {
      label: '当前会话',
      icon: 'chat',
      children: [
        { label: '重命名…', icon: 'edit', run: () => renameSession() },
        { label: '从某条消息分叉…', icon: 'branch', run: pickFork, disabled: !idle },
        { label: '复制为新会话', icon: 'copy', run: cloneSession, disabled: !idle },
        { label: '压缩上下文', icon: 'compress', run: () => compact(), disabled: !idle },
        '-',
        { label: '复制最后一条回复', icon: 'copy', run: copyLast },
        { label: '导出 HTML', icon: 'export', run: () => exportHtml() },
        { label: '会话信息', icon: 'info', run: showSessionInfo },
      ],
    },
    {
      label: 'pi 进程',
      icon: 'cpu',
      children: [
        { label: '重新加载（扩展/技能/设置）', icon: 'refresh', run: restartAgent },
        { label: '在终端里打开 pi（设置/登录）', icon: 'terminal', run: () => openTerminal({ command: 'pi', title: 'pi' }) },
        '-',
        { label: '关闭这个目录的 pi', icon: 'power', run: quitAgent, danger: true },
      ],
    },
    '-',
    { label: '切换工作目录…', icon: 'folder', run: () => (S.dirPicker = true) },
    { label: '侧栏', icon: 'sidebar', key: 'Ctrl+B', check: view.mobile ? view.drawer : view.side, run: () => toggleSide() },
    { label: '终端', icon: 'terminal', key: 'Ctrl+`', check: S.showTerm, run: () => (S.showTerm = !S.showTerm) },
    {
      label: UI.showMeta ? '隐藏每条回复的模型与用量' : '显示每条回复的模型与用量',
      icon: 'info',
      check: UI.showMeta,
      run: () => (UI.showMeta = !UI.showMeta),
    },
    '-',
    { label: '界面设置', icon: 'settings', key: 'Ctrl+,', run: () => (view.settingsOpen = true) },
    { label: '快捷键', icon: 'keyboard', run: hotkeys },
  ].filter(Boolean);
}

/** 根据右键点到的位置，给出额外的上下文菜单项 */
export function contextExtras(target) {
  const out = [];
  const sel = String(window.getSelection?.() || '').trim();
  if (sel) out.push({ label: '复制选中文字', icon: 'copy', key: 'Ctrl+C', run: () => navigator.clipboard.writeText(sel) });
  const a = target.closest?.('a[href]');
  if (a && /^https?:/.test(a.href)) {
    out.push({ label: '在新标签页打开链接', icon: 'link', run: () => window.open(a.href, '_blank', 'noopener') });
    out.push({ label: '复制链接地址', icon: 'copy', run: () => navigator.clipboard.writeText(a.href) });
  }
  const code = target.closest?.('pre')?.querySelector('code');
  if (code && !sel) out.push({ label: '复制这段代码', icon: 'copy', run: () => navigator.clipboard.writeText(code.innerText) });
  return out;
}
