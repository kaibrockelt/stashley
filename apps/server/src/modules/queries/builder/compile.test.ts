// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { CatalogObject, ObjectAccess, QuerySpec } from '@stashley/shared'
import { querySpec, toMask } from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import { column } from '../../../test/connections.ts'
import { demoObjects } from '../../../test/demo.ts'
import { guardSql } from '../sql-guard/validate.ts'
import { BuilderError, compileSpec, type BuilderContext } from './compile.ts'

const objects: CatalogObject[] = [
  ...demoObjects.filter((object) => object.name !== 'zahlung'),
  {
    ...(demoObjects.find((object) => object.name === 'zahlung') as CatalogObject),
    columns: [
      ...(demoObjects.find((object) => object.name === 'zahlung') as CatalogObject).columns,
      { ...column('gebucht_um', 'timestamp', 9) },
    ],
  },
]
const catalog = new Map(objects.map((object) => [object.name, object]))
const relations = objects.flatMap((object) =>
  object.foreignKeys.map((fk) => ({
    sourceObject: object.name,
    sourceColumn: fk.columns[0] ?? '',
    targetObject: fk.targetObject,
    targetColumn: fk.targetColumns[0] ?? '',
  })),
)
const ctx: BuilderContext = { catalog, relations, timeZone: 'Europe/Berlin', timeZoneTables: true }

const spec = (over: Partial<QuerySpec> = {}): QuerySpec =>
  querySpec.parse({
    schemaVersion: 1,
    base: 'anmeldung',
    joins: [],
    columns: [{ name: 'id', source: 'base', column: 'id' }],
    filters: [],
    sort: [],
    limit: null,
    ...over,
  })

function errors(over: Partial<QuerySpec>, context: BuilderContext = ctx): unknown {
  try {
    compileSpec(spec(over), context)
    return []
  } catch (error) {
    if (error instanceof BuilderError) return error.errors
    throw error
  }
}

/** The compiled SQL must pass the validation like handwritten SQL. */
function validates(text: string): void {
  const read: ObjectAccess = { ceiling: toMask(['read']), excluded: new Set(), active: true }
  guardSql(text, {
    engine: 'mariadb',
    database: 'wanderverein',
    catalog,
    access: () => read,
    variables: new Set(['current_event_id']),
  })
}

describe('query builder compiler', () => {
  it('compiles joins, aggregates, buckets, filters, sort and limit', () => {
    const compiled = compileSpec(
      spec({
        joins: [
          {
            alias: 'p',
            from: 'base',
            column: 'person_id',
            target: 'person',
            targetColumn: 'id',
            kind: 'inner',
          },
          {
            alias: 'z',
            from: 'base',
            column: 'id',
            target: 'zahlung',
            targetColumn: 'anmeldung_id',
            kind: 'left',
          },
        ],
        columns: [
          { name: 'land', source: 'p', column: 'land' },
          { name: 'woche', source: 'base', column: 'angemeldet_am', bucket: 'week' },
          { name: 'anmeldungen', source: 'base', column: null, aggregate: 'count' },
          { name: 'personen', source: 'base', column: 'person_id', aggregate: 'count_distinct' },
          { name: 'summe', source: 'z', column: 'betrag', aggregate: 'sum' },
        ],
        filters: [
          {
            source: 'base',
            column: 'event_id',
            operator: 'eq',
            value: { kind: 'parameter', name: 'current_event_id' },
          },
          {
            source: 'base',
            column: 'status',
            operator: 'in',
            value: { kind: 'constant', value: ['angemeldet', "it's"] },
          },
          { source: 'p', column: 'telefon', operator: 'not_null' },
          {
            source: 'base',
            column: 'betrag_soll',
            operator: 'between',
            value: { kind: 'constant', value: [1, 100] },
          },
          {
            source: 'p',
            column: 'nachname',
            operator: 'like',
            value: { kind: 'constant', value: 'B\\%' },
          },
        ],
        sort: [{ column: 'anmeldungen', direction: 'desc' }],
        limit: 50,
      }),
      ctx,
    )
    expect(compiled.sql).toBe(
      [
        'select `p`.`land` AS `land`, DATE_SUB(DATE(`base`.`angemeldet_am`), INTERVAL WEEKDAY(`base`.`angemeldet_am`) DAY) AS `woche`, COUNT(*) AS `anmeldungen`, COUNT(DISTINCT `base`.`person_id`) AS `personen`, SUM(`z`.`betrag`) AS `summe`'.replace(
          'select',
          'SELECT',
        ),
        'FROM `anmeldung` AS `base`',
        'INNER JOIN `person` AS `p` ON `p`.`id` = `base`.`person_id`',
        'LEFT JOIN `zahlung` AS `z` ON `z`.`anmeldung_id` = `base`.`id`',
        "WHERE `base`.`event_id` = :current_event_id AND `base`.`status` IN ('angemeldet', 'it''s') AND `p`.`telefon` IS NOT NULL AND `base`.`betrag_soll` BETWEEN 1 AND 100 AND `p`.`nachname` LIKE 'B\\\\%'",
        'GROUP BY 1, 2',
        'ORDER BY `anmeldungen` DESC',
        'LIMIT 50',
      ].join('\n'),
    )
    expect(compiled.notes).toEqual([])
    validates(compiled.sql)
  })

  it('buckets time in the connection time zone', () => {
    const units = ['quarter_hour', 'hour', 'day', 'week', 'month', 'year'] as const
    for (const unit of units) {
      const compiled = compileSpec(
        spec({ columns: [{ name: 't', source: 'base', column: 'angemeldet_am', bucket: unit }] }),
        ctx,
      )
      validates(compiled.sql)
    }
    const date = compileSpec(
      spec({
        base: 'event',
        columns: [{ name: 'm', source: 'base', column: 'datum', bucket: 'month' }],
      }),
      ctx,
    )
    expect(date.sql).toContain("DATE(DATE_FORMAT(`base`.`datum`, '%Y-%m-01'))")
    const converted = compileSpec(
      spec({
        base: 'zahlung',
        columns: [{ name: 'h', source: 'base', column: 'gebucht_um', bucket: 'hour' }],
      }),
      ctx,
    )
    expect(converted.sql).toContain("CONVERT_TZ(`base`.`gebucht_um`, '+00:00', 'Europe/Berlin')")
    const utc = compileSpec(
      spec({
        base: 'zahlung',
        columns: [{ name: 'h', source: 'base', column: 'gebucht_um', bucket: 'day' }],
      }),
      { ...ctx, timeZoneTables: false },
    )
    expect(utc.sql).toContain('DATE(`base`.`gebucht_um`)')
    expect(utc.notes).toEqual(['timestamp_buckets_utc'])
  })

  it('joins along relations in both directions and compiles scalar filters', () => {
    const compiled = compileSpec(
      spec({
        base: 'person',
        joins: [
          {
            alias: 'a',
            from: 'base',
            column: 'id',
            target: 'anmeldung',
            targetColumn: 'person_id',
            kind: 'left',
          },
        ],
        columns: [
          { name: 'nachname', source: 'base', column: 'nachname' },
          { name: 'n', source: 'a', column: 'id', aggregate: 'count' },
          { name: 'erste', source: 'a', column: 'angemeldet_am', aggregate: 'min' },
          { name: 'letzte', source: 'a', column: 'angemeldet_am', aggregate: 'max' },
          { name: 'schnitt', source: 'a', column: 'betrag_soll', aggregate: 'avg' },
        ],
        filters: [
          {
            source: 'base',
            column: 'land',
            operator: 'ne',
            value: { kind: 'constant', value: 'XX' },
          },
          {
            source: 'a',
            column: 'startnummer',
            operator: 'gte',
            value: { kind: 'constant', value: 100 },
          },
          {
            source: 'a',
            column: 'startnummer',
            operator: 'lt',
            value: { kind: 'parameter', name: 'bis' },
          },
          {
            source: 'a',
            column: 'status',
            operator: 'not_in',
            value: { kind: 'parameter', name: 'stati' },
          },
          {
            source: 'a',
            column: 'startnummer',
            operator: 'gt',
            value: { kind: 'constant', value: true },
          },
          {
            source: 'a',
            column: 'startnummer',
            operator: 'lte',
            value: { kind: 'constant', value: 999 },
          },
          { source: 'a', column: 'startnummer', operator: 'null' },
        ],
        sort: [{ column: 'nachname', direction: 'asc' }],
      }),
      ctx,
    )
    expect(compiled.sql).toContain('LEFT JOIN `anmeldung` AS `a` ON `a`.`person_id` = `base`.`id`')
    expect(compiled.sql).toContain('`a`.`status` NOT IN (:stati)')
    expect(compiled.sql).toContain('`a`.`startnummer` > true')
    expect(compiled.sql).toContain('ORDER BY `nachname` ASC')
    validates(compiled.sql)
  })

  it('reports every problem with its field', () => {
    expect(errors({ base: 'nirgends' })).toEqual([
      { field: 'builder.base', code: 'unknown_object' },
    ])
    expect(
      errors({
        joins: [
          {
            alias: 'base',
            from: 'x',
            column: 'id',
            target: 'nirgends',
            targetColumn: 'id',
            kind: 'inner',
          },
          {
            alias: 'h',
            from: 'base',
            column: 'id',
            target: 'hotel',
            targetColumn: 'id',
            kind: 'inner',
          },
        ],
      }),
    ).toEqual([
      { field: 'builder.joins.0.alias', code: 'duplicate' },
      { field: 'builder.joins.0.from', code: 'unknown_alias' },
      { field: 'builder.joins.0.target', code: 'unknown_object' },
      { field: 'builder.joins.1', code: 'unknown_relation' },
    ])
    expect(
      errors({
        columns: [
          { name: 'a', source: 'base', column: 'id' },
          { name: 'A', source: 'base', column: 'id' },
          { name: 'b', source: 'base', column: 'id', aggregate: 'max', bucket: 'day' },
          { name: 'c', source: 'base', column: null, aggregate: 'sum' },
          { name: 'd', source: 'x', column: 'id' },
          { name: 'e', source: 'base', column: 'nirgends' },
          { name: 'f', source: 'base', column: 'status', bucket: 'day' },
          { name: 'g', source: 'base', column: 'status', aggregate: 'sum' },
          { name: 'h', source: 'base', column: 'person_id', aggregate: 'avg' },
        ],
      }),
    ).toEqual([
      { field: 'builder.columns.1.name', code: 'duplicate' },
      { field: 'builder.columns.2', code: 'aggregate_and_bucket' },
      { field: 'builder.columns.3.column', code: 'required' },
      { field: 'builder.columns.4.column', code: 'unknown_alias' },
      { field: 'builder.columns.5.column', code: 'unknown_column' },
      { field: 'builder.columns.6.bucket', code: 'not_a_time' },
      { field: 'builder.columns.7.aggregate', code: 'not_numeric' },
    ])
    expect(
      errors({
        base: 'event',
        columns: [{ name: 'q', source: 'base', column: 'datum', bucket: 'quarter_hour' }],
      }),
    ).toEqual([{ field: 'builder.columns.0.bucket', code: 'not_a_time' }])
    expect(
      errors({
        filters: [
          {
            source: 'base',
            column: 'status',
            operator: 'null',
            value: { kind: 'constant', value: 1 },
          },
          { source: 'base', column: 'status', operator: 'eq' },
          {
            source: 'base',
            column: 'status',
            operator: 'in',
            value: { kind: 'constant', value: [] },
          },
          {
            source: 'base',
            column: 'status',
            operator: 'in',
            value: { kind: 'constant', value: 'x' },
          },
          {
            source: 'base',
            column: 'status',
            operator: 'between',
            value: { kind: 'constant', value: [1] },
          },
          {
            source: 'base',
            column: 'status',
            operator: 'eq',
            value: { kind: 'constant', value: [1, 2] },
          },
          {
            source: 'base',
            column: 'nirgends',
            operator: 'eq',
            value: { kind: 'constant', value: 1 },
          },
        ],
        sort: [{ column: 'nirgends', direction: 'asc' }],
      }),
    ).toEqual([
      { field: 'builder.filters.0.value', code: 'not_allowed' },
      { field: 'builder.filters.1.value', code: 'required' },
      { field: 'builder.filters.2.value', code: 'invalid' },
      { field: 'builder.filters.3.value', code: 'invalid' },
      { field: 'builder.filters.4.value', code: 'invalid' },
      { field: 'builder.filters.5.value', code: 'invalid' },
      { field: 'builder.filters.6.column', code: 'unknown_column' },
      { field: 'builder.sort.0.column', code: 'unknown_column' },
    ])
  })

  it('takes list parameters only for in and not in', () => {
    const lists = new Map([
      ['states', true],
      ['state', false],
    ])
    const filter = (operator: 'eq' | 'in', name: string) => ({
      source: 'base',
      column: 'status',
      operator,
      value: { kind: 'parameter' as const, name },
    })
    const context = { ...ctx, parameterLists: lists }
    expect(errors({ filters: [filter('in', 'states'), filter('eq', 'state')] }, context)).toEqual(
      [],
    )
    expect(errors({ filters: [filter('eq', 'states'), filter('in', 'state')] }, context)).toEqual([
      { field: 'builder.filters.0.value', code: 'list_not_allowed' },
      { field: 'builder.filters.1.value', code: 'list_expected' },
    ])
    // Undefined names are left to the parameter check, instance variables to the server.
    expect(errors({ filters: [filter('eq', 'other')] }, context)).toEqual([])
  })

  it('keeps hostile constants inside their literals', () => {
    const compiled = compileSpec(
      spec({
        filters: [
          {
            source: 'base',
            column: 'status',
            operator: 'eq',
            value: { kind: 'constant', value: "x' OR 1=1 -- \\' /*! , telefon */" },
          },
        ],
      }),
      ctx,
    )
    expect(compiled.sql).toContain("= 'x'' OR 1=1 -- \\\\'' /*! , telefon */'")
    validates(compiled.sql)
  })
})
