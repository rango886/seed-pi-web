// 和后端通信：一条 WebSocket（RPC 转发、事件、终端）+ 几个 HTTP 接口（文件、历史）
const params = new URLSearchParams(location.search);
if (params.get('token')) {
  localStorage.setItem('pi-web-token', params.get('token'));
  // 只把 token 从地址栏去掉，cwd 之类的参数留给 store.js 读
  params.delete('token');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''));
}
const token = localStorage.getItem('pi-web-token') || '';

let ws = null;
let rid = 0;
const waiting = new Map();
let onMessage = () => {};
let onStatus = () => {};

export function connect(handlers) {
  onMessage = handlers.message;
  onStatus = handlers.status;
  open();
}

function open() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`);
  ws.onopen = () => onStatus(true);
  ws.onclose = () => {
    onStatus(false);
    for (const w of waiting.values()) w.reject(new Error('连接已断开'));
    waiting.clear();
    setTimeout(open, 1500);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.t === 'reply') {
      const w = waiting.get(msg.rid);
      if (!w) return;
      waiting.delete(msg.rid);
      msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg.data);
      return;
    }
    onMessage(msg);
  };
}

/** 发一条需要回复的消息 */
export function call(t, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error('未连接到后端'));
    const id = ++rid;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ ...payload, t, rid: id }));
  });
}

/** 发一条不需要回复的消息（终端输入等） */
export function fire(t, payload = {}) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ ...payload, t }));
}

async function req(method, url, query) {
  const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== false)) : '';
  const res = await fetch(url + qs, { method, headers: token ? { 'x-pi-web-token': token } : {} });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export const http = {
  get: (url, query) => req('GET', url, query),
  del: (url, query) => req('DELETE', url, query),
};

export const rawUrl = (p) => `/api/fs/raw?path=${encodeURIComponent(p)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
