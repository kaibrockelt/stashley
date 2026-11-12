// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { conditions: ['@stashley/source'] },
  test: { include: ['src/**/*.test.ts'] },
})
