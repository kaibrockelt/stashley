// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { DesignCatalog, DesignCatalogObject } from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import {
  addColumn,
  addJoin,
  aggregatesFor,
  bucketsFor,
  constantFor,
  constantTexts,
  errorTarget,
  functionsFor,
  groupingOf,
  joinOptions,
  newFilter,
  operatorsFor,
  outputName,
  parseConstant,
  removeColumn,
  removeJoin,
  sanitize,
  specFor,
  specParameters,
  syncSpecDefinitions,
  updateColumn,
  withOperator,
} from './spec-ops.ts'

const object = (
  name: string,
  columns: [string, DesignCatalogObject['columns'][number]['kind']][],
): DesignCatalogObject => ({
  tableAccessId: `00000000-0000-4000-8000-${name
    .padStart(12, '0')
    .slice(-12)
    .replace(/[^0-9a-f]/g, '0')}`,
  name,
  type: 'table',
  keyColumn: 'id',
  columns: columns.map(([column, kind]) => ({
    name: column,
    kind,
    nullable: true,
    key: column === 'id',
  })),
})

const catalog: DesignCatalog = {
  connectionId: 'c',
  objects: [
    object('anmeldung', [
      ['id', 'integer'],
      ['person_id', 'integer'],
      ['event_id', 'integer'],
      ['status', 'enum'],
      ['angemeldet_am', 'datetime'],
      ['betrag', 'decimal'],
    ]),
    object('person', [
      ['id', 'integer'],
      ['land', 'string'],
      ['geboren', 'date'],
    ]),
    object('stempel', [
      ['id', 'integer'],
      ['anmeldung_id', 'integer'],
      ['zeit', 'timestamp'],
    ]),
  ],
  relations: [
    {
      sourceObject: 'anmeldung',
      sourceColumn: 'person_id',
      targetObject: 'person',
      targetColumn: 'id',
      kind: 'many_to_one',
    },
    {
      sourceObject: 'stempel',
      sourceColumn: 'anmeldung_id',
      targetObject: 'anmeldung',
      targetColumn: 'id',
      kind: 'many_to_one',
    },
  ],
}
const anmeldung = catalog.objects[0]

describe('builder functions per column kind', () => {
  it('allows sum and average only on numbers', () => {
    expect(aggregatesFor('decimal')).toEqual([
      'count',
      'count_distinct',
      'sum',
      'avg',
      'min',
      'max',
    ])
    expect(aggregatesFor('string')).toEqual(['count', 'count_distinct', 'min', 'max'])
  })

  it('allows clock buckets only on date-times', () => {
    expect(bucketsFor('date')).toEqual(['day', 'week', 'month', 'year'])
    expect(bucketsFor('timestamp')).toEqual([
      'quarter_hour',
      'hour',
      'day',
      'week',
      'month',
      'year',
    ])
    expect(bucketsFor('integer')).toEqual([])
    expect(functionsFor('string')[0]).toBe('value')
  })

  it('offers operators per kind', () => {
    expect(operatorsFor('boolean')).toEqual(['eq', 'ne', 'null', 'not_null'])
    expect(operatorsFor('string')).toContain('like')
    expect(operatorsFor('integer')).toContain('between')
    expect(operatorsFor('integer')).not.toContain('like')
  })
})

describe('output names', () => {
  it('sanitizes and keeps names unique', () => {
    expect(sanitize('Größe in €', 'x')).toBe('Groesse_in')
    expect(sanitize('1. Etappe', 'x')).toBe('_1_Etappe')
    expect(sanitize('€', 'fallback')).toBe('fallback')
    expect(outputName('land', 'value', new Set(['LAND']))).toBe('land_2')
    expect(outputName('zeit', 'quarter_hour', new Set())).toBe('zeit_quarter_hour')
    expect(outputName(null, 'count', new Set(['row_count']))).toBe('row_count_2')
  })
})

describe('spec edits', () => {
  it('starts with the first columns of the base', () => {
    const spec = specFor(anmeldung)
    expect(spec.columns.map((column) => column.name)).toEqual([
      'id',
      'person_id',
      'event_id',
      'status',
      'angemeldet_am',
      'betrag',
    ])
    expect(spec).toMatchObject({
      schemaVersion: 1,
      base: 'anmeldung',
      joins: [],
      filters: [],
      sort: [],
      limit: null,
    })
  })

  it('joins along relations in both directions with unique aliases', () => {
    let spec = specFor(anmeldung)
    const options = joinOptions(spec, catalog, 'base')
    expect(options).toEqual([
      { column: 'person_id', target: 'person', targetColumn: 'id', direction: 'forward' },
      { column: 'id', target: 'stempel', targetColumn: 'anmeldung_id', direction: 'reverse' },
    ])
    spec = addJoin(spec, 'base', options[0])
    spec = addJoin(spec, 'base', options[0], 'inner')
    expect(spec.joins.map((join) => [join.alias, join.kind])).toEqual([
      ['person', 'left'],
      ['person2', 'inner'],
    ])
    expect(joinOptions(spec, catalog, 'person')).toEqual([
      { column: 'id', target: 'anmeldung', targetColumn: 'person_id', direction: 'reverse' },
    ])
    expect(joinOptions(spec, catalog, 'nope')).toEqual([])
  })

  it('removes a join with the joins, columns, filters and sort entries that depend on it', () => {
    let spec = specFor(anmeldung)
    spec = addJoin(spec, 'base', joinOptions(spec, catalog, 'base')[1])
    spec = addJoin(spec, 'stempel', joinOptions(spec, catalog, 'stempel')[0])
    spec = addColumn(spec, 'stempel', 'zeit')
    spec = {
      ...spec,
      filters: [newFilter(spec, catalog, 'anmeldung', 'status')],
      sort: [{ column: 'zeit', direction: 'asc' }],
    }
    const removed = removeJoin(spec, 'stempel')
    expect(removed.joins).toEqual([])
    expect(removed.columns.some((column) => column.source !== 'base')).toBe(false)
    expect(removed.filters).toEqual([])
    expect(removed.sort).toEqual([])
    const onlyJoined = {
      ...spec,
      columns: spec.columns.filter((column) => column.source === 'stempel'),
    }
    expect(removeJoin(onlyJoined, 'stempel').columns).toEqual([
      { name: 'row_count', source: 'base', column: null, aggregate: 'count' },
    ])
  })

  it('updates columns with suggested names, keeps custom names and renames sort entries', () => {
    let spec = specFor(anmeldung)
    spec = { ...spec, sort: [{ column: 'angemeldet_am', direction: 'desc' }] }
    spec = updateColumn(spec, 4, { fn: 'week' })
    expect(spec.columns[4]).toEqual({
      name: 'angemeldet_am_week',
      source: 'base',
      column: 'angemeldet_am',
      bucket: 'week',
    })
    expect(spec.sort).toEqual([{ column: 'angemeldet_am_week', direction: 'desc' }])
    spec = updateColumn(spec, 4, { name: 'Woche' })
    spec = updateColumn(spec, 4, { fn: 'month' })
    expect(spec.columns[4]).toEqual({
      name: 'Woche',
      source: 'base',
      column: 'angemeldet_am',
      bucket: 'month',
    })
    spec = updateColumn(spec, 5, { fn: 'sum' })
    expect(spec.columns[5]).toEqual({
      name: 'betrag_sum',
      source: 'base',
      column: 'betrag',
      aggregate: 'sum',
    })
    spec = updateColumn(spec, 0, { column: null })
    expect(spec.columns[0]).toEqual({
      name: 'row_count',
      source: 'base',
      column: null,
      aggregate: 'count',
    })
    expect(updateColumn(spec, 99, { fn: 'sum' })).toBe(spec)
  })

  it('adds and removes columns and derives the grouping', () => {
    let spec = specFor(anmeldung)
    expect(groupingOf(spec)).toEqual([])
    spec = addColumn(spec, 'base', null)
    expect(spec.columns.at(-1)).toEqual({
      name: 'row_count',
      source: 'base',
      column: null,
      aggregate: 'count',
    })
    expect(groupingOf(spec)).toHaveLength(6)
    spec = { ...spec, sort: [{ column: 'row_count', direction: 'desc' }] }
    spec = removeColumn(spec, spec.columns.length - 1)
    expect(spec.sort).toEqual([])
    const single = { ...spec, columns: spec.columns.slice(0, 1) }
    expect(removeColumn(single, 0)).toBe(single)
  })
})

describe('filters and parameters', () => {
  it('types constants by column kind', () => {
    expect(parseConstant('integer', ' 42 ')).toBe(42)
    expect(parseConstant('decimal', '49,90')).toBe(49.9)
    expect(parseConstant('decimal', 'x')).toBe('x')
    expect(parseConstant('boolean', 'true')).toBe(true)
    expect(parseConstant('date', '2026-06-13')).toBe('2026-06-13')
    expect(constantFor('in', 'integer', ['1, 2,,3'])).toEqual([1, 2, 3])
    expect(constantFor('between', 'integer', ['1', '5'])).toEqual([1, 5])
    expect(constantTexts([1, 2], 'in')).toEqual(['1, 2'])
    expect(constantTexts([1, 5], 'between')).toEqual(['1', '5'])
    expect(constantTexts(undefined, 'eq')).toEqual([''])
  })

  it('keeps values valid when the operator changes', () => {
    const spec = specFor(anmeldung)
    const filter = {
      ...newFilter(spec, catalog, 'base', 'event_id'),
      value: { kind: 'constant' as const, value: 3 },
    }
    expect(withOperator(filter, 'null', 'integer')).toEqual({
      source: 'base',
      column: 'event_id',
      operator: 'null',
    })
    expect(withOperator(filter, 'in', 'integer').value).toEqual({ kind: 'constant', value: [3] })
    expect(withOperator(filter, 'between', 'integer').value).toEqual({
      kind: 'constant',
      value: [3, ''],
    })
    const parameter = { ...filter, value: { kind: 'parameter' as const, name: 'current_event_id' } }
    expect(withOperator(parameter, 'ne', 'integer').value).toEqual({
      kind: 'parameter',
      name: 'current_event_id',
    })
    expect(withOperator(parameter, 'between', 'integer').value).toEqual({
      kind: 'constant',
      value: ['', ''],
    })
  })

  it('derives parameters with types and keeps existing definitions', () => {
    const spec = {
      ...specFor(anmeldung),
      filters: [
        {
          source: 'base',
          column: 'event_id',
          operator: 'eq' as const,
          value: { kind: 'parameter' as const, name: 'event' },
        },
        {
          source: 'base',
          column: 'status',
          operator: 'in' as const,
          value: { kind: 'parameter' as const, name: 'states' },
        },
        {
          source: 'base',
          column: 'event_id',
          operator: 'ne' as const,
          value: { kind: 'parameter' as const, name: 'event' },
        },
      ],
    }
    const wanted = specParameters(spec, catalog)
    expect(wanted).toEqual([
      { name: 'event', type: 'integer', list: false },
      { name: 'states', type: 'string', list: true },
    ])
    const kept = {
      name: 'event',
      type: 'string' as const,
      list: false,
      required: true,
      defaultValue: null,
    }
    expect(syncSpecDefinitions([kept], wanted)).toEqual([
      kept,
      { name: 'states', type: 'string', list: true, required: false, defaultValue: null },
    ])
  })

  it('reads the target of server field errors', () => {
    expect(errorTarget('builder.columns.2.bucket')).toEqual({ section: 'columns', index: 2 })
    expect(errorTarget('builder.base')).toEqual({ section: 'base', index: null })
    expect(errorTarget('sql')).toEqual({ section: 'other', index: null })
  })
})
