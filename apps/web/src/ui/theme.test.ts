// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { parseTheme, readStoredTheme, storeTheme } from './theme.ts'

describe('theme', () => {
  it('falls back to system for unknown values', () => {
    expect(parseTheme('dark')).toBe('dark')
    expect(parseTheme('neon')).toBe('system')
    expect(parseTheme(null)).toBe('system')
  })

  it('survives unavailable storage', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(readStoredTheme(broken)).toBe('system')
    expect(() => storeTheme(broken, 'dark')).not.toThrow()
    expect(readStoredTheme(undefined)).toBe('system')
  })
})
