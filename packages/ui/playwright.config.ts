import { defineConfig } from '@playwright/test';

export default defineConfig({
  fullyParallel: false,
  reporter: process.env.CI === 'true' ? 'github' : 'line',
  retries: process.env.CI === 'true' ? 1 : 0,
  testDir: './e2e',
  timeout: 120_000,
  use: {
    launchOptions:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH === undefined
        ? undefined
        : { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  workers: 1,
});
