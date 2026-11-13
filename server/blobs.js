// 工具返回的大图（read 读图片时，图片以 base64 塞在 toolResult 里）不随会话消息一起发给前端：
// 一个会话里几十张图就是十几 MB，每次点开会话都要传一遍、解析一遍，很卡。
// 发消息前把图换成一个编号，图本身留在内存里，前端展开工具卡片时再按编号用 <img> 去要（浏览器还能缓存）。
// 只换 toolResult 里的：用户消息里的图前端编辑重发时要用原始数据。
import crypto from 'node:crypto';

const MIN_SIZE = 16 * 1024; // 小图直接带着，省一次请求
const MAX_TOTAL = 256 * 1024 * 1024; // 内存里最多留这么多（base64 长度），超了先丢最久没用的
const store = new Map(); // id -> { mimeType, data }，Map 的顺序就是最近使用顺序
let total = 0;

function put(mimeType, data) {
  const id = crypto.createHash('sha1').update(data).digest('hex');
  const hit = store.get(id);
  if (hit) {
    store.delete(id);
    store.set(id, hit);
    return id;
  }
  store.set(id, { mimeType, data });
  total += data.length;
  for (const [k, v] of store) {
    if (total <= MAX_TOTAL || k === id) break;
    store.delete(k);
    total -= v.data.length;
  }
  return id;
}

export function getBlob(id) {
  const b = store.get(id);
  if (!b) return null;
  store.delete(id);
  store.set(id, b);
  return b;
}

const bigImage = (c) => c?.type === 'image' && typeof c.data === 'string' && c.data.length >= MIN_SIZE;

/** JSON.stringify 的 replacer：toolResult 消息里的大图换成 { type: 'image', mimeType, blob: id } */
export function blobReplacer(_key, value) {
  if (value && value.role === 'toolResult' && Array.isArray(value.content) && value.content.some(bigImage)) {
    return { ...value, content: value.content.map((c) => (bigImage(c) ? { type: 'image', mimeType: c.mimeType, blob: put(c.mimeType, c.data) } : c)) };
  }
  return value;
}
