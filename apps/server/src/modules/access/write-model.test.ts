// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  CatalogColumn,
  CatalogObject,
  FormField,
  LockStrategy,
  ValueKind,
} from '@stashley/shared'
import { emptyPage, fieldList, toMask } from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import type { ConnectionFacts, ObjectFacts } from './facts.ts'
import { buildWriteModel, type WriteInput } from './write-model.ts'

function col(name: string, kind: ValueKind, extra: Partial<CatalogColumn> = {}): CatalogColumn {
  return {
    name,
    position: 1,
    dataType: kind,
    columnType: kind === 'string' ? 'varchar(80)' : kind === 'decimal' ? 'decimal(8,2)' : kind,
    kind,
    nullable: true,
    defaultValue: null,
    autoIncrement: false,
    generated: false,
    onUpdate: null,
    maxLength: kind === 'string' ? 80 : null,
    precision: kind === 'decimal' ? 8 : null,
    scale: kind === 'decimal' ? 2 : null,
    ...extra,
  }
}

const id = col('id', 'bigint', { nullable: false, autoIncrement: true })
const objects: CatalogObject[] = [
  {
    name: 'zahlung',
    type: 'table',
    rowEstimate: 0,
    columns: [
      id,
      col('anmeldung_id', 'bigint', { nullable: false }),
      col('betrag', 'decimal', { nullable: false }),
      col('eingang_am', 'date', { nullable: false }),
      col('kommentar', 'string'),
      col('intern', 'string'),
      col('summe', 'decimal', { generated: true }),
      col('updated_at', 'datetime', { nullable: false, defaultValue: 'current_timestamp()' }),
    ],
    primaryKey: ['id'],
    uniqueKeys: [],
    foreignKeys: [],
  },
  {
    name: 'person',
    type: 'table',
    rowEstimate: 0,
    columns: [
      id,
      col('vorname', 'string'),
      col('nachname', 'string'),
      col('email', 'string', { nullable: false }),
      col('telefon', 'string'),
    ],
    primaryKey: ['id'],
    uniqueKeys: [['email'], ['telefon']],
    foreignKeys: [],
  },
  {
    name: 'anmeldung',
    type: 'table',
    rowEstimate: 0,
    columns: [id, col('startnummer', 'integer'), col('person_id', 'bigint')],
    primaryKey: ['id'],
    uniqueKeys: [],
    foreignKeys: [],
  },
]

function facts(
  overrides: Partial<Record<string, Partial<ObjectFacts>>> = {},
  lock: LockStrategy = { kind: 'timestamp', column: 'updated_at', setByServer: true },
): ConnectionFacts {
  const access = new Map<string, ObjectFacts>(
    objects.map((object) => [
      object.name,
      {
        tableAccessId: `${object.name}-id`,
        objectName: object.name,
        objectType: 'table',
        ceiling: toMask(['read', 'create', 'update']),
        dbGrants: toMask(['read', 'create', 'update']),
        excluded: new Set(object.name === 'zahlung' ? ['intern'] : []),
        mcpExcluded: new Set(),
        mcpEnabled: false,
        active: true,
        keyColumn: 'id',
        effectiveTemplate: object.name === 'anmeldung' ? '{startnummer}' : '{nachname}',
        writable: { create: null, update: null },
        lock: object.name === 'zahlung' ? lock : { kind: 'values' },
        ...overrides[object.name],
      },
    ]),
  )
  return {
    connectionId: 'c',
    engine: 'mariadb',
    database: 'wanderverein',
    timeZone: 'Europe/Berlin',
    catalog: new Map(objects.map((object) => [object.name, object])),
    relations: [
      {
        sourceObject: 'zahlung',
        sourceColumn: 'anmeldung_id',
        targetObject: 'anmeldung',
        targetColumn: 'id',
      },
      {
        sourceObject: 'anmeldung',
        sourceColumn: 'person_id',
        targetObject: 'person',
        targetColumn: 'id',
      },
    ],
    objects: access,
    access: (name) => access.get(name),
  }
}

const payment: FormField[] = fieldList.parse([
  { kind: 'generated', id: 'id', column: 'id', generator: { kind: 'auto_increment' } },
  {
    kind: 'input',
    id: 'anmeldung',
    column: 'anmeldung_id',
    reference: {
      target: 'anmeldung',
      extras: [{ path: [{ column: 'person_id', target: 'person' }], column: 'nachname' }],
    },
  },
  { kind: 'input', id: 'betrag', column: 'betrag' },
  {
    kind: 'generated',
    id: 'eingang',
    column: 'eingang_am',
    generator: { kind: 'date', expression: 'today', editable: true },
  },
  {
    kind: 'input',
    id: 'kommentar',
    column: 'kommentar',
    default: { kind: 'constant', value: 'bar' },
    hidden: true,
  },
])

function build(
  fields: FormField[],
  options: Partial<WriteInput> & { object?: string; connection?: ConnectionFacts } = {},
) {
  const issues: { path: string; code: string; severity: string; params?: unknown }[] = []
  const connection = options.connection ?? facts()
  const object = connection.objects.get(options.object ?? 'zahlung') as ObjectFacts
  const built = buildWriteModel(
    connection,
    object,
    {
      path: 'rows.0.blocks.0',
      fieldsPath: 'rows.0.blocks.0.fields',
      fields,
      mode: 'create',
      ops: { create: true, update: false },
      upsertKey: null,
      baseFilter: [],
      document: emptyPage('dashboard', 'Kasse'),
      ...options,
    },
    (path, code, params, warning) =>
      issues.push({
        path,
        code,
        severity: warning === true ? 'warning' : 'error',
        ...(params && { params }),
      }),
  )
  return { ...built, issues }
}

describe('write models (§11)', () => {
  it('derive the payload, server values and the record model of a payment form', () => {
    const { model, issues, withheld } = build(payment)
    expect(issues).toEqual([])
    expect(withheld).toBe(0)
    expect(model?.payload.create.map((spec) => [spec.column, spec.required])).toEqual([
      ['anmeldung_id', true],
      ['betrag', true],
      // An editable generated date may be left out; the server fills it.
      ['eingang_am', false],
    ])
    expect(model?.payload.update).toEqual([])
    expect(model?.fields.find((field) => field.column === 'kommentar')?.serverOnly).toBe(true)
    expect(model?.fields.find((field) => field.column === 'anmeldung_id')?.reference).toMatchObject(
      {
        target: 'anmeldung',
        targetColumn: 'id',
        searchColumns: ['label'],
        extras: [{ id: 'x0', label: 'person.nachname' }],
      },
    )
    expect(model?.row.columns.map((column) => column.id)).toEqual([
      'id',
      'anmeldung',
      'betrag',
      'eingang',
      'kommentar',
    ])
    expect(model?.lock).toEqual({ kind: 'timestamp', column: 'updated_at', setByServer: true })
  })

  it('reject fields that cannot be written and say which required column is missing', () => {
    const { model, issues } = build(
      fieldList.parse([
        { kind: 'input', id: 'a', column: 'intern' },
        { kind: 'input', id: 'b', column: 'summe' },
        { kind: 'input', id: 'c', column: 'id' },
        { kind: 'input', id: 'd', column: 'fehlt' },
        { kind: 'input', id: 'e', column: 'betrag', widget: 'switch' },
        {
          kind: 'generated',
          id: 'f',
          column: 'kommentar',
          generator: { kind: 'date', expression: 'now', editable: false },
        },
        {
          kind: 'input',
          id: 'g',
          column: 'updated_at',
          default: { kind: 'filter', filterId: 'gibts-nicht' },
        },
        {
          kind: 'input',
          id: 'h',
          column: 'anmeldung_id',
          default: { kind: 'constant', value: 'x' },
        },
      ]),
    )
    expect(model).toBeUndefined()
    expect(
      issues.map((issue) => `${issue.path.replace('rows.0.blocks.0.', '')} ${issue.code}`),
    ).toEqual([
      'fields.0.column excluded_column',
      'fields.1.column field_not_writable',
      'fields.2.column auto_increment',
      'fields.3.column unknown_column',
      'fields.4.widget widget_unsuitable',
      'fields.5.generator generator_unsuitable',
      'fields.6.default unknown_input',
      'fields.7.default invalid',
      'fields required_field_missing',
    ])
    expect(issues.at(-1)?.params).toEqual({ column: 'eingang_am' })
  })

  it('withhold operations whose columns the write user may not write (E6)', () => {
    const connection = facts({
      zahlung: {
        writable: {
          create: new Set(['anmeldung_id', 'betrag', 'eingang_am', 'kommentar']),
          update: new Set(['betrag']),
        },
      },
    })
    const fields = payment.filter((field) => field.column !== 'kommentar')
    const created = build(fields, { connection, ops: { create: true, update: true } })
    // The server sets updated_at on updates, which the write user may not.
    expect(created.issues).toEqual([
      {
        path: 'rows.0.blocks.0.source',
        code: 'grant_missing',
        severity: 'warning',
        params: { op: 'update', columns: 'anmeldung_id, eingang_am, updated_at' },
      },
    ])
    expect(created.withheld).toBe(toMask(['update']))
    expect(created.model).toBeDefined()
  })

  it('check upsert keys (E8) and keep the key out of updates', () => {
    const person = fieldList.parse([
      { kind: 'input', id: 'email', column: 'email' },
      { kind: 'input', id: 'nachname', column: 'nachname' },
    ])
    const upsert = (key: string[] | null) =>
      build(person, {
        object: 'person',
        mode: 'upsert',
        ops: { create: true, update: true },
        upsertKey: key,
      })
    expect(upsert(['EMAIL'])).toMatchObject({ issues: [], model: { upsertKey: ['email'] } })
    expect(upsert(['EMAIL']).model?.payload.update.map((spec) => spec.column)).toEqual([
      'email',
      'nachname',
    ])
    expect(upsert(['id']).issues.map((issue) => issue.code)).toEqual(['upsert_key_invalid'])
    // A unique key over a nullable column cannot find one row for sure.
    expect(upsert(['telefon']).issues.map((issue) => issue.code)).toEqual(['upsert_key_invalid'])
    expect(upsert(['nachname']).issues.map((issue) => issue.code)).toEqual(['upsert_key_invalid'])
    expect(upsert(null).issues.map((issue) => issue.code)).toEqual(['upsert_key_missing'])
    const edit = build(fieldList.parse([{ kind: 'input', id: 'id', column: 'id' }, ...person]), {
      object: 'person',
      mode: 'edit',
      ops: { create: false, update: true },
    })
    expect(edit.issues.map((issue) => issue.code)).toEqual(['auto_increment'])
  })

  it('need exactly one readable relation for a foreign key selection', () => {
    const hidden = facts({ anmeldung: { ceiling: toMask(['create']) } })
    const { issues } = build(payment, { connection: hidden })
    expect(issues.map((issue) => [issue.path.replace('rows.0.blocks.0.', ''), issue.code])).toEqual(
      [['fields.1.reference.target', 'object_not_readable']],
    )
    const plain = build(
      fieldList.parse([{ kind: 'input', id: 'k', column: 'kommentar', widget: 'reference' }]),
      { ops: { create: false, update: true }, mode: 'edit' },
    )
    expect(plain.issues.map((issue) => issue.code)).toEqual(['widget_unsuitable'])
  })

  it('fill new rows from equality conditions of the base filter on own columns (E9)', () => {
    const fields = payment.filter((field) => field.column !== 'anmeldung_id')
    const baseFilter = [
      {
        column: { path: [], column: 'anmeldung_id' },
        operator: 'eq' as const,
        value: { kind: 'variable' as const, name: 'current' },
      },
    ]
    // Without the condition the required column is missing; with it the server sets it.
    expect(build(fields).issues.map((issue) => issue.code)).toEqual(['required_field_missing'])
    const filled = build(fields, { baseFilter })
    expect(filled.issues).toEqual([])
    expect(filled.model?.filled).toEqual([{ column: 'anmeldung_id', index: 0 }])
    // A field for the same column may then be left out of the payload.
    const both = build(payment, { baseFilter })
    expect(both.model?.payload.create.find((spec) => spec.column === 'anmeldung_id')?.required).toBe(
      false,
    )
    // Conditions over linked tables or other operators fill nothing.
    const linked = build(fields, {
      baseFilter: [
        {
          column: { path: [{ column: 'anmeldung_id', target: 'anmeldung' }], column: 'person_id' },
          operator: 'eq' as const,
          value: { kind: 'constant' as const, value: 1 },
        },
        { ...(baseFilter[0] as (typeof baseFilter)[number]), operator: 'gte' as const },
      ],
    })
    expect(linked.issues.map((issue) => issue.code)).toEqual(['required_field_missing'])
    // A column grant missing on the filled column withholds create (E6).
    const narrowed = facts({
      zahlung: {
        writable: {
          create: new Set(['betrag', 'eingang_am', 'kommentar', 'updated_at']),
          update: null,
        },
      },
    })
    const withheld = build(fields, { baseFilter, connection: narrowed })
    expect(withheld.issues).toMatchObject([
      { code: 'grant_missing', severity: 'warning', params: { columns: 'anmeldung_id' } },
    ])
  })

  it('need a key the server can read back when the key is no auto-increment', () => {
    const uuid = facts()
    const catalog = uuid.catalog.get('person') as CatalogObject
    const keyed: CatalogObject = {
      ...catalog,
      columns: [
        col('id', 'string', { nullable: false, defaultValue: 'uuid()' }),
        ...catalog.columns.slice(1),
      ],
    }
    const connection = { ...uuid, catalog: new Map([...uuid.catalog, ['person', keyed]]) }
    const fields = fieldList.parse([{ kind: 'input', id: 'email', column: 'email' }])
    const { issues } = build(fields, { object: 'person', connection })
    expect(issues.map((issue) => [issue.code, issue.params])).toEqual([
      ['key_missing', { column: 'id' }],
    ])
    const withKey = build(
      fieldList.parse([...fields, { kind: 'input', id: 'id', column: 'id' }]),
      { object: 'person', connection },
    )
    expect(withKey.issues).toEqual([])
  })
})
