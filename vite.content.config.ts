import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const outDir = process.env.OUT_DIR ?? 'dist';

export default defineConfig({
  plugins: [react()],
  define: {
    __FAKE_PROVIDER__: JSON.stringify(process.env.FAKE_PROVIDER === '1'),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir,
    emptyOutDir: false,
    target: 'chrome138',
    sourcemap: false,
    cssCodeSplit: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/index.ts'),
      formats: ['iife'],
      name: 'HuayiContent',
      fileName: () => 'content.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
