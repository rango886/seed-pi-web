// 右键菜单 / “⋯”菜单的内容。原来顶部菜单栏的功能都在这里。
import {
  S,
  newSession,
  openDirPicker,
  pickSession,
  renameSession,
  openBranches,
  cloneSession,
  compact,
  exportHtml,
  showSessionInfo,
  copyLast,
  setThinking,
  restartAgent,
  openTerminal,
  toggleTerminal,
  termIdOf,
  closeAllTabs,
  quitAgent,
  attachFromTree,
  toast,
  BUILTINS,
} from './store.js';
import { view, toggleSide, togglePanel, UI } from './settings.js';
import { levelName, getMsgText } from './util.js';
import { saveLink, saveLocalFile } from './download.js';

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
    { label: '新会话', run: newSession },
    { label: '切换会话', key: 'Ctrl+P', run: pickSession },
    { label: '切换模型', key: 'Ctrl+L', run: openModelMenu },
    S.thinkingLevels.length > 1 && {
      label: '思考强度',
      hint: levelName(cur),
      children: S.thinkingLevels.map((l) => ({ label: levelName(l), hint: l, check: l === cur, run: () => setThinking(l) })),
    },
    '-',
    {
      label: '当前会话',
      children: [
        { label: '重命名', run: () => renameSession() },
        ...(S.cwd ? [{ label: '复制工作目录路径', run: () => navigator.clipboard.writeText(S.cwd).then(() => toast('已复制路径', 'success', 1500)) }] : []),
        { label: '对话分支', run: openBranches },
        { label: '复制为新会话', run: cloneSession, disabled: !idle },
        { label: '压缩上下文', run: () => compact(), disabled: !idle },
        '-',
        { label: '复制最后一条回复', run: copyLast },
        { label: '导出 HTML', run: () => exportHtml() },
        { label: '会话信息', run: showSessionInfo },
      ],
    },
    {
      label: 'pi 进程',
      children: [
        { label: '重新加载（扩展/技能/设置）', run: restartAgent },
        { label: '在终端里打开 pi（设置/登录）', run: () => openTerminal({ command: 'pi', title: 'pi' }) },
        '-',
        { label: '关闭这个会话的 pi', run: quitAgent, danger: true },
      ],
    },
    '-',
    { label: '切换工作目录', run: () => openDirPicker('switch') },
    { label: '会话侧栏', key: 'Ctrl+B', check: view.mobile ? view.drawer : view.side, run: () => toggleSide() },
    { label: '文件', key: 'Ctrl+E', check: view.panel === 'files', run: () => togglePanel('files') },
    { label: '进程', check: view.panel === 'agents', run: () => togglePanel('agents') },
    S.info.terminal && { label: '终端', key: 'Ctrl+`', check: !!termIdOf(S.activeTab), run: toggleTerminal },
    (S.tabs.length || S.terms.length) && { label: '关闭全部标签页', run: () => closeAllTabs() },
    '-',
    { label: '顶栏显示用量', check: UI.topStatus, run: () => (UI.topStatus = !UI.topStatus) },
    {
      label: UI.showMeta ? '隐藏时间、模型与用量' : '显示时间、模型与用量',
      check: UI.showMeta,
      run: () => (UI.showMeta = !UI.showMeta),
    },
    '-',
    { label: '界面设置', key: 'Ctrl+,', run: () => (view.settingsOpen = true) },
    { label: '快捷键', run: hotkeys },
  ].filter(Boolean);
}

/** 根据右键点到的位置，给出额外的上下文菜单项 */
export function contextExtras(target) {
  const out = [];
  const sel = String(window.getSelection?.() || '').trim();
  if (sel) out.push({ label: '复制选中文字', key: 'Ctrl+C', run: () => navigator.clipboard.writeText(sel) });
  // 点在某条消息上：原来悬停出来的“⋯”里的东西，都收进右键菜单
  const msgEl = target.closest?.('[data-msg]');
  if (msgEl) {
    const text = getMsgText(msgEl.dataset.msg);
    if (text) {
      out.push({
        label: '复制这条消息',
        run: () => {
          navigator.clipboard.writeText(text);
          toast('已复制');
        },
      });
    }
    if (msgEl.dataset.role === 'assistant' || msgEl.dataset.role === 'user') {
      out.push({
        label: UI.showMeta ? '隐藏时间、模型与用量' : '显示时间、模型与用量',
        check: UI.showMeta,
        run: () => (UI.showMeta = !UI.showMeta),
      });
    }
  }
  const a = target.closest?.('a[href]');
  const fileA = target.closest?.('a[data-file]');
  if (fileA) {
    const p = fileA.dataset.file;
    out.push({ label: '在标签页中打开', run: () => fileA.click() });
    out.push({ label: '复制文件路径', run: () => navigator.clipboard.writeText(p) });
    out.push({ label: '加到附件（@ 引用）', run: () => attachFromTree(p) });
    out.push({ label: '下载文件', run: () => saveLocalFile(p) });
  }
  if (a && /^https?:/.test(a.href)) {
    out.push({ label: '在新标签页打开链接', run: () => window.open(a.href, '_blank', 'noopener') });
    out.push({ label: '复制链接地址', run: () => navigator.clipboard.writeText(a.href) });
    if (!fileA) out.push({ label: '下载链接', run: () => saveLink(a.href) });
  }
  const code = target.closest?.('pre')?.querySelector('code');
  if (code && !sel) out.push({ label: '复制这段代码', run: () => navigator.clipboard.writeText(code.innerText) });
  return out;
}
