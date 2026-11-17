// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto'
import type { TableConfig } from '@stashley/shared'
import { tableConfig, toMask } from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import { demoObjects } from '../../../test/demo.ts'
import { decodeCursor, encodeCursor } from './cursor.ts'
import { updateRow } from './write-sql.ts'
import { buildTableModel, ModelError, type ModelAccess, type ModelContext } from './table-model.ts'
import {
  bindForColumn,
  countStatement,
  keyIndexes,
  matchStatement,
  rowStatement,
  selectStatement,
  simulatedRowStatement,
  TableRequestError,
  type ResolvedValues,
  type TableRequest,
} from './table-sql.ts'

const catalog = new Map(demoObjects.map((object) => [object.name, object]))
const relations = [
  ...demoObjects.flatMap((object) =>
    object.foreignKeys.map((fk) => ({
      sourceObject: object.name,
      sourceColumn: fk.columns[0] ?? '',
      targetObject: fk.targetObject,
      targetColumn: fk.targetColumns[0] ?? '',
    })),
  ),
  // A virtual one-to-one relation into a view (§ Beziehungen).
  {
    sourceObject: 'anmeldung',
    sourceColumn: 'id',
    targetObject: 'v_zahlungsstatus',
    targetColumn: 'anmeldung_id',
  },
]
const read = toMask(['read'])
const accesses = new Map<string, ModelAccess>([
  [
    'person',
    {
      ceiling: read,
      excluded: new Set(['telefon']),
      active: true,
      keyColumn: 'id',
      effectiveTemplate: '{vorname} {nachname}',
    },
  ],
  [
    'event',
    {
      ceiling: read,
      excluded: new Set(),
      active: true,
      keyColumn: 'id',
      effectiveTemplate: '{name}',
    },
  ],
  [
    'anmeldung',
    {
      ceiling: read,
      excluded: new Set(),
      active: true,
      keyColumn: 'id',
      effectiveTemplate: '{startnummer} – {person.nachname}',
    },
  ],
  [
    'hotel',
    {
      ceiling: read,
      excluded: new Set(['kontakt_email']),
      active: true,
      keyColumn: 'id',
      effectiveTemplate: '{name}',
    },
  ],
  [
    'hotel_kontingent',
    {
      ceiling: read,
      excluded: new Set(),
      active: true,
      keyColumn: 'id',
      effectiveTemplate: '{zimmerart}',
    },
  ],
  [
    'hotelbuchung',
    {
      ceiling: read,
      excluded: new Set(),
      active: true,
      keyColumn: 'id',
      effectiveTemplate: '{id}',
    },
  ],
  [
    'zahlung',
    {
      ceiling: read,
      excluded: new Set(),
      active: true,
      keyColumn: 'id',
      effectiveTemplate: '{id}',
    },
  ],
  [
    'ehrung',
    {
      ceiling: toMask(['create']),
      excluded: new Set(),
      active: true,
      keyColumn: 'id',
      effectiveTemplate: '{id}',
    },
  ],
  [
    'v_zahlungsstatus',
    {
      ceiling: read,
      excluded: new Set(),
      active: true,
      keyColumn: 'anmeldung_id',
      effectiveTemplate: '{status}',
    },
  ],
])
const ctx: ModelContext = { catalog, relations, access: (name) => accesses.get(name) }
const options = { connectionTimeZone: 'Europe/Berlin', displayTimeZone: 'Europe/Berlin' }

const config = (over: Partial<TableConfig> = {}): TableConfig =>
  tableConfig.parse({
    columns: [{ kind: 'column', id: 'betrag', column: { path: [], column: 'betrag' } }],
    sort: null,
    searchColumns: [],
    baseFilter: [],
    bindings: [],
    pageSize: 50,
    ...over,
  })

/** The hotel guest page: bookings of one hotel and the current event (§ Gästeseiten). */
const guests = config({
  columns: [
    { kind: 'column', id: 'anreise', column: { path: [], column: 'anreise' } },
    { kind: 'display', id: 'gast', path: [{ column: 'anmeldung_id', target: 'anmeldung' }] },
    {
      kind: 'column',
      id: 'land',
      column: {
        path: [
          { column: 'anmeldung_id', target: 'anmeldung' },
          { column: 'person_id', target: 'person' },
        ],
        column: 'land',
      },
    },
    { kind: 'column', id: 'eingecheckt', column: { path: [], column: 'eingecheckt_am' } },
  ],
  sort: { columnId: 'anreise', direction: 'asc' },
  searchColumns: ['gast'],
  baseFilter: [
    {
      column: {
        path: [{ column: 'hotel_kontingent_id', target: 'hotel_kontingent' }],
        column: 'hotel_id',
      },
      operator: 'eq',
      value: { kind: 'constant', value: 2 },
    },
    {
      column: {
        path: [{ column: 'hotel_kontingent_id', target: 'hotel_kontingent' }],
        column: 'event_id',
      },
      operator: 'eq',
      value: { kind: 'variable', name: 'current_event_id' },
    },
  ],
})
const guestValues: ResolvedValues = { baseFilter: [2, 14], bindings: [] }
const page = (over: Partial<TableRequest> = {}): TableRequest => ({
  filters: [],
  limit: 50,
  ...over,
})

describe('table source model', () => {
  it('shares join prefixes and compiles display templates over a further relation', () => {
    const model = buildTableModel('hotelbuchung', guests, ctx)
    expect(model.joins).toEqual([
      {
        alias: 't1',
        parent: 't0',
        parentColumn: 'anmeldung_id',
        object: 'anmeldung',
        column: 'id',
      },
      { alias: 't2', parent: 't1', parentColumn: 'person_id', object: 'person', column: 'id' },
      {
        alias: 't3',
        parent: 't0',
        parentColumn: 'hotel_kontingent_id',
        object: 'hotel_kontingent',
        column: 'id',
      },
    ])
    expect(model.columns[1]?.expr).toEqual({
      type: 'template',
      parts: [
        { alias: 't1', column: 'startnummer', kind: 'integer' },
        ' – ',
        { alias: 't2', column: 'nachname', kind: 'string' },
      ],
    })
    expect(model.objects).toEqual(['anmeldung', 'hotel_kontingent', 'hotelbuchung', 'person'])
    expect(model.columnsUsed).toContainEqual({ object: 'hotel_kontingent', column: 'hotel_id' })
    expect(model.fingerprint).toHaveLength(22)
    expect(buildTableModel('hotelbuchung', guests, ctx).fingerprint).toBe(model.fingerprint)
  })

  it('takes component templates, also into views over a one-to-one relation', () => {
    const model = buildTableModel(
      'zahlung',
      config({
        columns: [
          {
            kind: 'display',
            id: 'anmeldung',
            path: [{ column: 'anmeldung_id', target: 'anmeldung' }],
            template: '{startnummer} ({person.vorname}) {event.name}',
          },
          {
            kind: 'column',
            id: 'offen',
            column: {
              path: [
                { column: 'anmeldung_id', target: 'anmeldung' },
                { column: 'id', target: 'v_zahlungsstatus' },
              ],
              column: 'offen',
            },
          },
        ],
      }),
      ctx,
    )
    expect(model.columns[0]?.expr).toMatchObject({
      type: 'template',
      parts: [{ column: 'startnummer' }, ' (', { column: 'vorname' }, ') ', { column: 'name' }],
    })
    expect(model.joins.map((join) => join.object)).toEqual([
      'anmeldung',
      'person',
      'event',
      'v_zahlungsstatus',
    ])
  })

  it('refuses excluded columns, unknown relations and unreadable objects', () => {
    const fail = (object: string, over: Partial<TableConfig>) => {
      try {
        buildTableModel(object, config(over), ctx)
        return []
      } catch (error) {
        if (error instanceof ModelError) return error.errors
        throw error
      }
    }
    expect(fail('ehrung', {})).toEqual([{ field: 'source', code: 'object_not_readable' }])
    expect(fail('nirgends', {})).toEqual([{ field: 'source', code: 'object_not_readable' }])
    expect(
      fail('hotel', {
        columns: [{ kind: 'column', id: 'k', column: { path: [], column: 'kontakt_email' } }],
      }),
    ).toEqual([{ field: 'table.columns.0.column', code: 'excluded_column' }])
    expect(
      fail('anmeldung', {
        columns: [
          {
            kind: 'column',
            id: 'x',
            column: { path: [{ column: 'person_id', target: 'person' }], column: 'telefon' },
          },
          {
            kind: 'column',
            id: 'x',
            column: { path: [{ column: 'event_id', target: 'person' }], column: 'id' },
          },
          { kind: 'column', id: 'y', column: { path: [], column: 'nirgends' } },
          {
            kind: 'display',
            id: 'z',
            path: [{ column: 'person_id', target: 'person' }],
            template: '{telefon}',
          },
          {
            kind: 'display',
            id: 'w',
            path: [{ column: 'person_id', target: 'person' }],
            template: 'kein Platzhalter',
          },
        ],
        searchColumns: ['fehlt'],
        sort: { columnId: 'fehlt', direction: 'asc' },
        baseFilter: [
          {
            column: { path: [], column: 'status' },
            operator: 'null',
            value: { kind: 'constant', value: 'x' },
          },
        ],
      }),
    ).toEqual([
      { field: 'table.columns.0.column', code: 'excluded_column' },
      { field: 'table.columns.1.id', code: 'duplicate' },
      { field: 'table.columns.1.path.0', code: 'unknown_relation' },
      { field: 'table.columns.2.column', code: 'unknown_column' },
      { field: 'table.columns.3.template', code: 'template_excluded_column' },
      { field: 'table.columns.4.template', code: 'template_invalid' },
      { field: 'table.baseFilter.0.value', code: 'invalid' },
      { field: 'table.searchColumns.0', code: 'unknown_column' },
      { field: 'table.sort.columnId', code: 'unknown_column' },
    ])
    // A path into an object without read access.
    expect(
      fail('zahlung', {
        columns: [
          {
            kind: 'column',
            id: 'x',
            column: { path: [{ column: 'anmeldung_id', target: 'ehrung' }], column: 'id' },
          },
        ],
      }),
    ).toEqual([{ field: 'table.columns.0.path.0', code: 'unknown_relation' }])
  })
})

describe('table source SQL', () => {
  const model = buildTableModel('hotelbuchung', guests, ctx)

  it('selects a first page with joins, base filter and key tiebreak', () => {
    const statement = selectStatement(model, guestValues, page(), options)
    expect(statement.sql).toBe(
      "SELECT `t0`.`anreise` AS `c0`, CONCAT(COALESCE(CAST(`t1`.`startnummer` AS CHAR), ''), ?, COALESCE(CAST(`t2`.`nachname` AS CHAR), '')) AS `c1`, `t2`.`land` AS `c2`, `t0`.`eingecheckt_am` AS `c3`, `t0`.`id` AS `k`, `t0`.`anreise` AS `s`" +
        ' FROM `hotelbuchung` AS `t0` LEFT JOIN `anmeldung` AS `t1` ON `t1`.`id` = `t0`.`anmeldung_id` LEFT JOIN `person` AS `t2` ON `t2`.`id` = `t1`.`person_id` LEFT JOIN `hotel_kontingent` AS `t3` ON `t3`.`id` = `t0`.`hotel_kontingent_id`' +
        ' WHERE `t3`.`hotel_id` = ? AND `t3`.`event_id` = ? ORDER BY `t0`.`anreise` ASC, `t0`.`id` ASC LIMIT ?',
    )
    expect(statement.values).toEqual([' – ', 2, 14, 51])
    expect(statement).toMatchObject({ sortIsKey: false, reversed: false })
  })

  it('continues after a cursor, with NULL handling in both directions', () => {
    const sorted = (direction: 'asc' | 'desc', cursor: TableRequest['cursor']) =>
      selectStatement(
        model,
        guestValues,
        page({ sort: { columnId: 'eingecheckt', direction }, cursor }),
        options,
      )
    const after = sorted('asc', { direction: 'next', sort: '2026-05-08 18:00:00', key: 3 })
    expect(after.sql).toContain(
      'AND (`t0`.`eingecheckt_am` > ? OR (`t0`.`eingecheckt_am` = ? AND `t0`.`id` > ?)) ORDER BY `t0`.`eingecheckt_am` ASC, `t0`.`id` ASC',
    )
    expect(after.values.slice(-4)).toEqual(['2026-05-08 18:00:00', '2026-05-08 18:00:00', 3, 51])
    expect(sorted('asc', { direction: 'next', sort: null, key: 3 }).sql).toContain(
      'AND ((`t0`.`eingecheckt_am` IS NULL AND `t0`.`id` > ?) OR `t0`.`eingecheckt_am` IS NOT NULL)',
    )
    expect(
      sorted('desc', { direction: 'next', sort: '2026-05-08 18:00:00', key: 3 }).sql,
    ).toContain(
      'AND (`t0`.`eingecheckt_am` < ? OR (`t0`.`eingecheckt_am` = ? AND `t0`.`id` < ?) OR `t0`.`eingecheckt_am` IS NULL) ORDER BY `t0`.`eingecheckt_am` DESC, `t0`.`id` DESC',
    )
    expect(sorted('desc', { direction: 'next', sort: null, key: 3 }).sql).toContain(
      'AND (`t0`.`eingecheckt_am` IS NULL AND `t0`.`id` < ?)',
    )
    // Backward pages reverse comparison and order; the caller turns the rows around.
    const back = sorted('asc', { direction: 'prev', sort: '2026-05-08 18:00:00', key: 3 })
    expect(back.sql).toContain('ORDER BY `t0`.`eingecheckt_am` DESC, `t0`.`id` DESC')
    expect(back.reversed).toBe(true)
  })

  it('pages by the key alone when it is the sort', () => {
    const keyed = buildTableModel(
      'zahlung',
      config({
        columns: [{ kind: 'column', id: 'id', column: { path: [], column: 'id' } }],
        sort: { columnId: 'id', direction: 'desc' },
      }),
      ctx,
    )
    const statement = selectStatement(
      keyed,
      { baseFilter: [], bindings: [] },
      page({ cursor: { direction: 'next', sort: null, key: 9 }, limit: 10 }),
      options,
    )
    expect(statement.sql).toBe(
      'SELECT `t0`.`id` AS `c0`, `t0`.`id` AS `k` FROM `zahlung` AS `t0` WHERE `t0`.`id` < ? ORDER BY `t0`.`id` DESC LIMIT ?',
    )
    expect(statement.values).toEqual([9, 11])
    expect(
      selectStatement(
        buildTableModel('zahlung', config(), ctx),
        { baseFilter: [], bindings: [] },
        page(),
        options,
      ).sql,
    ).toContain('ORDER BY `t0`.`id` ASC')
  })

  it('applies column filters, search and page filter bindings', () => {
    const bound = buildTableModel(
      'anmeldung',
      config({
        columns: [
          { kind: 'column', id: 'start', column: { path: [], column: 'startnummer' } },
          { kind: 'column', id: 'am', column: { path: [], column: 'angemeldet_am' } },
          { kind: 'display', id: 'person', path: [{ column: 'person_id', target: 'person' }] },
        ],
        searchColumns: ['person', 'start'],
        bindings: [
          {
            from: { kind: 'filter', filterId: 'teilnehmer' },
            column: { path: [], column: 'id' },
            operator: 'eq',
          },
          {
            from: { kind: 'filter', filterId: 'tag' },
            column: { path: [], column: 'angemeldet_am' },
            operator: 'range',
          },
          {
            from: { kind: 'filter', filterId: 'name' },
            column: { path: [{ column: 'person_id', target: 'person' }], column: 'nachname' },
            operator: 'contains',
          },
          {
            from: { kind: 'url', name: 'stati' },
            column: { path: [], column: 'status' },
            operator: 'in',
          },
        ],
      }),
      ctx,
    )
    const statement = selectStatement(
      bound,
      {
        baseFilter: [],
        bindings: [7, { from: '2026-03-29', to: '2026-03-29' }, 'Be_rg', ['angemeldet']],
      },
      page({
        search: '20%',
        filters: [
          { columnId: 'start', operator: 'gte', value: 200 },
          { columnId: 'start', operator: 'in', value: [201, '202'] },
          { columnId: 'am', operator: 'lt', value: '2026-04-01T00:00:00Z' },
          { columnId: 'person', operator: 'contains', value: 'Ber' },
          { columnId: 'am', operator: 'not_null' },
        ],
      }),
      options,
    )
    expect(statement.sql).toContain(
      'WHERE `t0`.`id` = ? AND `t0`.`angemeldet_am` >= ? AND `t0`.`angemeldet_am` < ? AND `t1`.`nachname` LIKE ? AND `t0`.`status` IN (?) AND `t0`.`startnummer` >= ? AND `t0`.`startnummer` IN (?, ?) AND `t0`.`angemeldet_am` < ? AND CONCAT(',
    )
    expect(statement.sql).toContain('`t0`.`angemeldet_am` IS NOT NULL AND (CONCAT(')
    expect(statement.values).toEqual([
      ' ',
      7,
      // The day in the display zone, as wall times of the connection (D13).
      '2026-03-29 00:00:00.000000',
      '2026-03-30 00:00:00.000000',
      '%Be\\_rg%',
      'angemeldet',
      200,
      201,
      202,
      '2026-04-01 02:00:00.000000',
      ' ',
      '%Ber%',
      ' ',
      '%20\\%%',
      '%20\\%%',
      51,
    ])
    // Unset bindings do not filter.
    const open = selectStatement(
      bound,
      { baseFilter: [], bindings: [undefined, null, '', undefined] },
      page(),
      options,
    )
    expect(open.sql).not.toContain('WHERE')
  })

  it('rejects values that do not fit the column', () => {
    const fail = (request: Partial<TableRequest>, bindings: unknown[] = []) => {
      try {
        selectStatement(
          buildTableModel(
            'anmeldung',
            config({
              columns: [
                { kind: 'column', id: 'start', column: { path: [], column: 'startnummer' } },
                {
                  kind: 'display',
                  id: 'person',
                  path: [{ column: 'person_id', target: 'person' }],
                },
              ],
              bindings: [
                {
                  from: { kind: 'filter', filterId: 'a' },
                  column: { path: [], column: 'startnummer' },
                  operator: 'range',
                },
                {
                  from: { kind: 'filter', filterId: 'b' },
                  column: { path: [], column: 'startnummer' },
                  operator: 'eq',
                },
                {
                  from: { kind: 'filter', filterId: 'c' },
                  column: { path: [], column: 'status' },
                  operator: 'contains',
                },
              ],
            }),
            ctx,
          ),
          { baseFilter: [], bindings },
          page(request),
          options,
        )
        return []
      } catch (error) {
        if (error instanceof TableRequestError) return error.errors
        throw error
      }
    }
    expect(
      fail({
        filters: [
          { columnId: 'nope', operator: 'eq', value: 1 },
          { columnId: 'start', operator: 'eq', value: 'x' },
          { columnId: 'start', operator: 'in', value: [] },
          { columnId: 'start', operator: 'in', value: ['x'] },
          { columnId: 'start', operator: 'contains', value: '' },
          { columnId: 'person', operator: 'eq', value: 'x' },
        ],
      }),
    ).toEqual([
      { field: 'filters.0.columnId', code: 'unknown_column' },
      { field: 'filters.1.value', code: 'invalid' },
      { field: 'filters.2.value', code: 'invalid' },
      { field: 'filters.3.value', code: 'invalid' },
      { field: 'filters.4.value', code: 'invalid' },
      { field: 'filters.5.operator', code: 'not_allowed' },
    ])
    expect(fail({}, ['2026-01-01', 'x', 5])).toEqual([
      { field: 'bindings.0', code: 'not_a_date' },
      { field: 'bindings.1', code: 'invalid' },
      { field: 'bindings.2', code: 'invalid' },
    ])
    expect(fail({}, [{ from: 'x' }])).toEqual([{ field: 'bindings.0', code: 'invalid' }])
    expect(fail({ sort: { columnId: 'nope', direction: 'asc' } })).toEqual([
      { field: 'sort.columnId', code: 'unknown_column' },
    ])
  })

  it('counts with only the joins the filters need, and reads one row within the base filter', () => {
    expect(countStatement(model, guestValues, { filters: [] }, options).sql).toBe(
      'SELECT COUNT(*) AS `n` FROM `hotelbuchung` AS `t0` LEFT JOIN `hotel_kontingent` AS `t3` ON `t3`.`id` = `t0`.`hotel_kontingent_id` WHERE `t3`.`hotel_id` = ? AND `t3`.`event_id` = ?',
    )
    const searched = countStatement(model, guestValues, { filters: [], search: 'Berg' }, options)
    expect(searched.sql).toContain('LEFT JOIN `person` AS `t2`')
    const row = rowStatement(model, guestValues, 17)
    expect(row.sql).toMatch(
      /WHERE `t3`.`hotel_id` = \? AND `t3`.`event_id` = \? AND `t0`.`id` = \? LIMIT 1$/,
    )
    expect(row.values.slice(-3)).toEqual([2, 14, 17])
  })

  it('reads the row a simulated write would leave through a derived table (§11.2)', () => {
    // An update: the stored row with the changed column replaced, then the base filter.
    const changed = simulatedRowStatement(model, guestValues, {
      keyColumn: 'id',
      key: 17,
      changes: [['hotel_kontingent_id', '2']],
    })
    expect(changed.sql).toContain(
      'FROM (SELECT `id`, `anreise`, `eingecheckt_am`, `anmeldung_id`, ? AS `hotel_kontingent_id` FROM `hotelbuchung` WHERE `id` = ?) AS `t0` LEFT JOIN',
    )
    expect(changed.sql).toMatch(/WHERE `t3`.`hotel_id` = \? AND `t3`.`event_id` = \? LIMIT 1$/)
    // The display template's literal comes first, then the derived table, then the filter.
    expect(changed.values).toEqual([' – ', '2', 17, 2, 14])
    // A new row: only its values, every other own column NULL.
    const created = simulatedRowStatement(model, guestValues, {
      values: [
        ['hotel_kontingent_id', 1],
        ['anreise', '2026-05-08'],
      ],
    })
    expect(created.sql).toContain(
      'FROM (SELECT NULL AS `id`, ? AS `anreise`, NULL AS `eingecheckt_am`, NULL AS `anmeldung_id`, ? AS `hotel_kontingent_id`) AS `t0`',
    )
    expect(created.values).toEqual([' – ', '2026-05-08', 1, 2, 14])
  })

  it('compiles every base filter operator', () => {
    const operators = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'null', 'not_null'] as const
    const filtered = buildTableModel(
      'zahlung',
      config({
        baseFilter: operators.map((operator) => ({
          column: { path: [], column: 'betrag' },
          operator,
          ...(operator === 'null' || operator === 'not_null'
            ? {}
            : { value: { kind: 'constant' as const, value: 1 } }),
        })),
      }),
      ctx,
    )
    const statement = countStatement(
      filtered,
      { baseFilter: [1, 1, 1, 1, 1, 1, [1, 2], undefined, undefined], bindings: [] },
      { filters: [] },
      options,
    )
    expect(statement.sql).toBe(
      'SELECT COUNT(*) AS `n` FROM `zahlung` AS `t0` WHERE `t0`.`betrag` = ? AND `t0`.`betrag` <> ? AND `t0`.`betrag` < ? AND `t0`.`betrag` <= ? AND `t0`.`betrag` > ? AND `t0`.`betrag` >= ? AND `t0`.`betrag` IN (?, ?) AND `t0`.`betrag` IS NULL AND `t0`.`betrag` IS NOT NULL',
    )
    const none = countStatement(
      filtered,
      { baseFilter: [1, 1, 1, 1, 1, 1, [], undefined, undefined], bindings: [] },
      { filters: [] },
      options,
    )
    expect(none.sql).toContain('1 = 0')
  })
})

describe('column values', () => {
  it('bind by kind', () => {
    expect(bindForColumn('integer', '5', options)).toEqual({ ok: true, value: 5 })
    expect(bindForColumn('decimal', 4.5, options)).toEqual({ ok: true, value: '4.5' })
    expect(bindForColumn('date', '2026-05-01', options)).toEqual({ ok: true, value: '2026-05-01' })
    expect(bindForColumn('datetime', '2026-05-01T08:00:00Z', options)).toEqual({
      ok: true,
      value: '2026-05-01 10:00:00.000000',
    })
    expect(bindForColumn('timestamp', '2026-05-01T08:00:00Z', options)).toEqual({
      ok: true,
      value: '2026-05-01 08:00:00.000000',
    })
    expect(bindForColumn('datetime', 'x', options)).toEqual({ ok: false, code: 'invalid' })
    expect(bindForColumn('boolean', true, options)).toEqual({ ok: true, value: 1 })
    expect(bindForColumn('boolean', false, options)).toEqual({ ok: true, value: 0 })
    expect(bindForColumn('boolean', 'x', options)).toEqual({ ok: false, code: 'invalid' })
    expect(bindForColumn('time', '12:30', options)).toEqual({ ok: true, value: '12:30' })
    expect(bindForColumn('time', '12', options)).toEqual({ ok: false, code: 'invalid' })
    expect(bindForColumn('enum', 'a', options)).toEqual({ ok: true, value: 'a' })
    expect(bindForColumn('json', '{}', options)).toEqual({ ok: false, code: 'not_filterable' })
  })
})

describe('cursors', () => {
  const key = Buffer.alloc(32, 7)

  it('round-trip and refuse anything else', () => {
    const cursor = encodeCursor(key, {
      fingerprint: 'abc',
      direction: 'next',
      sort: '2026-01-01',
      key: 5,
    })
    expect(decodeCursor(key, cursor, 'abc')).toEqual({
      direction: 'next',
      sort: '2026-01-01',
      key: 5,
    })
    // Another query, another key, a changed payload, broken shapes.
    expect(decodeCursor(key, cursor, 'xyz')).toBeUndefined()
    expect(decodeCursor(Buffer.alloc(32, 8), cursor, 'abc')).toBeUndefined()
    const [payload, signature] = cursor.split('.')
    const forged = Buffer.from(JSON.stringify([1, 'abc', 'next', null, 999])).toString('base64url')
    expect(decodeCursor(key, `${forged}.${signature ?? ''}`, 'abc')).toBeUndefined()
    expect(decodeCursor(key, `${payload ?? ''}.${signature ?? ''}.x`, 'abc')).toBeUndefined()
    expect(decodeCursor(key, 'x'.repeat(5000), 'abc')).toBeUndefined()
    expect(decodeCursor(key, 'nodot', 'abc')).toBeUndefined()
    const sign = (body: unknown) => Buffer.from(JSON.stringify(body)).toString('base64url')
    for (const body of [
      [2, 'abc', 'next', null, 1],
      [1, 'abc', 'up', null, 1],
      [1, 'abc', 'next', {}, 1],
      [1, 'abc', 'next', null, null],
      [1, 'abc'],
      'x',
    ]) {
      const text = sign(body)
      const signature = createSignature(key, text)
      expect(decodeCursor(key, `${text}.${signature}`, 'abc'), JSON.stringify(body)).toBeUndefined()
    }
    const garbage = 'not-json'
    expect(decodeCursor(key, `${garbage}.${createSignature(key, garbage)}`, 'abc')).toBeUndefined()
  })
})

/** Same signature as the cursor module, to reach the checks after it. */
function createSignature(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url').slice(0, 22)
}

describe('table source edge cases', () => {
  const extraCatalog = new Map(catalog)
  const zahlung = catalog.get('zahlung')
  if (zahlung === undefined) throw new Error('fixture')
  extraCatalog.set('zahlung', {
    ...zahlung,
    columns: [
      ...zahlung.columns,
      {
        ...zahlung.columns[0],
        name: 'beleg',
        kind: 'unsupported',
      } as (typeof zahlung.columns)[number],
      {
        ...zahlung.columns[0],
        name: 'gebucht_um',
        kind: 'timestamp',
      } as (typeof zahlung.columns)[number],
      {
        ...zahlung.columns[0],
        name: 'markierungen',
        kind: 'set',
      } as (typeof zahlung.columns)[number],
    ],
  })
  const extraAccess = new Map(accesses)
  const stale = (object: string, template: string, keyColumn = 'id') => {
    const base = accesses.get(object)
    if (base === undefined) throw new Error('fixture')
    extraAccess.set(object, { ...base, effectiveTemplate: template, keyColumn })
  }
  const extra: ModelContext = {
    catalog: extraCatalog,
    relations: [
      ...relations,
      {
        sourceObject: 'zahlung',
        sourceColumn: 'anmeldung_id',
        targetObject: 'ehrung',
        targetColumn: 'id',
      },
      {
        sourceObject: 'person',
        sourceColumn: 'telefon',
        targetObject: 'event',
        targetColumn: 'id',
      },
      {
        sourceObject: 'anmeldung',
        sourceColumn: 'status',
        targetObject: 'hotel',
        targetColumn: 'kontakt_email',
      },
    ],
    access: (name) => extraAccess.get(name),
  }
  const fail = (object: string, over: Partial<TableConfig>, context = extra) => {
    try {
      buildTableModel(object, config(over), context)
      return []
    } catch (error) {
      if (error instanceof ModelError) return error.errors
      throw error
    }
  }

  it('refuses join keys and columns that may not be read', () => {
    expect(
      fail('zahlung', {
        columns: [
          {
            kind: 'column',
            id: 'a',
            column: { path: [{ column: 'anmeldung_id', target: 'ehrung' }], column: 'id' },
          },
          { kind: 'column', id: 'b', column: { path: [], column: 'beleg' } },
        ],
      }),
    ).toEqual([
      { field: 'table.columns.0.path.0', code: 'object_not_readable' },
      { field: 'table.columns.1.column', code: 'unsupported_column' },
    ])
    expect(
      fail('person', {
        columns: [
          {
            kind: 'column',
            id: 'a',
            column: { path: [{ column: 'telefon', target: 'event' }], column: 'name' },
          },
        ],
      }),
    ).toEqual([{ field: 'table.columns.0.path.0', code: 'excluded_column' }])
    expect(
      fail('anmeldung', {
        columns: [
          {
            kind: 'column',
            id: 'a',
            column: { path: [{ column: 'status', target: 'hotel' }], column: 'name' },
          },
          { kind: 'display', id: 'b', path: [{ column: 'event_id', target: 'person' }] },
        ],
        baseFilter: [{ column: { path: [], column: 'nirgends' }, operator: 'null' }],
        bindings: [
          {
            from: { kind: 'url', name: 'x' },
            column: { path: [], column: 'nirgends' },
            operator: 'eq',
          },
        ],
      }),
    ).toEqual([
      { field: 'table.columns.0.path.0', code: 'excluded_column' },
      { field: 'table.columns.1.path.0', code: 'unknown_relation' },
      { field: 'table.baseFilter.0.column', code: 'unknown_column' },
      { field: 'table.bindings.0.column', code: 'unknown_column' },
    ])
  })

  it('checks stored templates again, so later exclusions never show', () => {
    const display = (target: string, template?: string) =>
      fail('anmeldung', {
        columns: [
          {
            kind: 'display',
            id: 'd',
            path: [{ column: target === 'person' ? 'person_id' : 'event_id', target }],
            ...(template !== undefined && { template }),
          },
        ],
      })
    stale('person', '{telefon}')
    expect(display('person')).toEqual([
      { field: 'table.columns.0.template', code: 'excluded_column' },
    ])
    stale('person', '')
    expect(display('person')).toEqual([
      { field: 'table.columns.0.template', code: 'template_invalid' },
    ])
    stale('person', '{nirgends.x}')
    expect(display('person')).toEqual([
      { field: 'table.columns.0.template', code: 'template_unknown_relation' },
    ])
    stale('person', '{vorname}')
    stale('event', 'Event {name}')
    expect(
      fail('anmeldung', {
        columns: [{ kind: 'display', id: 'd', path: [{ column: 'event_id', target: 'event' }] }],
      }),
    ).toEqual([])
    // The stored template of a registration names an excluded column of the person.
    stale('anmeldung', '{startnummer} {person.telefon}')
    expect(
      fail('zahlung', {
        columns: [
          { kind: 'display', id: 'd', path: [{ column: 'anmeldung_id', target: 'anmeldung' }] },
        ],
      }),
    ).toEqual([{ field: 'table.columns.0.template', code: 'excluded_column' }])
    // The relation behind `{status.name}` joins on an excluded key.
    stale('anmeldung', '{startnummer} {status.name}')
    expect(
      fail('zahlung', {
        columns: [
          { kind: 'display', id: 'd', path: [{ column: 'anmeldung_id', target: 'anmeldung' }] },
        ],
      }),
    ).toEqual([{ field: 'table.columns.0.template.1', code: 'excluded_column' }])
    stale('anmeldung', '{startnummer}')
    // An override with a target that cannot be read.
    const inactive = {
      ...extra,
      access: (name: string) =>
        name === 'event'
          ? { ...(accesses.get('event') as ModelAccess), active: false }
          : extraAccess.get(name),
    }
    expect(
      fail(
        'zahlung',
        {
          columns: [
            {
              kind: 'display',
              id: 'd',
              path: [{ column: 'anmeldung_id', target: 'anmeldung' }],
              template: '{event.name}',
            },
          ],
        },
        inactive,
      ),
    ).toEqual([{ field: 'table.columns.0.template', code: 'template_target_not_exposed' }])
    stale('zahlung', '{id}', 'nirgends')
    expect(fail('zahlung', {})).toEqual([{ field: 'source', code: 'unknown_column' }])
    stale('zahlung', '{id}')
  })

  it('compiles date ranges on dates and timestamps and other edge values', () => {
    const model = buildTableModel(
      'zahlung',
      config({
        columns: [
          { kind: 'column', id: 'eingang', column: { path: [], column: 'eingang_am' } },
          { kind: 'column', id: 'gebucht', column: { path: [], column: 'gebucht_um' } },
          { kind: 'column', id: 'markierungen', column: { path: [], column: 'markierungen' } },
          { kind: 'column', id: 'id', column: { path: [], column: 'id' } },
        ],
        bindings: [
          {
            from: { kind: 'filter', filterId: 'a' },
            column: { path: [], column: 'eingang_am' },
            operator: 'range',
          },
          {
            from: { kind: 'filter', filterId: 'b' },
            column: { path: [], column: 'gebucht_um' },
            operator: 'eq',
          },
          {
            from: { kind: 'filter', filterId: 'c' },
            column: { path: [], column: 'eingang_am' },
            operator: 'range',
          },
          {
            from: { kind: 'filter', filterId: 'd' },
            column: { path: [], column: 'id' },
            operator: 'in',
          },
        ],
        baseFilter: [
          {
            column: { path: [], column: 'id' },
            operator: 'in',
            value: { kind: 'constant', value: 1 },
          },
        ],
      }),
      extra,
    )
    const statement = selectStatement(
      model,
      {
        baseFilter: [1],
        bindings: [{ from: '2026-05-01' }, { to: '2026-05-02' }, '2026-05-03', []],
      },
      page({
        sort: { columnId: 'id', direction: 'asc' },
        cursor: { direction: 'prev', sort: null, key: 4 },
        filters: [
          { columnId: 'markierungen', operator: 'eq', value: 'a' },
          { columnId: 'eingang', operator: 'null' },
        ],
      }),
      options,
    )
    expect(statement.sql).toContain(
      'WHERE `t0`.`id` IN (?) AND `t0`.`eingang_am` >= ? AND `t0`.`gebucht_um` < ? AND `t0`.`eingang_am` >= ? AND `t0`.`eingang_am` <= ? AND `t0`.`markierungen` = ? AND `t0`.`eingang_am` IS NULL AND `t0`.`id` < ? ORDER BY `t0`.`id` DESC',
    )
    // The end of 2 May in Berlin, as a UTC timestamp.
    expect(statement.values).toContain('2026-05-02 22:00:00.000000')
    expect(() =>
      selectStatement(
        model,
        { baseFilter: [1], bindings: [{}, undefined, undefined, undefined] },
        page(),
        options,
      ),
    ).toThrow(TableRequestError)
    expect(bindForColumn('string', 'x', options)).toEqual({ ok: true, value: 'x' })
    expect(bindForColumn('set', 'a,b', options)).toEqual({ ok: true, value: 'a,b' })
  })
})

describe('public API and import statements', () => {
  const plain = { baseFilter: [], bindings: [] }
  const people = buildTableModel(
    'person',
    config({
      columns: [
        { kind: 'column', id: 'vorname', column: { path: [], column: 'vorname' } },
        { kind: 'column', id: 'nachname', column: { path: [], column: 'nachname' } },
      ],
    }),
    ctx,
  )

  it("filters with the client's own LIKE pattern and refuses anything else (E19)", () => {
    const statement = selectStatement(
      people,
      plain,
      page({ filters: [{ columnId: 'nachname', operator: 'like', value: 'B%' }] }),
      options,
    )
    expect(statement.sql).toContain('WHERE `t0`.`nachname` LIKE ? ORDER BY')
    expect(statement.values).toEqual(['B%', 51])
    for (const value of [5, 'x'.repeat(1001)]) {
      expect(() =>
        selectStatement(
          people,
          plain,
          page({ filters: [{ columnId: 'nachname', operator: 'like', value }] }),
          options,
        ),
      ).toThrow(TableRequestError)
    }
  })

  it('pages by position, ordered by every column, for views without a key', () => {
    const first = selectStatement(people, plain, page({ offset: 0, limit: 10 }), options)
    expect(first.sql).toBe(
      'SELECT `t0`.`vorname` AS `c0`, `t0`.`nachname` AS `c1`, `t0`.`id` AS `k` FROM `person` AS `t0` ORDER BY `t0`.`vorname` ASC, `t0`.`nachname` ASC LIMIT ? OFFSET ?',
    )
    expect(first.values).toEqual([11, 0])
    expect(first).toMatchObject({ sortIsKey: true, reversed: false })
    const sorted = selectStatement(
      people,
      plain,
      page({ offset: 20, limit: 10, sort: { columnId: 'nachname', direction: 'desc' } }),
      options,
    )
    expect(sorted.sql).toContain(
      'ORDER BY `t0`.`nachname` DESC, `t0`.`vorname` ASC, `t0`.`nachname` ASC LIMIT ? OFFSET ?',
    )
    expect(sorted.values).toEqual([11, 20])
    const ascending = selectStatement(
      people,
      plain,
      page({
        offset: 0,
        limit: 1,
        sort: { columnId: 'vorname', direction: 'asc' },
        filters: [{ columnId: 'nachname', operator: 'eq', value: 'Berg' }],
      }),
      options,
    )
    expect(ascending.sql).toContain(
      'WHERE `t0`.`nachname` = ? ORDER BY `t0`.`vorname` ASC, `t0`.`vorname` ASC',
    )
  })

  it('looks up keys by a column or a display value (E26)', () => {
    const byEmail = buildTableModel(
      'person',
      config({
        columns: [
          { kind: 'column', id: 'value', column: { path: [], column: 'id' } },
          { kind: 'column', id: 'match', column: { path: [], column: 'email' } },
        ],
      }),
      ctx,
    )
    const statement = matchStatement(byEmail, ['a@example.com', 'b@example.com'])
    // The database also says which value each row matches, with the column's collation.
    expect(statement.sql).toBe(
      "SELECT `t0`.`id` AS `v`, `t0`.`email` AS `m`, CONCAT_WS(',', IF(`t0`.`email` = ?, ?, NULL), IF(`t0`.`email` = ?, ?, NULL)) AS `i` FROM `person` AS `t0` WHERE `t0`.`email` IN (?, ?)",
    )
    expect(statement.values).toEqual([
      'a@example.com',
      '0',
      'b@example.com',
      '1',
      'a@example.com',
      'b@example.com',
    ])
    expect(keyIndexes('0,1')).toEqual([0, 1])
    expect(keyIndexes(null)).toEqual([])
    // The import builds this model itself; the display value of the row's own object.
    const byName = buildTableModel(
      'person',
      {
        ...config(),
        columns: [
          { kind: 'column', id: 'value', column: { path: [], column: 'id' } },
          { kind: 'display', id: 'match', path: [] },
        ],
      },
      ctx,
    )
    expect(matchStatement(byName, ['Anna Berg']).sql).toContain(
      "WHERE CONCAT(COALESCE(CAST(`t0`.`vorname` AS CHAR), ''), ?, COALESCE(CAST(`t0`.`nachname` AS CHAR), '')) IN (?)",
    )
    expect(() => matchStatement(byEmail, [])).toThrow(TableRequestError)
    expect(() => matchStatement(people, ['x'])).toThrow(TableRequestError)
  })

  it('sets a column back to its default with PUT /:id (D6)', () => {
    const statement = updateRow('person', 'id', 7, [
      ['vorname', { value: 'Anna' }],
      ['telefon', { expression: 'default' }],
      ['version', { expression: 'increment' }],
    ])
    expect(statement.sql).toBe(
      'UPDATE `person` SET `vorname` = ?, `telefon` = DEFAULT, `version` = `version` + 1 WHERE `id` = ?',
    )
    expect(statement.values).toEqual(['Anna', 7])
  })
})
