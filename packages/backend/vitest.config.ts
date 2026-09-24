import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    // Serial: tests share a single in-memory DB module singleton.
    fileParallelism: false,
  },
});
