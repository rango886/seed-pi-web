// 和后端通信：一条 WebSocket（RPC 转发、事件、终端）+ 几个 HTTP 接口（文件、历史）
const params = new URLSearchParams(location.search);
if (params.get('token')) {
  localStorage.setItem('seed-pi-web-token', params.get('token'));
  // 只把 token 从地址栏去掉，cwd 之类的参数留给 store.js 读
  params.delete('token');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''));
}
const token = localStorage.getItem('seed-pi-web-token') || '';

// 每个浏览器标签页一个 id，后端靠它认“谁是会话的操作者”。
// 存在 sessionStorage 里：刷新不变。但“复制标签页”会把 sessionStorage 也复制过去，所以只有刷新才沿用旧的
const navType = performance.getEntriesByType?.('navigation')?.[0]?.type;
export const CID = (navType === 'reload' && sessionStorage.getItem('seed-pi-web-cid')) || `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
sessionStorage.setItem('seed-pi-web-cid', CID);

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
  const q = new URLSearchParams({ cid: CID });
  if (token) q.set('token', token);
  ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
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

async function req(method, url, query, body) {
  const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== false)) : '';
  const headers = token ? { 'x-seed-pi-web-token': token } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url + qs, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export const http = {
  get: (url, query) => req('GET', url, query),
  post: (url, body) => req('POST', url, null, body),
  del: (url, query) => req('DELETE', url, query),
};

export const rawUrl = (p) => `/api/fs/raw?path=${encodeURIComponent(p)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
/** 让后端代下别的网站的文件（回来的是附件，浏览器直接存，不跳页面） */
export const proxyDownloadUrl = (u) => `/api/download?url=${encodeURIComponent(u)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;

export const archiveUrl = (id) => `/api/fs/archive/${encodeURIComponent(id)}${token ? `?token=${encodeURIComponent(token)}` : ''}`;

/** 上传一个文件：请求体就是文件本身。用 XHR 是为了拿上传进度（fetch 拿不到） */
export function upload(file, query, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (token) xhr.setRequestHeader('x-seed-pi-web-token', token);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      xhr.status < 300 ? resolve(data) : reject(new Error(data.error || `上传失败（${xhr.status}）`));
    };
    xhr.onerror = () => reject(new Error('上传失败：连接断了'));
    xhr.send(file);
  });
}
