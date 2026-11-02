import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const backend = `http://127.0.0.1:${process.env.PORT || 8787}`;

export default defineConfig({
  root: 'web',
  plugins: [vue()],
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: {
    port: 5173,
    proxy: {
      // xfwd：带上 x-forwarded-for，后端才分得清是本机还是局域网打开的网页（读剪贴板只给本机）
      '/api': { target: backend, xfwd: true },
      '/ws': { target: backend, ws: true, xfwd: true },
    },
  },
});
