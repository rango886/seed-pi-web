// 配置：默认值 < 配置文件 ~/.seed-pi-web/config.json < 环境变量
// 后端和命令行（bin/seed-pi-web.js）共用这一份
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const APP = 'seed-pi-web';
export const HOME_DIR = process.env.SEED_PI_WEB_HOME || path.join(os.homedir(), '.seed-pi-web');
export const CONFIG_FILE = path.join(HOME_DIR, 'config.json');
export const STATE_FILE = path.join(HOME_DIR, 'server.json'); // 正在运行的服务：pid、端口……
export const LOG_FILE = path.join(HOME_DIR, 'server.log');

// key -> [环境变量, 默认值, 类型]
export const KEYS = {
  host: ['HOST', '127.0.0.1', 'string'],
  port: ['PORT', 8787, 'number'],
  token: ['SEED_PI_WEB_TOKEN', '', 'string'],
  piBin: ['SEED_PI_WEB_PI_BIN', 'pi', 'string'],
  piArgs: ['SEED_PI_WEB_PI_ARGS', '', 'string'],
  shell: ['SEED_PI_WEB_SHELL', '', 'string'],
  idleMinutes: ['SEED_PI_WEB_IDLE_MINUTES', 30, 'number'],
};

export function readFileConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

export function writeFileConfig(cfg) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

export function parseValue(key, v) {
  if (KEYS[key][2] === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${key} 要填数字`);
    return n;
  }
  return String(v);
}

/** 合并后的最终配置 */
export function loadConfig(env = process.env) {
  const file = readFileConfig();
  const cfg = {};
  for (const [k, [envName, def]] of Object.entries(KEYS)) {
    const v = env[envName] !== undefined && env[envName] !== '' ? env[envName] : file[k] !== undefined ? file[k] : def;
    cfg[k] = parseValue(k, v);
  }
  return cfg;
}

/** 把配置转成环境变量（后端和它起的子进程都从环境变量读） */
export function applyToEnv(cfg, env = process.env) {
  for (const [k, [envName]] of Object.entries(KEYS)) if (cfg[k] !== '' && cfg[k] !== undefined) env[envName] = String(cfg[k]);
  return env;
}

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}
