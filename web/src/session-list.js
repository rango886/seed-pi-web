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
    sort: ['time', 'time-asc', 'name', 'name-desc'].includes(data.sort ?? storage.getItem('seed-pi-web-sort')) ? (data.sort ?? storage.getItem('seed-pi-web-sort')) : 'time',
    folderSort: ['time', 'time-asc', 'name', 'name-desc', 'custom'].includes(data.folderSort) ? data.folderSort : 'time',
    folderOrder: Array.isArray(data.folderOrder) ? [...new Set(data.folderOrder.filter((p) => typeof p === 'string'))] : [],
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

const pathKey = (p) => (p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
const folderName = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || '';

export function compareSessions(sort) {
  const byTime = (a, b) => (Date.parse(b.modified) || 0) - (Date.parse(a.modified) || 0);
  const byName = (a, b) => (a.title || '').localeCompare(b.title || '', 'zh');
  return sort === 'name' ? byName : sort === 'name-desc' ? (a, b) => -byName(a, b) : sort === 'time-asc' ? (a, b) => -byTime(a, b) : byTime;
}

export function compareSessionFolders(sort, order = []) {
  const ranks = new Map(order.map((p, i) => [pathKey(p), i]));
  const byTime = (a, b) => b.last - a.last;
  const byName = (a, b) => folderName(a.path).localeCompare(folderName(b.path), 'zh') || a.path.localeCompare(b.path, 'zh');
  return (a, b) => {
    if (sort === 'custom') return (ranks.get(pathKey(a.path)) ?? Infinity) - (ranks.get(pathKey(b.path)) ?? Infinity) || byTime(a, b) || byName(a, b);
    if (sort === 'name' || sort === 'name-desc') return (sort === 'name' ? 1 : -1) * byName(a, b);
    return (sort === 'time-asc' ? -1 : 1) * byTime(a, b) || byName(a, b);
  };
}

// 保留当前搜索/筛选中看不到的目录；新目录追加到已有自定义顺序后面。
export function moveSessionFolder(order, visiblePaths, source, target, after = false) {
  const paths = [...new Map([...order, ...visiblePaths].map((p) => [pathKey(p), p])).values()];
  if (!source || !target || pathKey(source) === pathKey(target)) return paths;
  const from = paths.findIndex((p) => pathKey(p) === pathKey(source));
  if (from < 0 || !paths.some((p) => pathKey(p) === pathKey(target))) return paths;
  const [moved] = paths.splice(from, 1);
  const to = paths.findIndex((p) => pathKey(p) === pathKey(target));
  paths.splice(to + (after ? 1 : 0), 0, moved);
  return paths;
}

export const matchesArchive = (session, filter) => filter === 'all' || (filter === 'archived' ? !!session.archived : !session.archived);

export function sessionInfo(session, settings, formatTime) {
  if (session.unsaved) return '未保存';
  return [settings.showCount && `${session.messages} 条`, settings.showTime && formatTime(session.modified)].filter(Boolean).join(' · ');
}
