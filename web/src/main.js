import { createApp } from 'vue';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import './github.css';
import './wechat.css';
import App from './App.vue';
import { start } from './store.js';

createApp(App).mount('#app');
start();
