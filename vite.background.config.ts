import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const outDir = process.env.OUT_DIR ?? 'dist';

export default defineConfig({
  define: {
    __FAKE_PROVIDER__: JSON.stringify(process.env.FAKE_PROVIDER === '1'),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir,
    emptyOutDir: false,
    target: 'chrome138',
    sourcemap: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/background/index.ts'),
      formats: ['es'],
      fileName: () => 'background.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
