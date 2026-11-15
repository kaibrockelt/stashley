// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { parseSettings, settingsProblems } from './block-settings.ts'

const columns = [
  { name: 'week', role: 'time' as const },
  { name: 'n', role: 'measure' as const },
  { name: 'nummer', role: 'measure' as const },
]
const chart = { chart: 'line', height: 'M', x: 'week', measures: ['n'] }

describe('block settings', () => {
  it('parses valid settings and defaults records and tables', () => {
    expect(parseSettings('chart', chart).ok).toBe(true)
    expect(parseSettings('record', undefined)).toEqual({ ok: true, value: {} })
    expect(parseSettings('table', undefined).ok).toBe(true)
    expect(parseSettings('metric', undefined).ok).toBe(false)
  })

  it('rejects unknown fields and bad formats', () => {
    expect(parseSettings('chart', { ...chart, colors: ['#f00'] })).toEqual({ ok: false, path: '' })
    expect(
      parseSettings('metric', { value: 'n', formats: { n: { kind: 'currency', currency: 'eur' } } })
        .ok,
    ).toBe(false)
  })

  it('accepts a matching mapping', () => {
    expect(settingsProblems('chart', chart, columns)).toEqual([])
    expect(settingsProblems('chart', chart, null)).toEqual([])
  })

  it('reports missing and unsuitable columns', () => {
    expect(settingsProblems('chart', { ...chart, x: 'month' }, columns)).toEqual([
      { code: 'mapping_broken', column: 'month' },
    ])
    expect(settingsProblems('chart', { ...chart, x: 'nummer' }, columns)).toEqual([
      { code: 'mapping_unsuitable', column: 'nummer', expected: 'dimension' },
    ])
    expect(settingsProblems('metric', { value: 'week' }, columns)).toEqual([
      { code: 'mapping_unsuitable', column: 'week', expected: 'measure' },
    ])
    expect(settingsProblems('record', { columns: [{ column: 'gone' }] }, columns)).toEqual([
      { code: 'mapping_broken', column: 'gone' },
    ])
    expect(
      settingsProblems(
        'table',
        {
          rowLink: {
            pageId: '7f1c1c62-41f4-4f43-9a55-6f1c8e1c1c62',
            parameter: 'id',
            column: 'gone',
          },
        },
        columns,
      ),
    ).toEqual([{ code: 'mapping_broken', column: 'gone' }])
    expect(settingsProblems('chart', { ...chart, measures: [] }, columns)).toEqual([
      { code: 'settings_invalid', path: 'measures' },
    ])
  })

  it('applies role overrides before checking', () => {
    expect(
      settingsProblems(
        'chart',
        { ...chart, chart: 'funnel', x: 'nummer', roles: { nummer: 'ordered' } },
        columns,
      ),
    ).toEqual([])
    expect(
      settingsProblems(
        'chart',
        { chart: 'scatter', height: 'S', x: 'n', measures: ['nummer'], group: 'week' },
        columns,
      ),
    ).toEqual([])
    expect(
      settingsProblems(
        'metric',
        { value: 'n', comparison: { column: 'nummer', mode: 'trend' } },
        columns,
      ),
    ).toEqual([])
  })
})
