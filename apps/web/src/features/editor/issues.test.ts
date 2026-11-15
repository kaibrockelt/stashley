// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { emptyPage } from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import { addRow } from './document-ops.ts'
import { blockOf, issuesOf } from './issues.tsx'

describe('issues of a rejected save', () => {
  const document = addRow(emptyPage('dashboard', 'Kasse'), {
    id: 'b1',
    type: 'text',
    title: 'Hinweise',
    restrictions: [],
    markdown: '',
  })

  it('become error issues with their parameters', () => {
    expect(
      issuesOf([{ field: 'access.grants.0', code: 'exceeds_ceiling', params: { ops: 'delete' } }]),
    ).toEqual([
      {
        path: 'access.grants.0',
        code: 'exceeds_ceiling',
        severity: 'error',
        params: { ops: 'delete' },
      },
    ])
  })

  it('name the block they lie in', () => {
    expect(blockOf(document, 'rows.0.blocks.0.settings')).toBe('Hinweise')
    expect(blockOf(document, 'rows.0.blocks.0')).toBe('Hinweise')
    expect(blockOf(document, 'rows.0.blocks.01')).toBeUndefined()
    expect(blockOf(document, 'access.view.0')).toBeUndefined()
  })
})
