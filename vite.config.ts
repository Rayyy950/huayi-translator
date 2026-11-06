import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const outDir = process.env.OUT_DIR ?? 'dist';

export default defineConfig({
  plugins: [react()],
  publicDir: 'public',
  define: {
    __FAKE_PROVIDER__: JSON.stringify(process.env.FAKE_PROVIDER === '1'),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir,
    emptyOutDir: process.env.WATCH !== '1',
    target: 'chrome138',
    sourcemap: false,
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, 'popup.html'),
        options: resolve(import.meta.dirname, 'options.html'),
      },
    },
  },
});
