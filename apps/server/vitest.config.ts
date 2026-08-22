import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    // Browser-driving tests fight over focus if run in parallel.
    fileParallelism: false,
    env: {
      // Chromium allows one process per profile directory. Without its own,
      // the suite collides with a dev server that is already running.
      BROWSER_PROFILE_DIR: '.playwright-profile-test',
      HEADLESS: 'true',
    },
  },
});
