// 下载用的小工具：灯箱里的“下载”、链接右键菜单里的“下载”都走这里。
import { rawUrl, proxyDownloadUrl, archiveUrl } from './api.js';

/** 让浏览器把一个地址当附件存下来（同源地址 download 属性才生效） */
function clickSave(href, name) {
  const a = document.createElement('a');
  a.href = href;
  if (name != null) a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 存一个 blob */
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  clickSave(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** 从地址里猜个文件名：本地文件取 path 参数里的文件名，网址取最后一段 */
export function nameFromUrl(href) {
  try {
    const u = new URL(href, location.href);
    const p = u.searchParams.get('path');
    if (u.origin === location.origin && p) return p.split(/[\\/]/).pop() || '';
    return decodeURIComponent(u.pathname.split('/').pop() || '');
  } catch {
    return '';
  }
}

/** 下载本地文件（走后端 /api/fs/raw） */
export function saveLocalFile(path) {
  clickSave(rawUrl(path), path.split(/[\\/]/).pop() || 'file');
}

/** 下载已在后端准备好的目录 ZIP，不经过浏览器 Blob 缓冲。 */
export function saveArchive(id, name) {
  clickSave(archiveUrl(id), name);
}

/** 下载一个链接：同源的直接存；别的网站的让后端代下（浏览器对跨域地址会忽略 download 属性，只会跳过去打开） */
export function saveLink(href) {
  let u;
  try {
    u = new URL(href, location.href);
  } catch {
    return;
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.origin === location.origin) return clickSave(u.href, nameFromUrl(u.href) || 'download');
  if (/^https?:$/.test(u.protocol)) clickSave(proxyDownloadUrl(u.href), '');
}
