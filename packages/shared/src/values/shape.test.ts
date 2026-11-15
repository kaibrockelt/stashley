// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { analyzeShape, effectiveColumns, type ShapeColumn } from './shape.ts'

const col = (name: string, role: ShapeColumn['role']): ShapeColumn => ({ name, role })

describe('analyzeShape', () => {
  it('suggests a metric for one row with one measure', () => {
    const shape = analyzeShape([col('count', 'measure')], 1)
    expect(shape.suggested).toBe('metric')
    expect(shape.allowed).toEqual(['metric', 'table'])
  })

  it('offers progress for a measure with a target', () => {
    expect(analyzeShape([col('paid', 'measure'), col('due', 'measure')], 1).allowed).toEqual([
      'metric',
      'progress',
      'record',
      'scatter',
      'table',
    ])
  })

  it('suggests a record for one row with several columns', () => {
    const shape = analyzeShape(
      [col('name', 'category'), col('country', 'category'), col('id', 'identifier')],
      1,
    )
    expect(shape.suggested).toBe('record')
  })

  it('suggests bars for a category and offers a donut for one measure', () => {
    const shape = analyzeShape([col('country', 'category'), col('people', 'measure')], 23)
    expect(shape.suggested).toBe('bar')
    expect(shape.allowed).toEqual(['bar', 'stacked', 'donut', 'table'])
  })

  it('leaves out the donut for several measures', () => {
    const shape = analyzeShape(
      [col('country', 'category'), col('a', 'measure'), col('b', 'measure')],
      5,
    )
    expect(shape.allowed).not.toContain('donut')
    expect(shape.allowed).toContain('scatter')
  })

  it('suggests a line for a time dimension', () => {
    const shape = analyzeShape([col('week', 'time'), col('registrations', 'measure')], 30)
    expect(shape.suggested).toBe('line')
    expect(shape.allowed).toEqual(['line', 'area', 'column', 'table'])
  })

  it('suggests a funnel for an ordered dimension', () => {
    const shape = analyzeShape([col('step', 'ordered'), col('count', 'measure')], 4)
    expect(shape.suggested).toBe('funnel')
    expect(shape.allowed).toContain('bar')
  })

  it('handles the long format and the heatmap', () => {
    expect(
      analyzeShape([col('week', 'time'), col('country', 'category'), col('n', 'measure')], 90)
        .suggested,
    ).toBe('line')
    const stations = analyzeShape(
      [col('station', 'ordered'), col('slot', 'time'), col('stamps', 'measure')],
      200,
    )
    expect(stations.suggested).toBe('heatmap')
    expect(
      analyzeShape([col('a', 'category'), col('b', 'category'), col('n', 'measure')], 9).suggested,
    ).toBe('bar')
  })

  it('offers scatter and bubble for measures', () => {
    const shape = analyzeShape(
      [col('x', 'measure'), col('y', 'measure'), col('size', 'measure')],
      100,
    )
    expect(shape.suggested).toBe('scatter')
    expect(shape.allowed).toEqual(['scatter', 'bubble', 'table'])
  })

  it('always allows the table and ignores identifiers', () => {
    expect(analyzeShape([col('id', 'identifier')], 10)).toEqual({
      allowed: ['table'],
      suggested: 'table',
    })
  })

  it('offers single-row shapes before the first run', () => {
    expect(analyzeShape([col('n', 'measure')], null).allowed).toContain('metric')
    expect(analyzeShape([col('a', 'category'), col('b', 'category')], null).allowed).toContain(
      'record',
    )
  })

  it('applies role overrides', () => {
    const columns = effectiveColumns([col('nummer', 'measure'), col('n', 'measure')], {
      nummer: 'ordered',
      other: 'time',
    })
    expect(columns).toEqual([col('nummer', 'ordered'), col('n', 'measure')])
    expect(analyzeShape(columns, 8).suggested).toBe('funnel')
  })
})
