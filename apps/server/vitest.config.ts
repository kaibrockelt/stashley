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
  },
})
