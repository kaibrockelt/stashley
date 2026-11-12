// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import react from '@vitejs/plugin-react'
import { defaultClientConditions, defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['@stashley/source', ...defaultClientConditions] },
  build: {
    manifest: true,
    sourcemap: true,
    assetsInlineLimit: 0,
  },
  server: {
    proxy: {
      '/internal': 'http://localhost:8080',
      '/api': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
      '/readyz': 'http://localhost:8080',
    },
  },
})
