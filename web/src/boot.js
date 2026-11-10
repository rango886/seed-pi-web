// 真正的启动：样式、根组件、各种全局监听。由 main.js 在设置拉下来之后再加载
import { createApp } from 'vue';
import '@xterm/xterm/css/xterm.css';
// 公式（Temml → MathML）：这份 CSS 只是给 Chromium/WebKit 补上分数线、重音、\cancelto 这些细节，
// 外加一个 9KB 的字体（\mathscr 和撇号用）。不带它也能排，只是细节糙一点
import 'temml/dist/Temml-Local.css';
import './style.css';
import './github.css';
import './github-warm.css';
import './pi.css';
import App from './App.vue';
import './selection.css'; // 放在主题和组件样式之后，统一激活态配色
import { start } from './store.js';
import { startDiagramBinder } from './diagram.js';
import { startMdActions } from './md-actions.js';
import { startMediaBinder } from './media.js';

createApp(App).mount('#app');
startDiagramBinder();
startMediaBinder();
startMdActions();
start();
