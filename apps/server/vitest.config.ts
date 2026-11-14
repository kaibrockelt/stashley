// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Workspace packages resolve to their TypeScript sources, so tests need no prior build.
  // Vitest runs tests in the SSR environment, which has its own conditions.
  resolve: { conditions: ['@stashley/source'] },
  ssr: { resolve: { conditions: ['@stashley/source'] } },
  test: {
    include: ['src/**/*.test.ts'],
    pool: 'forks',
    // Access control, SQL validation and query generation need at least 90 % (§26).
    coverage: {
      provider: 'v8',
      include: [
        'src/modules/queries/sql-guard/**',
        'src/modules/queries/builder/**',
        'src/modules/execution/sql/**',
      ],
      exclude: ['**/*.test.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: {
        'src/modules/queries/sql-guard/**': { lines: 90, branches: 90 },
        'src/modules/queries/builder/**': { lines: 90, branches: 90 },
        'src/modules/execution/sql/**': { lines: 90, branches: 90 },
      },
    },
  },
})
