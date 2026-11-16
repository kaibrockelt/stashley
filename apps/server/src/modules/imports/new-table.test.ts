// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ImportJob, NewTableColumn, NewTableDefinition } from '@stashley/shared'
import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import { setupDemo } from '../../test/demo.ts'
import { createUser, problem, setupServer } from '../../test/setup.ts'

const csv = iconv.encode(
  [
    'Vorname;PLZ;Geburtstag;Beitrag;Mitglied;E-Mail',
    'Jürgen;01067;31.01.1980;12,50;ja;juergen@example.com',
    'Zoë;80331;01.02.1990;7;nein;zoe@example.com',
    'Ali;10115;29.02.2001;8,00;ja;ali@example.com',
    '',
  ].join('\r\n'),
  'windows-1252',
)

async function setup(schemaUser = true) {
  const s = await setupServer()
  const demo = await setupDemo(s, { schemaUser })
  const uploaded = await s.admin.upload('/internal/imports?fileName=Mitglieder 2026.csv', csv)
  expect(uploaded.statusCode, uploaded.body).toBe(201)
  return { s, demo, job: uploaded.json<ImportJob>() }
}

describe('new tables from CSV (E28)', () => {
  it('suggest names and types from every value of the file', async () => {
    const { s, demo, job } = await setup()
    const response = await s.admin.request(
      'GET',
      `/internal/imports/${job.id}/new-table?connectionId=${demo.connectionId}`,
    )
    expect(response.statusCode, response.body).toBe(200)
    const definition = response.json<NewTableDefinition>()
    expect(definition.name).toBe('mitglieder_2026')
    expect(definition.primaryKey).toEqual({ kind: 'added', name: 'id' })
    expect(
      definition.columns.map((column) => [
        column.name,
        column.type,
        column.length ?? column.precision,
      ]),
    ).toEqual([
      ['vorname', 'varchar', 32],
      // Leading zeros keep postal codes as text.
      ['plz', 'varchar', 32],
      // 29.02.2001 is not a date, so the column stays text.
      ['geburtstag', 'varchar', 32],
      ['beitrag', 'decimal', 4],
      ['mitglied', 'boolean', undefined],
      ['e_mail', 'varchar', 32],
    ])
    expect(definition.columns.every((column) => !column.required && !column.unique)).toBe(true)
  })

  it('need an admin and a schema user', async () => {
    const { s, demo, job } = await setup(false)
    const url = `/internal/imports/${job.id}/new-table?connectionId=${demo.connectionId}`
    const missing = await s.admin.request('GET', url)
    expect(missing.statusCode).toBe(422)
    expect(problem(missing).errors).toEqual([{ field: 'connectionId', code: 'no_schema_user' }])
    const { client } = await createUser(s, 'manager@example.com', 'manager')
    expect((await client.request('GET', `/internal/imports/x/new-table`)).statusCode).toBe(422)
    const designer = await client.send('POST', '/internal/admin/tables', {})
    expect(designer.statusCode).toBe(403)
  })

  it('check the definition before saving it, and run the dry run without the database', async () => {
    const { s, demo, job } = await setup()
    const suggested = (
      await s.admin.request(
        'GET',
        `/internal/imports/${job.id}/new-table?connectionId=${demo.connectionId}`,
      )
    ).json<NewTableDefinition>()
    const save = (definition: NewTableDefinition, skipFailed = false) =>
      s.admin.send('PUT', `/internal/imports/${job.id}`, {
        options: job.options,
        mapping: null,
        newTable: { definition, skipFailed },
      })
    const taken = await save({ ...suggested, name: 'person' })
    expect(problem(taken).errors).toEqual([{ field: 'newTable.definition.name', code: 'taken' }])
    const required = await save({
      ...suggested,
      columns: [
        ...suggested.columns,
        {
          name: 'pflicht',
          source: null,
          type: 'int',
          required: true,
          unique: false,
          default: null,
        },
      ],
    })
    expect(problem(required).errors).toEqual([
      { field: 'newTable.definition.columns.6.source', code: 'required' },
    ])

    // Birthdays as dates: one value is not a date, which the dry run reports.
    const typed: NewTableDefinition = {
      ...suggested,
      primaryKey: { kind: 'column', column: 'e_mail' },
      columns: suggested.columns.map((column): NewTableColumn => {
        if (column.name === 'e_mail') return { ...column, length: 254 }
        if (column.name !== 'geburtstag') return column
        const { name, source, required, unique } = column
        return { name, source, required, unique, default: null, type: 'date' }
      }),
    }
    const saved = await save(typed)
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json<ImportJob>().newTable).toMatchObject({ createdAt: null, skipFailed: false })
    const started = await s.admin.send('POST', `/internal/imports/${job.id}/dry-run`)
    expect(started.statusCode, started.body).toBe(200)
    await s.server.services.imports.settled()
    const checked = (await s.admin.request('GET', `/internal/imports/${job.id}`)).json<ImportJob>()
    expect(checked.status).toBe('checked')
    expect(checked.dryRun?.counts, JSON.stringify(checked.dryRun?.errors)).toMatchObject({
      rows: 3,
      created: 2,
      failed: 1,
    })
    expect(checked.dryRun?.errors).toEqual([{ line: 4, column: 'geburtstag', code: 'invalid' }])
    // Without skipping, the import is refused before anything is created.
    expect((await s.admin.send('POST', `/internal/imports/${job.id}/run`)).statusCode).toBe(422)
  })
})
