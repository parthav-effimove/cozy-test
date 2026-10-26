import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * VoyageCalc visual suite.
 * - `npm run test:chrome` opens REAL Google Chrome (headed) automatically.
 * - `npm test` runs headless (CI-friendly).
 * Target: https://cozy-crafting-cloud.lovable.app/
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Parallel workers: PW_WORKERS env wins, else 4 locally / 2 on CI.
  // File-level tests shard across workers; the 32-sheet spec additionally
  // shards into SHARDS parallel tests (own workbook each) for ~Nx speedup.
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : process.env.CI ? 2 : 4,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 90 * 1000,
  expect: {
    timeout: 15 * 1000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.05 },
  },
  use: {
    baseURL: 'https://cozy-crafting-cloud.lovable.app',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15 * 1000,
    navigationTimeout: 60 * 1000,
  },
  projects: [
    {
      name: 'chrome',
      use: {
        // Automatically opens installed Google Chrome (not bundled Chromium).
        channel: 'chrome',
        headless: false,
        ...devices['Desktop Chrome'],
        viewport: { width: 1536, height: 864 },
        launchOptions: {
          slowMo: Number(process.env.SLOW_MO ?? 150),
        },
      },
    },
    {
      name: 'chromium-headless',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1536, height: 864 },
      },
    },
  ],
});
