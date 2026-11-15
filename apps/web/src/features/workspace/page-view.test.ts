// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { RenderPage } from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import { modeOf, splitSearch } from './page-view.tsx'

const page = {
  filters: [{ kind: 'text', id: 'q', label: 'Suche', required: false }],
  parameters: [{ name: 'anmeldung_id', type: 'integer', list: false }],
} as unknown as RenderPage

describe('page URL state', () => {
  it('takes only known filters and parameters from the search', () => {
    expect(
      splitSearch(page, { 'f.q': 'Meier', 'f.x': 1, anmeldung_id: 4, other: 'x', mode: 'edit' }),
    ).toEqual({
      filters: { q: 'Meier' },
      params: { anmeldung_id: 4 },
    })
    expect(splitSearch(page, { 'f.q': '' })).toEqual({ filters: {}, params: {} })
  })

  it('reads the mode and the preview roles', () => {
    expect(modeOf({})).toEqual({ mode: 'runtime', roles: [] })
    expect(modeOf({ mode: 'edit', roles: 'a' })).toEqual({ mode: 'edit', roles: [] })
    expect(modeOf({ mode: 'preview', roles: 'a,b' })).toEqual({
      mode: 'preview',
      roles: ['a', 'b'],
    })
    expect(modeOf({ mode: 'admin' })).toEqual({ mode: 'runtime', roles: [] })
  })
})
