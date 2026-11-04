// 复用已安装 pi 的模型模块；不创建会话、不起子进程、不联网刷新目录。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { agentDir } from './sessions.js';

const PACKAGE = '@earendil-works/pi-coding-agent';

async function findPackage() {
  const roots = [];
  // 官方安装器使用 current-version 指向当前版本，不绑定某个版本号。
  for (const root of new Set([process.env.PI_MANAGED_INSTALL_ROOT, path.join(os.homedir(), '.pi', 'agent', 'install')].filter(Boolean))) {
    try {
      const version = (await fs.readFile(path.join(root, 'current-version'), 'utf8')).trim();
      if (/^[0-9A-Za-z_+-][0-9A-Za-z._+-]*$/.test(version)) roots.push(path.join(root, 'releases', version, 'node_modules', PACKAGE));
    } catch {}
  }
  const require = createRequire(import.meta.url);
  for (const dir of require.resolve.paths(PACKAGE) || []) roots.push(path.join(dir, PACKAGE));
  // npm 全局安装的 pi（Unix 的 bin 通常是指向包内 CLI 的符号链接）。
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    roots.push(path.join(dir, 'node_modules', PACKAGE), path.resolve(dir, '../lib/node_modules', PACKAGE));
    try {
      const real = await fs.realpath(path.join(dir, process.platform === 'win32' ? 'pi.cmd' : 'pi'));
      roots.push(path.resolve(path.dirname(real), '..'));
    } catch {}
  }
  for (const root of roots) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
      if (pkg.name === PACKAGE) return root;
    } catch {}
  }
  throw new Error('找不到已安装的 pi 模型模块，请安装 @earendil-works/pi-coding-agent');
}

// 只缓存模块导入；每次查询都重新读取模型配置、目录缓存和认证信息。
export const modelModules = (async () => {
  const root = await findPackage();
  const require = createRequire(path.join(root, 'package.json'));
  let aiPath;
  for (const dir of require.resolve.paths('@earendil-works/pi-ai') || []) {
    const file = path.join(dir, '@earendil-works/pi-ai/dist/models.js');
    try { await fs.access(file); aiPath = file; break; } catch {}
  }
  if (!aiPath) throw new Error('找不到 pi-ai 模型模块');
  const [runtime, ai, resolver] = await Promise.all([
    import(pathToFileURL(path.join(root, 'dist/core/model-runtime.js')).href),
    import(pathToFileURL(aiPath).href),
    import(pathToFileURL(path.join(root, 'dist/core/model-resolver.js')).href),
  ]);
  return { ...runtime, ...ai, findInitialModel: resolver.findInitialModel };
})();
// 安装缺失时不产生未处理的 rejection，查询时仍向用户报告错误。
modelModules.catch(() => {});

export async function readModelCatalog(cwd) {
  const { ModelRuntime, getSupportedThinkingLevels, clampThinkingLevel, findInitialModel } = await modelModules;
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir(), 'auth.json'),
    modelsPath: path.join(agentDir(), 'models.json'),
    allowModelNetwork: false,
  });
  const error = runtime.getError();
  if (error) throw new Error(error);
  const models = runtime.getAvailableSnapshot().map((model) => ({ ...model, thinkingLevels: getSupportedThinkingLevels(model) }));
  const settings = {};
  for (const file of [path.join(agentDir(), 'settings.json'), ...(cwd ? [path.join(cwd, '.pi/settings.json')] : [])]) {
    try { Object.assign(settings, JSON.parse(await fs.readFile(file, 'utf8'))); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const initial = await findInitialModel({
    scopedModels: [], isContinuing: false, modelRuntime: runtime,
    defaultProvider: settings.defaultProvider, defaultModelId: settings.defaultModel,
    defaultThinkingLevel: settings.defaultThinkingLevel, modelThinkingLevels: settings.modelThinkingLevels,
  });
  return {
    models,
    defaults: {
      model: initial.model || null,
      thinkingLevel: initial.model ? clampThinkingLevel(initial.model, initial.thinkingLevel) : 'off',
    },
  };
}
