// 全侧栏共用一份状态；文件节点只查询内存索引，不逐文件启动 Git。
import { reactive, computed, watch, onMounted, onUnmounted } from 'vue';
import { S, loadFile } from './store.js';
import { http } from './api.js';
import { view } from './settings.js';

export const G = reactive({ cwd: '', data: null, loading: false, error: '' });
export const diffNames = { staged: '已暂存', working: '未暂存', head: '全部变更' };
export const statusNames = { M: '已修改', A: '已新增', U: '未跟踪', D: '已删除', R: '已重命名', C: '已复制', T: '类型变化', '!': '合并冲突', '.': '子模块内部变更' };
const key = (p) => {
  const s = p.replace(/\\/g, '/').replace(/\/$/, '');
  return S.info.platform === 'win32' ? s.toLowerCase() : s;
};
export const repoPath = (rel) => G.data.root.replace(/[\\/]$/, '') + '/' + rel;
const rank = { '!': 10, D: 8, M: 7, T: 6, R: 5, C: 4, A: 3, U: 2, '.': 1 };
const index = computed(() => {
  const files = new Map(), dirs = new Map();
  const d = G.data;
  if (d?.available) for (const e of d.entries) {
    const p = key(repoPath(e.path));
    const state = { code: e.status === '?' ? 'U' : e.status, entry: e };
    const decorate = (file, mark) => {
      files.set(file, mark);
      let dir = file;
      const root = key(d.root);
      while (dir.includes('/')) {
        dir = dir.slice(0, dir.lastIndexOf('/'));
        if (dir.length < root.length) break;
        const prev = dirs.get(dir);
        if (!prev || (rank[mark.code] || 1) > (rank[prev.code] || 1)) dirs.set(dir, mark);
      }
    };
    decorate(p, state);
    if (e.oldPath && (e.x === 'R' || e.y === 'R') && key(repoPath(e.oldPath)) !== p) decorate(key(repoPath(e.oldPath)), { code: 'D', entry: e });
  }
  return { files, dirs, ignored: new Set((d?.ignored || []).map((p) => key(repoPath(p)))) };
});
export function gitMark(path, dir = false) {
  if (G.cwd !== S.cwd || !G.data?.available) return null;
  const p = key(path);
  const root = key(G.data.root);
  if (p.startsWith(root + '/') && p.slice(root.length + 1).split('/').includes('.git')) return { ignored: true, title: 'Git 内部文件' };
  const state = (dir ? index.value.dirs.get(p) || index.value.files.get(p) : index.value.files.get(p));
  if (state) {
    const e = state.entry;
    const detail = !dir && e.x !== '?' && !e.conflict
      ? `\n暂存区：${e.x === '.' ? '无变化' : statusNames[e.x] || e.x}；工作区：${e.y === '.' ? '无变化' : statusNames[e.y] || e.y}` : '';
    return { ...state, title: (statusNames[state.code] || '子模块内部变更') + detail, dir };
  }
  let parent = p;
  while (parent.includes('/')) {
    if (index.value.ignored.has(parent)) return { ignored: true, title: '被 Git 忽略' };
    parent = parent.slice(0, parent.lastIndexOf('/'));
  }
  return null;
}
export const changeGroups = computed(() => {
  const entries = G.data?.entries || [];
  const conflicts = entries.filter((e) => e.conflict).map((e) => ({ ...e, code: '!' }));
  const staged = entries.filter((e) => !e.conflict && e.x !== '.' && e.x !== '?').map((e) => ({ ...e, code: e.x }));
  const working = entries.filter((e) => !e.conflict && (e.y !== '.' || e.sub?.slice(2).includes('M') || e.sub?.slice(2).includes('U')))
    .map((e) => ({ ...e, code: e.y === '?' ? 'U' : e.y === '.' ? 'M' : e.y }));
  return [
    { key: 'conflicts', title: '合并更改', mode: 'working', entries: conflicts },
    { key: 'staged', title: '暂存的更改', mode: 'staged', entries: staged },
    { key: 'working', title: '更改', mode: 'working', entries: working },
  ].filter((g) => g.entries.length);
});

let serial = 0;
export async function refreshGit() {
  const cwd = S.cwd;
  if (!cwd) return;
  const id = ++serial;
  G.cwd = cwd;
  G.loading = true;
  try {
    const data = await http.get('/api/git/status', { cwd, fresh: '1' });
    if (id !== serial || cwd !== S.cwd) return;
    G.data = data;
    G.error = '';
  } catch (e) {
    if (id === serial && cwd === S.cwd) G.error = e.message;
  } finally {
    if (id === serial) G.loading = false;
  }
}
export function useGitRefresh() {
  let timer, interval;
  const needed = () => view.panel === 'files' || S.tabs.length > 0;
  const schedule = () => {
    clearTimeout(timer);
    if (needed() && !document.hidden) timer = setTimeout(refreshGit, 300);
  };
  const stop = watch(() => [S.cwd, S.fsEpoch, S.connEpoch, view.panel, S.tabs.length], ([cwd], old) => {
    if (cwd !== old?.[0]) {
      serial++;
      G.cwd = cwd;
      G.data = null;
      G.error = '';
      G.loading = false;
    }
    schedule();
  }, { immediate: true });
  const focus = () => {
    schedule();
    const active = S.tabs.find((t) => t.id === S.activeTab);
    if (active?.diff && !active.loading && !document.hidden) loadFile(active);
  };
  onMounted(() => {
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    interval = setInterval(() => {
      if (needed() && !document.hidden && !G.loading) refreshGit();
    }, 5000);
  });
  onUnmounted(() => {
    stop();
    clearTimeout(timer);
    clearInterval(interval);
    window.removeEventListener('focus', focus);
    document.removeEventListener('visibilitychange', focus);
  });
}
