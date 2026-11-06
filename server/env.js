// 最先加载：把配置文件里的设置补进环境变量，后面的模块统一从 process.env 读
import { loadConfig, ensureToken, applyToEnv } from './config.js';

applyToEnv(ensureToken(loadConfig()));
