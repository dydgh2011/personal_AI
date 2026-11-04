import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    // Each e2e file boots its own Nest app on its own SQLite database.
    fileParallelism: true,
  },
});
