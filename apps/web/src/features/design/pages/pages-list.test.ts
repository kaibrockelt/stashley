// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { slugify } from './pages-list.tsx'

describe('slugify', () => {
  it('turns titles into page addresses', () => {
    expect(slugify('Übersicht')).toBe('uebersicht')
    expect(slugify('  Kasse & Zahlungen 2026 ')).toBe('kasse-zahlungen-2026')
    expect(slugify('Straße – Café')).toBe('strasse-cafe')
    expect(slugify('x'.repeat(80))).toHaveLength(63)
  })
})
