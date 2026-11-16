// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { fieldList, serverDefault } from './form.ts'
import { componentsOf, emptyPage, pageDocument, type PageDocumentInput } from './page.ts'

const tableAccessId = '0196f3a4-3333-7000-8000-000000000001'
const source = { kind: 'table', tableAccessId, cacheTtlSeconds: 0 } as const

describe('form fields', () => {
  it('reads input and generated fields with their defaults', () => {
    expect(
      fieldList.parse([
        { kind: 'input', id: 'betrag', column: 'betrag' },
        {
          kind: 'input',
          id: 'event',
          column: 'event_id',
          default: { kind: 'variable', name: 'current_event_id' },
          hidden: true,
        },
        {
          kind: 'input',
          id: 'anmeldung',
          column: 'anmeldung_id',
          widget: 'reference',
          reference: { target: 'anmeldung' },
        },
        {
          kind: 'generated',
          id: 'eingang',
          column: 'eingang_am',
          generator: { kind: 'date', expression: 'today', editable: true },
        },
        { kind: 'generated', id: 'id', column: 'id', generator: { kind: 'auto_increment' } },
      ]),
    ).toEqual([
      { kind: 'input', id: 'betrag', column: 'betrag', required: false, hidden: false },
      {
        kind: 'input',
        id: 'event',
        column: 'event_id',
        default: { kind: 'variable', name: 'current_event_id' },
        hidden: true,
        required: false,
      },
      {
        kind: 'input',
        id: 'anmeldung',
        column: 'anmeldung_id',
        widget: 'reference',
        reference: { target: 'anmeldung', searchColumns: [], extras: [], baseFilter: [] },
        required: false,
        hidden: false,
      },
      {
        kind: 'generated',
        id: 'eingang',
        column: 'eingang_am',
        generator: { kind: 'date', expression: 'today', editable: true },
      },
      { kind: 'generated', id: 'id', column: 'id', generator: { kind: 'auto_increment' } },
    ])
  })

  it('rejects duplicates, hidden fields without default and bad expressions', () => {
    const result = fieldList.safeParse([
      { kind: 'input', id: 'a', column: 'betrag' },
      { kind: 'input', id: 'a', column: 'BETRAG' },
      { kind: 'input', id: 'b', column: 'kommentar', hidden: true },
      {
        kind: 'generated',
        id: 'c',
        column: 'eingang_am',
        generator: { kind: 'date', expression: 'tomorrow', editable: false },
      },
      { kind: 'input', id: 'd', column: 'x', unknown: true },
    ])
    expect(result.success).toBe(false)
    expect(
      result.error?.issues.map((issue) => `${issue.path.join('.')}:${issue.message}`).sort(),
    ).toEqual(
      [
        '1.column:duplicate',
        '1.id:duplicate',
        '2.default:required',
        '3.generator.expression:invalid_expression',
        expect.stringMatching(/^4:/),
      ].sort(),
    )
  })

  it('knows which defaults the server sets itself (E10)', () => {
    expect(serverDefault({ kind: 'constant', value: 1 })).toBe(true)
    expect(serverDefault({ kind: 'variable', name: 'current_event_id' })).toBe(true)
    expect(serverDefault({ kind: 'user', field: 'id' })).toBe(true)
    expect(serverDefault({ kind: 'filter', filterId: 'station' })).toBe(false)
    expect(serverDefault({ kind: 'url', name: 'record' })).toBe(false)
  })
})

describe('page documents with forms and table editing', () => {
  it('fill the settings M6 added into documents saved before', () => {
    const before: PageDocumentInput = {
      ...emptyPage('dashboard', 'Ehrung'),
      rows: [
        {
          id: 'r1',
          layout: '12',
          blocks: [
            { id: 'f', type: 'form', title: 'Ehrung', restrictions: [], source, mode: 'create' },
          ],
        },
      ],
    }
    // Saved before M6: no detail view either.
    const old: Record<string, unknown> = { ...before }
    delete old.detail
    const parsed = pageDocument.parse(old)
    expect(parsed.detail).toBeNull()
    expect(parsed.rows[0]?.blocks[0]).toMatchObject({
      fields: [],
      record: null,
      upsertKey: null,
      baseFilter: [],
      afterSave: { action: 'clear' },
    })
  })

  it('list detail tables as components of table pages only', () => {
    const table = {
      id: 'anmeldungen',
      type: 'table' as const,
      title: 'Anmeldungen',
      restrictions: [],
      source,
      bindings: [],
      table: {
        columns: [
          { kind: 'column' as const, id: 'nr', column: { path: [], column: 'startnummer' } },
        ],
        sort: null,
        searchColumns: [],
        baseFilter: [],
        bindings: [],
        pageSize: 50,
      },
    }
    const document = pageDocument.parse({
      ...emptyPage('table', 'Anmeldungen'),
      table,
      detail: {
        tables: [
          { ...table, id: 'zahlungen', title: 'Zahlungen', link: { column: 'anmeldung_id' } },
        ],
      },
    })
    expect(componentsOf(document).map((entry) => [entry.component.id, entry.path])).toEqual([
      ['anmeldungen', 'table'],
      ['zahlungen', 'detail.tables.0'],
    ])
    expect(document.table?.table).toMatchObject({ editing: null, csvExport: true })
    expect(
      pageDocument.safeParse({
        ...emptyPage('dashboard', 'Kasse'),
        detail: { tables: [] },
      }).success,
    ).toBe(false)
  })
})
