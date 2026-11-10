// 入口：先把存在后端的偏好设置拉下来（见 prefs.js），再加载其余模块（boot.js）。
// 必须分两步：settings.js、store.js 这些模块一加载就会同步读设置，静态 import 会抢在设置到手之前执行。
import { installPrefs } from './prefs.js';

installPrefs().then(() => import('./boot.js'));
