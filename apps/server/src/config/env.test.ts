// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from './env.ts'

const base = { APP_SECRET_KEY: 'x'.repeat(32), APP_BASE_URL: 'https://stashley.example.com/' }

function issues(env: Record<string, string>): string[] {
  try {
    loadConfig(env, () => {
      throw new Error('no file')
    })
  } catch (error) {
    if (error instanceof ConfigError) return error.issues
    throw error
  }
  return []
}

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(base)
    expect(config.port).toBe(8080)
    expect(config.timeZone).toBe('UTC')
    expect(config.cacheMaxMb).toBe(256)
    expect(config.dataDir).toBe('/data')
    expect(config.baseUrl.href).toBe('https://stashley.example.com/')
    expect(config.secureCookies).toBe(true)
  })

  it('requires the secret key and base URL', () => {
    expect(issues({})).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^APP_SECRET_KEY/),
        expect.stringMatching(/^APP_BASE_URL/),
      ]),
    )
  })

  it('rejects short keys without echoing the value', () => {
    const found = issues({ ...base, APP_SECRET_KEY: 'too-short-secret' })
    expect(found).toEqual(['APP_SECRET_KEY: must be at least 32 bytes'])
    expect(found.join()).not.toContain('too-short-secret')
  })

  it('reads secrets from *_FILE', () => {
    const config = loadConfig(
      { APP_BASE_URL: base.APP_BASE_URL, APP_SECRET_KEY_FILE: '/run/secrets/key' },
      (file) => (file === '/run/secrets/key' ? `${'k'.repeat(40)}\n` : ''),
    )
    expect(config.secretKey).toBe('k'.repeat(40))
  })

  it('rejects a secret given both directly and as file', () => {
    expect(issues({ ...base, APP_SECRET_KEY_FILE: '/run/secrets/key' })).toContain(
      'APP_SECRET_KEY: set either APP_SECRET_KEY or APP_SECRET_KEY_FILE, not both',
    )
  })

  it('reports unreadable secret files', () => {
    expect(issues({ APP_BASE_URL: base.APP_BASE_URL, APP_SECRET_KEY_FILE: '/missing' })).toContain(
      'APP_SECRET_KEY_FILE: cannot read /missing',
    )
  })

  it('allows plain http only for localhost', () => {
    expect(loadConfig({ ...base, APP_BASE_URL: 'http://localhost:8080' }).secureCookies).toBe(false)
    expect(issues({ ...base, APP_BASE_URL: 'http://stashley.example.com' })).toEqual([
      'APP_BASE_URL: must use https unless the host is localhost',
    ])
  })

  it('validates time zones, log levels and ports', () => {
    expect(loadConfig({ ...base, APP_TIMEZONE: 'Europe/Berlin' }).timeZone).toBe('Europe/Berlin')
    expect(issues({ ...base, APP_TIMEZONE: 'Mars/Olympus' })).toEqual([
      'APP_TIMEZONE: must be an IANA time zone',
    ])
    expect(issues({ ...base, LOG_LEVEL: 'verbose' })).toHaveLength(1)
    expect(issues({ ...base, PORT: '70000' })).toHaveLength(1)
  })

  it('requires both initial admin variables together', () => {
    expect(issues({ ...base, INITIAL_ADMIN_EMAIL: 'admin@example.com' })).toEqual([
      'INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PASSWORD: set both or neither',
    ])
    const config = loadConfig({
      ...base,
      INITIAL_ADMIN_EMAIL: 'admin@example.com',
      INITIAL_ADMIN_PASSWORD: 'correct horse battery',
    })
    expect(config.initialAdmin?.email).toBe('admin@example.com')
  })

  it('requires a sender when SMTP is configured', () => {
    expect(issues({ ...base, SMTP_HOST: 'smtp.example.com' })).toEqual([
      'SMTP_FROM: is required when SMTP_HOST is set',
    ])
    const config = loadConfig({ ...base, SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'a@b.c' })
    expect(config.smtp).toEqual({ host: 'smtp.example.com', port: 587, from: 'a@b.c' })
  })
})

describe('empty values', () => {
  it('treats empty variables as unset', () => {
    const config = loadConfig({
      ...base,
      SMTP_HOST: '',
      SMTP_PORT: '',
      CACHE_MAX_MB: '',
      TRUST_PROXY: '',
    })
    expect(config.smtp).toBeUndefined()
    expect(config.cacheMaxMb).toBe(256)
    expect(config.trustProxy).toBeUndefined()
  })
})
