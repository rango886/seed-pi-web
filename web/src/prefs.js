// 网页的偏好设置存在后端（~/.seed-pi-web/prefs.json），局域网里哪台设备打开都是同一份。
//
// 做法：页面启动时先把整份设置拉下来放进内存，然后把全局的 localStorage 换成一个“长得一样”的对象：
//   读：直接从内存里拿（同步，和原来一样，各处代码不用改）
//   写：先改内存，再攒一小会儿（300ms）把改动的键一次发给后端
// 所以项目里其他地方照旧写 localStorage.getItem / setItem，实际读写的是后端那份。
//
// 例外：访问令牌（seed-pi-web-token）必须留在浏览器里——要先拿着它才能找后端要设置。
// 这个文件必须在其他模块之前加载完（见 main.js），因为 settings.js 等模块一加载就会读设置。
const LOCAL_ONLY = new Set(['seed-pi-web-token']);
const real = window.localStorage;
const data = new Map();
const pendingSet = new Map();
const pendingRemove = new Set();
let timer = null;
let frozen = false; // 导入备份时冻结：后面不再往后端写，免得把刚导入的内容盖回去

function token() {
  return new URLSearchParams(location.search).get('token') || real.getItem('seed-pi-web-token') || '';
}
const headers = () => {
  const t = token();
  return t ? { 'x-seed-pi-web-token': t } : {};
};

function schedule() {
  if (frozen) return;
  clearTimeout(timer);
  timer = setTimeout(flushPrefs, 300);
}

/** 把攒着的改动立刻发给后端 */
export async function flushPrefs({ keepalive = false } = {}) {
  clearTimeout(timer);
  timer = null;
  if (frozen || (!pendingSet.size && !pendingRemove.size)) return;
  const body = { set: Object.fromEntries(pendingSet), remove: [...pendingRemove] };
  pendingSet.clear();
  pendingRemove.clear();
  try {
    const res = await fetch('/api/prefs', { method: 'POST', keepalive, headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(res.statusText);
  } catch (e) {
    console.warn('[prefs] 设置没存上：', e.message);
  }
}

/** 导入备份前调用：丢掉还没发出去的改动，之后也不再写后端（马上要刷新页面了） */
export function freezePrefs() {
  frozen = true;
  clearTimeout(timer);
  pendingSet.clear();
  pendingRemove.clear();
}

const store = {
  getItem(k) {
    k = String(k);
    if (LOCAL_ONLY.has(k)) return real.getItem(k);
    return data.has(k) ? data.get(k) : null;
  },
  setItem(k, v) {
    k = String(k);
    v = String(v);
    if (LOCAL_ONLY.has(k)) return real.setItem(k, v);
    if (data.get(k) === v) return;
    data.set(k, v);
    pendingRemove.delete(k);
    pendingSet.set(k, v);
    schedule();
  },
  removeItem(k) {
    k = String(k);
    if (LOCAL_ONLY.has(k)) return real.removeItem(k);
    if (!data.has(k)) return;
    data.delete(k);
    pendingSet.delete(k);
    pendingRemove.add(k);
    schedule();
  },
  key(i) {
    return [...data.keys()][i] ?? null;
  },
  get length() {
    return data.size;
  },
};

/** 启动时调用一次：拉设置、换掉全局 localStorage */
export async function installPrefs() {
  try {
    const res = await fetch('/api/prefs', { headers: headers() });
    if (!res.ok) throw new Error(res.statusText);
    for (const [k, v] of Object.entries(await res.json())) if (typeof v === 'string') data.set(k, v);
  } catch (e) {
    // 后端没连上或令牌不对：先用空设置跑起来（界面是默认样子），连上之后改的设置照样能存
    console.warn('[prefs] 读取设置失败，先用默认值：', e.message);
  }
  Object.defineProperty(window, 'localStorage', { value: store, configurable: true });
  // 关页面 / 切走时把没发出去的改动发掉（keepalive：页面关了请求也能发完）
  addEventListener('pagehide', () => flushPrefs({ keepalive: true }));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushPrefs({ keepalive: true }));
}
