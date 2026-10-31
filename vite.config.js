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
      '/api': { target: backend },
      '/ws': { target: backend, ws: true },
    },
  },
});
