// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { AuditEvent, ImportJob, ImportMapping, TableAccess } from '@stashley/shared'
import iconv from 'iconv-lite'
import type mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from '../src/app.ts'
import type { TestClient } from '../src/test/client.ts'
import {
  connectDemo,
  prepareDatabase,
  rootConnection,
  seedDemo,
  startServer,
  targets,
} from './support.ts'

/**
 * CSV import against real servers (§17): detection, a dry run that only reads, upserts by a
 * unique key, foreign keys resolved by unique columns and display values, all or nothing,
 * skipping failed rows, and the audit event.
 */
describe.skipIf(targets.length === 0).each(targets)('CSV import on $name', ({ url }) => {
  let root: mysql.Connection
  let server: Server
  let admin: TestClient
  let access: Map<string, TableAccess>

  const table = (name: string) => access.get(name) as TableAccess

  async function upload(content: string | Buffer, name: string): Promise<ImportJob> {
    const response = await admin.upload(`/internal/imports?fileName=${name}`, content)
    expect(response.statusCode, response.body).toBe(201)
    return response.json<ImportJob>()
  }

  async function configure(
    job: ImportJob,
    mapping: Omit<ImportMapping, 'tableAccessId'> & { table: string },
  ) {
    const { table: name, ...rest } = mapping
    const response = await admin.send('PUT', `/internal/imports/${job.id}`, {
      options: job.options,
      mapping: { ...rest, tableAccessId: table(name).id },
    })
    expect(response.statusCode, response.body).toBe(200)
    return response.json<ImportJob>()
  }

  async function step(job: ImportJob, action: 'dry-run' | 'run'): Promise<ImportJob> {
    const started = await admin.send('POST', `/internal/imports/${job.id}/${action}`)
    expect(started.statusCode, started.body).toBe(200)
    await server.services.imports.settled()
    return (await admin.request('GET', `/internal/imports/${job.id}`)).json<ImportJob>()
  }

  const rows = async <T>(query: string, values: unknown[] = []) =>
    ((await root.query(query, values)) as unknown as [T[]])[0]

  beforeAll(async () => {
    root = await rootConnection(url)
    await prepareDatabase(root)
    await seedDemo(root)
    ;({ server, admin } = await startServer())
    ;({ access } = await connectDemo(admin, url))
  })

  afterAll(async () => {
    await server?.stop()
    await root?.end()
  })

  it('upserts people by e-mail from Windows-1252 with semicolons; the dry run reports faulty rows', async () => {
    const csv = iconv.encode(
      [
        'Vorname;Nachname;E-Mail;Land;Telefon',
        'Anna;Berg;anna@example.com;AT;',
        'Jürgen;Müller;juergen@example.com;DE;0171 2',
        'Zoë;Straße;zoe@example.com;DEU;',
        'Bernd;Doppelt;juergen@example.com;DE;',
        'Ben;Carstens;ben@example.com;DK;',
        'Anna;Zweite;anna2@example.com;DE;',
        '',
      ].join('\r\n'),
      'windows-1252',
    )
    let job = await upload(csv, 'personen.csv')
    expect(job.options).toMatchObject({ encoding: 'windows-1252', delimiter: ';', header: true })
    const columns = ['vorname', 'nachname', 'email', 'land', 'telefon'].map((target, source) => ({
      source,
      target,
    }))
    job = await configure(job, {
      table: 'person',
      mode: 'upsert',
      upsertKey: ['email'],
      columns,
      skipFailed: false,
    })
    job = await step(job, 'dry-run')
    expect(job.status).toBe('checked')
    expect(job.dryRun?.counts, JSON.stringify(job.dryRun?.errors)).toEqual({
      rows: 6,
      created: 2,
      updated: 1,
      unchanged: 1,
      failed: 2,
      skipped: 0,
    })
    expect(job.dryRun?.errors).toEqual([
      { line: 4, column: 'land', code: 'too_long', params: { max: 2 } },
      { line: 5, column: 'email', code: 'duplicate_in_file' },
    ])
    const list = await admin.request('GET', `/internal/imports/${job.id}/errors`)
    expect(list.headers['content-type']).toContain('text/csv')
    expect(list.body).toContain('4,land,too_long')
    // Nothing was written by the dry run.
    expect(await rows('SELECT land FROM person WHERE id = 1')).toEqual([{ land: 'DE' }])

    const refused = await admin.send('POST', `/internal/imports/${job.id}/run`)
    expect(refused.statusCode).toBe(422)

    // Skipping failed rows is a new setting and needs a new dry run.
    job = await configure(job, {
      table: 'person',
      mode: 'upsert',
      upsertKey: ['email'],
      columns,
      skipFailed: true,
    })
    expect(job.status).toBe('uploaded')
    expect((await admin.send('POST', `/internal/imports/${job.id}/run`)).statusCode).toBe(409)
    job = await step(job, 'dry-run')
    job = await step(job, 'run')
    expect(job.status, JSON.stringify(job.failure)).toBe('completed')
    expect(job.result).toMatchObject({ created: 2, updated: 1, unchanged: 1, skipped: 2 })
    expect(
      await rows('SELECT vorname, nachname FROM person WHERE email = ?', ['juergen@example.com']),
    ).toEqual([{ vorname: 'Jürgen', nachname: 'Müller' }])
    expect(await rows('SELECT land, telefon FROM person WHERE id = 1')).toEqual([
      { land: 'AT', telefon: null },
    ])
    expect(await rows("SELECT COUNT(*) AS n FROM person WHERE email = 'zoe@example.com'")).toEqual([
      { n: 0 },
    ])
    const audit = (
      await admin.request('GET', '/internal/admin/audit?action=import.completed')
    ).json<{ data: AuditEvent[] }>().data
    expect(audit[0]).toMatchObject({
      actorKind: 'user',
      subjectId: job.id,
      details: expect.objectContaining({
        fileSha256: job.sha256,
        mode: 'upsert',
        counts: expect.objectContaining({ created: 2, updated: 1, skipped: 2 }) as unknown,
      }) as unknown,
    })
  })

  it('resolves foreign keys by unique columns and display values', async () => {
    let job = await upload(
      [
        'E-Mail,Jahr,Art,Übergeben',
        'anna@example.com,2026,medaille_10,09.05.2026 15:00',
        'ben@example.com,2030,medaille_10,',
        'nobody@example.com,2026,MEDAILLE_10,',
      ].join('\n'),
      'ehrungen.csv',
    )
    expect(job.options).toMatchObject({ encoding: 'utf-8', delimiter: ',' })
    job = await configure(job, {
      table: 'ehrung',
      mode: 'insert',
      upsertKey: null,
      skipFailed: true,
      columns: [
        { source: 0, target: 'person_id', reference: { via: 'unique', column: 'email' } },
        { source: 1, target: 'event_id', reference: { via: 'unique', column: 'jahr' } },
        { source: 2, target: 'art' },
        { source: 3, target: 'uebergeben_am' },
      ],
    })
    job = await step(job, 'dry-run')
    expect(job.dryRun?.counts).toMatchObject({ rows: 3, created: 1, failed: 2 })
    expect(job.dryRun?.errors).toEqual([
      { line: 3, column: 'event_id', code: 'foreign_key_violation' },
      { line: 4, column: 'person_id', code: 'foreign_key_violation' },
    ])
    job = await step(job, 'run')
    expect(job.status).toBe('completed')
    expect(
      await rows(
        "SELECT person_id, event_id, art, DATE_FORMAT(uebergeben_am, '%Y-%m-%d %H:%i') AS am FROM ehrung",
      ),
      // 15:00 in APP_TIMEZONE (UTC here) is 17:00 in the connection's zone, Europe/Berlin (E25).
    ).toEqual([{ person_id: 1, event_id: 2, art: 'medaille_10', am: '2026-05-09 17:00' }])

    // Two people are called Anna now: the display value is ambiguous.
    let byName = await upload(
      'Person;Jahr;Art\nAnna;2026;medaille_10\nEva;2026;medaille_10\n',
      'namen.csv',
    )
    byName = await configure(byName, {
      table: 'ehrung',
      mode: 'insert',
      upsertKey: null,
      skipFailed: false,
      columns: [
        { source: 0, target: 'person_id', reference: { via: 'display' } },
        { source: 1, target: 'event_id', reference: { via: 'unique', column: 'jahr' } },
        { source: 2, target: 'art' },
      ],
    })
    byName = await step(byName, 'dry-run')
    expect(byName.dryRun?.errors).toEqual([
      { line: 2, column: 'person_id', code: 'ambiguous_reference' },
    ])
    expect(byName.dryRun?.counts).toMatchObject({ created: 1, failed: 1 })
  })

  it('writes all or nothing: a row the database refuses rolls the import back', async () => {
    let job = await upload(
      'vorname,nachname,email,land\nCarla,Neu,carla@example.com,IT\nDora,Neu,dora@example.com,IT\n',
      'neu.csv',
    )
    job = await configure(job, {
      table: 'person',
      mode: 'insert',
      upsertKey: null,
      skipFailed: false,
      columns: ['vorname', 'nachname', 'email', 'land'].map((target, source) => ({
        source,
        target,
      })),
    })
    job = await step(job, 'dry-run')
    expect(job.dryRun?.counts).toMatchObject({ created: 2, failed: 0 })
    // Between dry run and import someone else takes one of the e-mail addresses.
    await root.query(
      "INSERT INTO person (vorname, nachname, email, land) VALUES ('X', 'Y', 'dora@example.com', 'DE')",
    )
    job = await step(job, 'run')
    expect(job.status).toBe('failed')
    expect(job.failure).toMatchObject({
      code: 'import_stopped',
      errors: [expect.objectContaining({ code: 'unique_violation' }) as unknown],
    })
    expect(
      await rows("SELECT COUNT(*) AS n FROM person WHERE email = 'carla@example.com'"),
    ).toEqual([{ n: 0 }])
    const failed = (await admin.request('GET', '/internal/admin/audit?action=import.failed')).json<{
      data: AuditEvent[]
    }>().data
    expect(failed[0]?.subjectId).toBe(job.id)
  })
})
