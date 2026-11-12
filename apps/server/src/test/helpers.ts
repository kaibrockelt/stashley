// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'
import { loadConfig, type AppConfig } from '../config/env.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

export function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'stashley-test-'))
  dirs.push(dir)
  return dir
}

export const testSecret = 'test-secret-key-with-at-least-32-bytes!'

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    APP_SECRET_KEY: testSecret,
    APP_BASE_URL: 'http://localhost:8080',
    STASHLEY_DATA_DIR: tempDir(),
    STASHLEY_WEB_DIR: path.join(tempDir(), 'web'),
    ...overrides,
  })
}
