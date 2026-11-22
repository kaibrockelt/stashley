// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ConfigFile,
  ConfigImportPlan,
  Connection,
  PageDetail,
  PageDocumentInput,
  Query,
  Role,
  TableAccess,
} from '@stashley/shared'
import type mysql from 'mysql2/promise'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from '../src/app.ts'
import { TestClient } from '../src/test/client.ts'
import {
  connectDemo,
  prepareDatabase,
  rootConnection,
  seedDemo,
  startServer,
  targets,
} from './support.ts'

/**
 * Configuration export and import (§24): what one instance builds runs on a second one after
 * its connection is mapped, and conflicts block the import.
 */
describe.skipIf(targets.length === 0).each(targets)(
  'configuration transfer on $name',
  ({ url }) => {
    let root: mysql.Connection
    const a = {} as {
      server: Server
      admin: TestClient
      connection: Connection
      access: Map<string, TableAccess>
    }
    const b = {} as typeof a
    let file: ConfigFile
    let pageId: string
    let roleId: string

    async function user(instance: typeof a, email: string, roleIds: string[]): Promise<TestClient> {
      const invited = await instance.admin.send('POST', '/internal/admin/users', {
        email,
        displayName: email,
        systemRole: 'user',
      })
      const { user: account, link } = invited.json<{ user: { id: string }; link: string }>()
      const client = new TestClient(instance.server.app)
      await client.send('POST', '/internal/invitations/accept', {
        token: link.split('#').at(-1),
        password: `${email} long passphrase`,
      })
      await instance.admin.send('PUT', `/internal/admin/users/${account.id}/roles`, { roleIds })
      return client
    }

    const guests = (hotelbuchung: string, role: string): PageDocumentInput => ({
      schemaVersion: 1,
      kind: 'table',
      title: 'Gäste Lindenhof',
      filters: [],
      parameters: [],
      rows: [],
      table: {
        id: 'gaeste',
        type: 'table',
        title: 'Gäste',
        restrictions: [],
        source: { kind: 'table', tableAccessId: hotelbuchung, cacheTtlSeconds: 0 },
        bindings: [],
        table: {
          columns: [
            { kind: 'column', id: 'anreise', column: { path: [], column: 'anreise' } },
            {
              kind: 'display',
              id: 'gast',
              path: [{ column: 'anmeldung_id', target: 'anmeldung' }],
            },
          ],
          sort: { columnId: 'anreise', direction: 'asc' },
          searchColumns: [],
          baseFilter: [
            {
              column: {
                path: [{ column: 'hotel_kontingent_id', target: 'hotel_kontingent' }],
                column: 'hotel_id',
              },
              operator: 'eq',
              value: { kind: 'constant', value: 1 },
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
          bindings: [],
          pageSize: 50,
        },
      },
      access: {
        view: [role],
        grants: [{ principal: role, source: `table:${hotelbuchung}`, ops: ['read'] }],
      },
      mcp: { available: false },
    })

    const readGuests = async (client: TestClient) => {
      const response = await client.send(
        'POST',
        `/internal/pages/${pageId}/components/gaeste/query`,
        {},
      )
      expect(response.statusCode, JSON.stringify(response.json())).toBe(200)
      return response.json<{ rows: unknown[] }>().rows
    }

    const preview = (instance: typeof a, body: unknown, connections: Record<string, string>) =>
      instance.admin.send('POST', '/internal/admin/config/import/preview', {
        file: body,
        connections,
      })

    beforeAll(async () => {
      root = await rootConnection(url)
      await prepareDatabase(root)
      await seedDemo(root)
      for (const instance of [a, b]) {
        Object.assign(instance, await startServer())
        Object.assign(instance, await connectDemo(instance.admin, url))
      }

      // Instance A: what a manager builds.
      const anmeldung = a.access.get('anmeldung') as TableAccess
      await a.admin.send('PUT', `/internal/admin/table-access/${anmeldung.id}`, {
        ops: anmeldung.ops,
        keyColumn: 'id',
        displayTemplate: '{startnummer} – {person.nachname}',
        apiResource: anmeldung.apiResource,
        mcpEnabled: false,
        exclusions: [],
      })
      const relation = await a.admin.send('POST', '/internal/admin/relations', {
        connectionId: a.connection.id,
        sourceObject: 'anmeldung',
        sourceColumn: 'id',
        targetObject: 'v_zahlungsstatus',
        targetColumn: 'anmeldung_id',
        kind: 'one_to_one',
      })
      expect(relation.statusCode, JSON.stringify(relation.json())).toBe(201)
      await a.admin.send('POST', '/internal/design/variables', {
        name: 'current_event_id',
        type: 'integer',
        value: 2,
        description: 'Laufendes Event',
      })
      const role = (
        await a.admin.send('POST', '/internal/design/roles', {
          name: 'Lindenhof',
          description: 'Rezeption',
          homePageId: null,
        })
      ).json<Role>()
      roleId = role.id
      const query = await a.admin.send('POST', '/internal/design/queries', {
        connectionId: a.connection.id,
        name: 'Offene Posten',
        description: '',
        sql: 'SELECT anmeldung_id, offen FROM v_zahlungsstatus WHERE event_id = :current_event_id',
        parameters: [],
        cacheTtlSeconds: 60,
      })
      expect(query.statusCode).toBe(201)
      // A second version, so the latest differs from version 1.
      await a.admin.send('PATCH', `/internal/design/queries/${query.json<Query>().id}`, {
        sql: 'SELECT anmeldung_id, offen FROM v_zahlungsstatus WHERE event_id = :current_event_id AND offen > 0',
      })
      const section = await a.admin.send('POST', '/internal/design/sections', { name: 'Hotels' })
      const created = (
        await a.admin.send('POST', '/internal/design/pages', {
          sectionId: section.json<{ id: string }>().id,
          kind: 'table',
          slug: 'gaeste-lindenhof',
          title: 'Gäste Lindenhof',
        })
      ).json<PageDetail>()
      pageId = created.id
      const saved = await a.admin.request(
        'PUT',
        `/internal/design/pages/${pageId}/draft`,
        guests((a.access.get('hotelbuchung') as TableAccess).id, role.id),
        { 'if-match': `"${created.draftRevision}"` },
      )
      expect(saved.statusCode, JSON.stringify(saved.json())).toBe(200)
      expect(
        (await a.admin.send('POST', `/internal/design/pages/${pageId}/publish`)).statusCode,
      ).toBe(200)
      await a.admin.send('PATCH', `/internal/design/roles/${role.id}`, { homePageId: pageId })
    })

    afterAll(async () => {
      await a.server.stop()
      await b.server.stop()
      await root.end()
    })

    it('exports without credentials, accounts or ceilings', async () => {
      const response = await a.admin.request('GET', '/internal/admin/config/export')
      expect(response.statusCode).toBe(200)
      file = response.json<ConfigFile>()
      const text = JSON.stringify(file)
      expect(text).not.toContain('demo-read-password')
      expect(text).not.toContain('stashley_read')
      expect(text).not.toContain('admin@example.com')
      expect(file.connections).toEqual([{ ref: 'Wanderverein' }])
      expect(file.tables).toEqual([
        expect.objectContaining({ connectionRef: 'Wanderverein', object: 'hotelbuchung' }),
      ])
      expect(file.roles).toEqual([
        { id: roleId, name: 'Lindenhof', description: 'Rezeption', homePageId: pageId },
      ])
      expect(file.variables).toEqual([
        { name: 'current_event_id', type: 'integer', value: 2, description: 'Laufendes Event' },
      ])
      expect(file.displayTemplates).toEqual([
        {
          connectionRef: 'Wanderverein',
          object: 'anmeldung',
          template: '{startnummer} – {person.nachname}',
        },
      ])
      expect(file.relations).toHaveLength(1)
      expect(file.queries[0]?.versions.map((version) => version.version)).toEqual([2])
      expect(file.pages[0]?.published).not.toBeNull()
    })

    it('refuses the import while a connection is not mapped', async () => {
      const response = await preview(b, file, {})
      expect(response.statusCode).toBe(200)
      const plan = response.json<ConfigImportPlan>()
      expect(plan.counts.conflict).toBeGreaterThan(0)
      expect(plan.items.find((item) => item.kind === 'query')?.conflicts).toEqual([
        { code: 'connection_unmapped', detail: 'Wanderverein' },
      ])
      const applied = await b.admin.send('POST', '/internal/admin/config/import', {
        file,
        connections: {},
        fingerprint: plan.fingerprint,
      })
      expect(applied.statusCode).toBe(409)
    })

    it('imports into a second instance, where the page works unchanged', async () => {
      const connections = { Wanderverein: b.connection.id }
      const plan = (await preview(b, file, connections)).json<ConfigImportPlan>()
      expect(plan.counts).toEqual({ new: 6, changed: 1, unchanged: 0, conflict: 0 })
      expect(plan.items.find((item) => item.kind === 'display_template')?.status).toBe('changed')

      const stale = await b.admin.send('POST', '/internal/admin/config/import', {
        file,
        connections,
        fingerprint: '0'.repeat(64),
      })
      expect(stale.statusCode).toBe(409)
      const applied = await b.admin.send('POST', '/internal/admin/config/import', {
        file,
        connections,
        fingerprint: plan.fingerprint,
      })
      expect(applied.statusCode, JSON.stringify(applied.json())).toBe(200)

      const detail = (
        await b.admin.request('GET', `/internal/design/pages/${pageId}`)
      ).json<PageDetail>()
      expect(detail.publishedVersion).toBe(1)
      const hotelbuchung = (b.access.get('hotelbuchung') as TableAccess).id
      expect(JSON.stringify(detail.draft)).toContain(hotelbuchung)

      const onA = await user(a, 'lindenhof-a@example.com', [roleId])
      const onB = await user(b, 'lindenhof-b@example.com', [roleId])
      expect(await readGuests(onB)).toEqual(await readGuests(onA))
      expect((await readGuests(onB)).length).toBeGreaterThan(0)

      const again = (await preview(b, file, connections)).json<ConfigImportPlan>()
      expect(again.counts).toEqual({ new: 0, changed: 0, unchanged: 7, conflict: 0 })
      const audit = await b.admin.request('GET', '/internal/admin/audit?action=config.imported')
      expect(JSON.stringify(audit.json())).toContain('config.imported')
    })

    it('reports conflicts instead of overwriting', async () => {
      const connections = { Wanderverein: b.connection.id }
      const changed = structuredClone(file)
      const role = changed.roles[0] as ConfigFile['roles'][number]
      role.id = uuidv7()
      const table = changed.tables[0] as ConfigFile['tables'][number]
      table.object = 'gibt_es_nicht'
      const query = changed.queries[0] as ConfigFile['queries'][number]
      ;(query.versions[0] as { sql: string }).sql = 'SELECT 1 AS eins'
      const plan = (await preview(b, changed, connections)).json<ConfigImportPlan>()
      const conflicts = (kind: string) =>
        plan.items.filter((item) => item.kind === kind).flatMap((item) => item.conflicts)
      expect(conflicts('role')).toEqual([{ code: 'name_taken', detail: 'Lindenhof' }])
      expect(conflicts('page')).toEqual([
        { code: 'table_access_missing', detail: 'Wanderverein/gibt_es_nicht' },
      ])
      expect(conflicts('query')).toEqual([{ code: 'version_differs', detail: '2' }])
    })
  },
)
