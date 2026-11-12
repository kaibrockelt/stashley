// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { negotiateLocale } from './locale.ts'

describe('negotiateLocale', () => {
  it('uses the first supported language', () => {
    expect(negotiateLocale(['fr-FR', 'de-AT', 'en'])).toBe('de')
    expect(negotiateLocale(['en-GB'])).toBe('en')
  })

  it('falls back to English', () => {
    expect(negotiateLocale(['fr', 'it'])).toBe('en')
    expect(negotiateLocale([])).toBe('en')
  })
})
