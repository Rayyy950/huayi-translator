import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __FAKE_PROVIDER__: 'false',
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
});
