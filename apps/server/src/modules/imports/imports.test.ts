// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ImportJob, ImportPreview, ImportTarget, TableAccess } from '@stashley/shared'
import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import { setupDemo } from '../../test/demo.ts'
import { tempDir } from '../../test/helpers.ts'
import { createUser, problem, setupServer } from '../../test/setup.ts'
import type { TestClient } from '../../test/client.ts'
import { detectDelimiter, detectEncoding, detectHeader, firstRecords } from './files.ts'

function file(content: string | Buffer): string {
  const target = path.join(tempDir(), 'upload.csv')
  writeFileSync(target, content)
  return target
}

const germanCsv = iconv.encode(
  'Vorname;Nachname;E-Mail;Land;Geburtstag;Betrag\r\n' +
    'Jürgen;Müller;juergen@example.com;DE;31.01.1980;1.234,50\r\n' +
    'Zoë;Straße;zoe@example.com;AT;01.02.1990;12,00\r\n',
  'windows-1252',
)

describe('CSV files', () => {
  it('detect the encoding: BOM, strict UTF-8, otherwise Windows-1252', async () => {
    expect(await detectEncoding(file(Buffer.from('﻿a;b\n1;2\n')))).toBe('utf-8')
    expect(await detectEncoding(file('name\nJürgen\n'))).toBe('utf-8')
    expect(await detectEncoding(file(germanCsv))).toBe('windows-1252')
  })

  it('detect the delimiter outside quotes and the header row', () => {
    expect(detectDelimiter('a;b;c\n1;2;3\n4;5;6\n')).toBe(';')
    expect(detectDelimiter('a,b\n"1;2",3\n"4;5",6\n')).toBe(',')
    expect(detectDelimiter('a\tb\n1\t2\n')).toBe('\t')
    expect(detectDelimiter('"x, y";z\n"1, 2";3\n')).toBe(';')
    expect(
      detectHeader([
        ['Name', 'E-Mail'],
        ['Anna', 'a@example.com'],
      ]),
    ).toBe(true)
    expect(
      detectHeader([
        ['Anna', '31.01.1980'],
        ['Ben', '01.02.1990'],
      ]),
    ).toBe(false)
    expect(detectHeader([['1', '2']])).toBe(false)
    expect(detectHeader([['a', 'a']])).toBe(false)
  })

  it('read quoted fields, line breaks and line numbers', async () => {
    const records = await firstRecords(
      file('Name;Notiz\r\nAnna;"Zeile 1\r\nZeile 2"\r\n\r\nBen;"Er sagt ""Hallo"""\r\n'),
      { encoding: 'utf-8', delimiter: ';' },
      10,
    )
    expect(records).toEqual([
      { line: 1, cells: ['Name', 'Notiz'] },
      { line: 2, cells: ['Anna', 'Zeile 1\r\nZeile 2'] },
      { line: 5, cells: ['Ben', 'Er sagt "Hallo"'] },
    ])
  })
})

function upload(client: TestClient, content: string | Buffer, name = 'personen.csv') {
  return client.upload(`/internal/imports?fileName=${encodeURIComponent(name)}`, content)
}

async function setup(env: Record<string, string> = {}) {
  const s = await setupServer({}, env)
  const demo = await setupDemo(s)
  return { s, demo, person: demo.access.get('person') as TableAccess }
}

describe('CSV import routes', () => {
  it('store an upload and suggest options from data and the user format', async () => {
    const { s } = await setup()
    const response = await upload(s.admin, germanCsv)
    expect(response.statusCode, response.body).toBe(201)
    const job = response.json<ImportJob>()
    expect(job).toMatchObject({
      fileName: 'personen.csv',
      status: 'uploaded',
      options: {
        encoding: 'windows-1252',
        delimiter: ';',
        header: true,
        decimalSeparator: ',',
        thousandsSeparator: '.',
        dateFormat: 'DD.MM.YYYY',
      },
    })
    expect(job.sha256).toMatch(/^[0-9a-f]{64}$/)
    const preview = (
      await s.admin.request('GET', `/internal/imports/${job.id}/preview`)
    ).json<ImportPreview>()
    expect(preview.columns).toEqual([
      'Vorname',
      'Nachname',
      'E-Mail',
      'Land',
      'Geburtstag',
      'Betrag',
    ])
    expect(preview.rows[0]).toEqual([
      'Jürgen',
      'Müller',
      'juergen@example.com',
      'DE',
      '31.01.1980',
      '1.234,50',
    ])
  })

  it('refuse other content types, empty and oversized files, and plain users', async () => {
    const { s } = await setup({ STASHLEY_IMPORT_MAX_MB: '1' })
    const json = await s.admin.send('POST', '/internal/imports?fileName=a.csv', { a: 1 })
    expect(json.statusCode).toBe(415)
    expect((await upload(s.admin, '')).statusCode).toBe(422)
    const large = await upload(s.admin, 'a\n' + 'x'.repeat(1024 * 1024 + 10))
    expect(large.statusCode).toBe(413)
    const { client } = await createUser(s, 'user@example.com', 'user')
    expect((await upload(client, 'a\n1\n')).statusCode).toBe(403)
  })

  it('show jobs only to their owner and admins', async () => {
    const { s } = await setup()
    const first = await createUser(s, 'm1@example.com', 'manager')
    const second = await createUser(s, 'm2@example.com', 'manager')
    const job = (await upload(first.client, 'a\n1\n')).json<ImportJob>()
    expect((await second.client.request('GET', `/internal/imports/${job.id}`)).statusCode).toBe(404)
    expect((await s.admin.request('GET', `/internal/imports/${job.id}`)).statusCode).toBe(200)
    const list = (await second.client.request('GET', '/internal/imports')).json<{
      data: ImportJob[]
    }>()
    expect(list.data).toEqual([])
  })

  it('list tables within the ceiling and suggest a mapping by name', async () => {
    const { s, person } = await setup()
    const targets = (await s.admin.request('GET', '/internal/imports/targets')).json<{
      data: ImportTarget[]
    }>().data
    const names = targets.map((target) => target.objectName)
    expect(names).toContain('person')
    // `ehrung` may only create, views never import.
    expect(targets.find((target) => target.objectName === 'ehrung')?.modes).toEqual(['insert'])
    expect(names).not.toContain('v_zahlungsstatus')

    const job = (await upload(s.admin, germanCsv)).json<ImportJob>()
    const target = (
      await s.admin.request('GET', `/internal/imports/${job.id}/targets/${person.id}`)
    ).json<ImportTarget & { suggestedMapping: unknown[] }>()
    expect(target.modes).toEqual(['insert', 'upsert'])
    expect(target.suggestedMapping).toEqual([
      { source: 0, target: 'vorname' },
      { source: 1, target: 'nachname' },
      { source: 2, target: 'email' },
      { source: 3, target: 'land' },
    ])
  })

  it('upsert only into tables the importer may also read', async () => {
    const { s, person } = await setup()
    const changed = await s.admin.send('PUT', `/internal/admin/table-access/${person.id}`, {
      ops: ['create', 'update'],
      keyColumn: person.keyColumn,
      displayTemplate: person.displayTemplate,
      apiResource: person.apiResource,
      mcpEnabled: false,
      exclusions: person.exclusions,
    })
    expect(changed.statusCode, changed.body).toBe(200)
    const job = (await upload(s.admin, germanCsv)).json<ImportJob>()
    const target = (
      await s.admin.request('GET', `/internal/imports/${job.id}/targets/${person.id}`)
    ).json<ImportTarget>()
    // A dry run would compare stored values: without read, inserting is all that is left.
    expect(target.modes).toEqual(['insert'])
    const refused = await s.admin.send('PUT', `/internal/imports/${job.id}`, {
      options: job.options,
      mapping: {
        tableAccessId: person.id,
        mode: 'upsert',
        upsertKey: ['id'],
        skipFailed: false,
        columns: [{ source: 2, target: 'email' }],
      },
    })
    expect(refused.statusCode).toBe(403)
    expect(problem(refused).errors).toEqual([{ field: 'mode', code: 'not_allowed' }])
  })

  it('check a mapping against the table before saving it', async () => {
    const { s, person, demo } = await setup()
    const job = (await upload(s.admin, germanCsv)).json<ImportJob>()
    const save = (mapping: unknown) =>
      s.admin.send('PUT', `/internal/imports/${job.id}`, { options: job.options, mapping })
    const base = { tableAccessId: person.id, mode: 'insert', upsertKey: null, skipFailed: false }
    const bad = await save({
      ...base,
      columns: [
        { source: 0, target: 'id' },
        { source: 1, target: 'nichts' },
        { source: 9, target: 'vorname' },
      ],
    })
    expect(bad.statusCode).toBe(422)
    expect(problem(bad).errors).toEqual([
      { field: 'mapping.columns.0.target', code: 'field_not_writable' },
      { field: 'mapping.columns.1.target', code: 'unknown_field' },
      { field: 'mapping.columns.2.source', code: 'invalid' },
    ])
    const upsert = await save({
      ...base,
      mode: 'upsert',
      upsertKey: ['id'],
      columns: [{ source: 2, target: 'email' }],
    })
    expect(problem(upsert).errors).toEqual([
      { field: 'mapping.upsertKey', code: 'upsert_key_invalid' },
    ])
    const hotel = demo.access.get('hotel') as TableAccess
    const excluded = await save({
      ...base,
      tableAccessId: hotel.id,
      columns: [{ source: 2, target: 'kontakt_email' }],
    })
    expect(problem(excluded).errors).toEqual([
      { field: 'mapping.columns.0.target', code: 'unknown_field' },
    ])
    const good = await save({
      ...base,
      columns: [
        { source: 0, target: 'vorname' },
        { source: 2, target: 'email' },
      ],
    })
    expect(good.statusCode, good.body).toBe(200)
    expect(good.json<ImportJob>().mapping?.columns).toHaveLength(2)
    // No import without a passed dry run (E23).
    expect((await s.admin.send('POST', `/internal/imports/${job.id}/run`)).statusCode).toBe(409)
  })

  it('remove expired uploads', async () => {
    const { s } = await setup()
    const job = (await upload(s.admin, 'a\n1\n')).json<ImportJob>()
    await s.server.store.db.updateTable('import_jobs').set({ expires_at: 0 }).execute()
    expect(await s.server.services.imports.cleanup()).toBe(1)
    expect((await s.admin.request('GET', `/internal/imports/${job.id}`)).statusCode).toBe(404)
  })
})
