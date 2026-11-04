// 三个模式各自保存一份；首次读取兼容旧的布局、路径和排序设置。
export function readSessionView(storage, mode) {
  const get = (key) => storage.getItem(`seed-pi-web-${key}-${mode}`);
  const parse = (text, fallback) => {
    try { return JSON.parse(text) ?? fallback; } catch { return fallback; }
  };
  const saved = parse(get('session-view'), {});
  const data = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const collapsed = data.collapsed ?? parse(get('collapsed-dirs'), []);
  return {
    sort: (data.sort ?? storage.getItem('seed-pi-web-sort')) === 'name' ? 'name' : 'time',
    archive: ['active', 'archived', 'all'].includes(data.archive) ? data.archive : 'active',
    layout: (data.layout ?? get('session-layout') ?? (mode === 'fav' ? 'group' : 'flat')) === 'group' ? 'group' : 'flat',
    dirLabel: (data.dirLabel ?? get('dir-label')) === 'path' ? 'path' : 'name',
    showCount: data.showCount !== false,
    showTime: data.showTime !== false,
    showPath: data.showPath !== false,
    collapsed: Array.isArray(collapsed) ? collapsed.filter((p) => typeof p === 'string') : [],
  };
}

export function saveSessionView(storage, mode, settings) {
  storage.setItem(`seed-pi-web-session-view-${mode}`, JSON.stringify(settings));
}

export const matchesArchive = (session, filter) => filter === 'all' || (filter === 'archived' ? !!session.archived : !session.archived);

export function sessionInfo(session, settings, formatTime) {
  if (session.unsaved) return '未保存';
  return [settings.showCount && `${session.messages} 条`, settings.showTime && formatTime(session.modified)].filter(Boolean).join(' · ');
}
