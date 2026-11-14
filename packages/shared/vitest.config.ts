// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { conditions: ['@stashley/source'] },
  test: {
    include: ['src/**/*.test.ts'],
    // The access algebra needs at least 90 % (§26).
    coverage: {
      provider: 'v8',
      include: ['src/access/**'],
      exclude: ['**/*.test.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { 'src/access/**': { lines: 90, branches: 90 } },
    },
  },
})
