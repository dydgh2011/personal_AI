import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    // Each e2e file boots its own Nest app on its own SQLite database.
    fileParallelism: true,
    // The database runs with synchronous=FULL (every commit is fsynced). Inside a Docker build on
    // Docker Desktop that disk is slow, and with files in parallel a migration test took ~17 s, past
    // vitest's 5 s default, so the image would not build. The tests are correct, only slow there.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
