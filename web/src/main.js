import { createApp } from 'vue';
import '@xterm/xterm/css/xterm.css';
// 公式（Temml → MathML）：这份 CSS 只是给 Chromium/WebKit 补上分数线、重音、\cancelto 这些细节，
// 外加一个 9KB 的字体（\mathscr 和撇号用）。不带它也能排，只是细节糙一点
import 'temml/dist/Temml-Local.css';
import './style.css';
import './github.css';
import './wechat.css';
import App from './App.vue';
import { start } from './store.js';

createApp(App).mount('#app');
start();
