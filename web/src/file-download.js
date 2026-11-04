import { reactive } from 'vue';
import { ask, toast } from './store.js';
import { http } from './api.js';
import { saveLocalFile, saveArchive } from './download.js';

export const packing = reactive(new Set());
const choosing = new Set();
export async function downloadPath(path, dir = false) {
  if (!dir) return saveLocalFile(path);
  if (packing.has(path) || choosing.has(path)) return toast('这个目录正在准备下载');
  choosing.add(path);
  try {
    const r = await ask({
      method: 'select', title: '下载文件夹（ZIP）',
      message: `${path}\n\n打包当前磁盘内容，包含未提交和被忽略的文件。始终排除 .git，跳过符号链接。上限 1GB / 20000 条目。`,
      options: ['完整目录（除 .git 和符号链接）', '排除依赖目录（node_modules、.venv、venv、__pycache__）'],
    });
    if (r.cancelled) return;
    packing.add(path);
    toast('正在打包目录，完成后会自动开始下载…');
    const d = await http.post('/api/fs/archive', { path, omitDependencies: r.value.startsWith('排除') });
    saveArchive(d.id, d.name);
    toast(`已开始下载 ${d.name}${d.skippedLinks ? `（跳过 ${d.skippedLinks} 个符号链接）` : ''}`);
  } catch (e) {
    toast(`目录下载失败：${e.message}`, 'error');
  } finally {
    choosing.delete(path);
    packing.delete(path);
  }
}
