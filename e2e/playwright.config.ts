// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig, devices } from '@playwright/test'

/**
 * The end-to-end suite (§26): one spec per acceptance criterion, run in order against the
 * environment of `e2e/compose.yml`. Later specs build on earlier ones (the first admin, the
 * connection, the accounts, the imported scenario), so the suite runs with one worker.
 */
export default defineConfig({
  testDir: './specs',
  globalSetup: './support/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI !== undefined && process.env.CI !== '',
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: 'report', open: 'never' }]],
  outputDir: '.tmp/results',
  use: {
    baseURL: process.env.E2E_BASE_A,
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: /\.mobile\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
    {
      // The station criterion: a helper's phone at 375 px.
      name: 'mobile',
      testMatch: /\.mobile\.spec\.ts$/,
      dependencies: ['desktop'],
      use: { ...devices['Pixel 7'], viewport: { width: 375, height: 812 } },
    },
  ],
})
