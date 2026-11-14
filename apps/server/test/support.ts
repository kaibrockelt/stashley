// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Connection, TableAccess, TableOp } from '@stashley/shared'
import mysql from 'mysql2/promise'
import { expect } from 'vitest'
import { createServer, type Server } from '../src/app.ts'
import { TestClient } from '../src/test/client.ts'
import { testConfig } from '../src/test/helpers.ts'

/** Shared setup of the target database tests (architecture §26). */

export const targets = (process.env.STASHLEY_TEST_TARGETS ?? '')
  .split(',')
  .filter((entry) => entry.trim() !== '')
  .map((entry) => {
    const [name = '', url = ''] = entry.split('=')
    return { name, url: new URL(url) }
  })
export const allowLoopback = process.env.STASHLEY_TEST_ALLOW_LOOPBACK === '1'
const fixtures = path.join(import.meta.dirname, 'fixtures', 'wanderverein')
export const adminEmail = 'admin@example.com'
export const adminPassword = 'correct horse battery staple'

export async function rootConnection(url: URL): Promise<mysql.Connection> {
  const deadline = Date.now() + 90_000
  for (;;) {
    try {
      return await mysql.createConnection({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        multipleStatements: true,
      })
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
}

/** Creates the demo schema and its database users from scratch. */
export async function prepareDatabase(root: mysql.Connection): Promise<void> {
  await root.query('DROP DATABASE IF EXISTS wanderverein')
  await root.query('CREATE DATABASE wanderverein CHARACTER SET utf8mb4')
  await root.query('USE wanderverein')
  await root.query(readFileSync(path.join(fixtures, 'schema.sql'), 'utf8'))
  await root.query(readFileSync(path.join(fixtures, 'users.sql'), 'utf8'))
}

export async function startServer(): Promise<{ server: Server; admin: TestClient }> {
  const server = await createServer(
    testConfig({ INITIAL_ADMIN_EMAIL: adminEmail, INITIAL_ADMIN_PASSWORD: adminPassword }),
    {
      quiet: true,
      listen: false,
      ...(allowLoopback && {
        overrides: { resolveTargetHost: (name: string) => Promise.resolve(name) },
      }),
    },
  )
  await server.start()
  const admin = new TestClient(server.app)
  expect((await admin.login(adminEmail, adminPassword)).statusCode).toBe(200)
  return { server, admin }
}

export function connectionInput(url: URL, overrides: Record<string, unknown> = {}) {
  return {
    name: 'Wanderverein',
    host: url.hostname,
    port: Number(url.port || 3306),
    databaseName: 'wanderverein',
    tls: { mode: 'disabled', caPem: null, serverName: null },
    timezone: 'Europe/Berlin',
    queryTimeoutSeconds: 30,
    credentials: {
      read: { username: 'stashley_read', password: 'demo-read-password' },
      write: { username: 'stashley_write', password: 'demo-write-password' },
      schema: null,
    },
    ...overrides,
  }
}

export const demoCeilings: Record<string, TableOp[]> = {
  person: ['read', 'create', 'update'],
  event: ['read', 'create', 'update'],
  hotel: ['read', 'create', 'update'],
  hotel_kontingent: ['read', 'create', 'update'],
  station: ['read', 'create', 'update'],
  anmeldung: ['read', 'create', 'update'],
  hotelbuchung: ['read', 'create', 'update', 'delete'],
  zahlung: ['read', 'create', 'update'],
  checkin: ['read', 'create', 'delete'],
  stempel: ['read', 'create', 'delete'],
  ehrung: ['read', 'create'],
}
export const demoViewKeys: Record<string, string | null> = {
  v_teilnahmen: 'person_id',
  v_zahlungsstatus: 'anmeldung_id',
  v_streckenlage: 'anmeldung_id',
  v_medaille: null,
}

/** Saves the connection and exposes the whole demo schema with its ceilings. */
export async function connectDemo(
  admin: TestClient,
  url: URL,
  overrides: Record<string, unknown> = {},
): Promise<{ connection: Connection; access: Map<string, TableAccess> }> {
  const created = await admin.send(
    'POST',
    '/internal/admin/connections',
    connectionInput(url, overrides),
  )
  expect(created.statusCode).toBe(201)
  const connection = created.json<Connection>()
  const access = new Map<string, TableAccess>()
  const objects: [string, TableOp[], string | null][] = [
    ...Object.entries(demoCeilings).map(
      ([name, ops]) => [name, ops, null] as [string, TableOp[], null],
    ),
    ...Object.entries(demoViewKeys).map(
      ([name, key]) => [name, ['read'], key] as [string, TableOp[], string | null],
    ),
  ]
  for (const [objectName, ops, keyColumn] of objects) {
    const response = await admin.send('POST', '/internal/admin/table-access', {
      connectionId: connection.id,
      objectName,
      ops,
      keyColumn,
      displayTemplate: null,
      apiResource: null,
      mcpEnabled: false,
      exclusions: objectName === 'hotel' ? [{ column: 'kontakt_email', scope: 'all' }] : [],
    })
    expect(response.statusCode, objectName).toBe(201)
    access.set(objectName, response.json<TableAccess>())
  }
  return { connection, access }
}

/** A small, fixed data set: two events, five people, registrations, payments, two hotels. */
export async function seedDemo(root: mysql.Connection): Promise<void> {
  await root.query(`
    INSERT INTO event (id, jahr, name, datum, startort, strecke_km, ticketpreis, anmeldeschluss) VALUES
      (1, 2025, 'Wanderung 2025', '2025-05-10', 'Marktplatz', 32.0, 25.00, '2025-05-01'),
      (2, 2026, 'Wanderung 2026', '2026-05-09', 'Marktplatz', 32.0, 28.00, '2026-05-01');
    INSERT INTO person (id, vorname, nachname, email, land, telefon) VALUES
      (1, 'Anna', 'Berg', 'anna@example.com', 'DE', '0170 1'),
      (2, 'Ben', 'Carstens', 'ben@example.com', 'DK', NULL),
      (3, 'Chloé', 'Dubois', 'chloe@example.com', 'FR', '0170 3'),
      (4, 'Dawid', 'Nowak', 'dawid@example.com', 'PL', NULL),
      (5, 'Eva', 'Berg', 'eva@example.com', 'DE', '0170 5');
    INSERT INTO anmeldung (id, person_id, event_id, ticket_typ, status, startnummer, betrag_soll, angemeldet_am) VALUES
      (1, 1, 1, 'standard', 'angemeldet', 101, 25.00, '2025-03-01 10:00:00'),
      (2, 2, 1, 'standard', 'angemeldet', 102, 25.00, '2025-03-02 10:00:00'),
      (3, 1, 2, 'standard', 'angemeldet', 201, 28.00, '2026-03-01 09:30:00'),
      (4, 2, 2, 'ermaessigt', 'angemeldet', 202, 20.00, '2026-03-29 01:30:00'),
      (5, 3, 2, 'standard', 'angemeldet', 203, 28.00, '2026-03-29 03:30:00'),
      (6, 4, 2, 'helfer', 'storniert', NULL, 0.00, '2026-04-01 12:00:00'),
      (7, 5, 2, 'standard', 'angemeldet', 204, 28.00, '2026-04-02 12:00:00');
    INSERT INTO hotel (id, name, ort, kontakt_email) VALUES
      (1, 'Lindenhof', 'Talheim', 'info@lindenhof.example'),
      (2, 'Berggasthof Adler', 'Bergdorf', 'adler@example.com');
    INSERT INTO hotel_kontingent (id, event_id, hotel_id, zimmerart, preis_nacht, anzahl) VALUES
      (1, 2, 1, 'Doppelzimmer', 80.00, 10),
      (2, 2, 2, 'Einzelzimmer', 60.00, 5),
      (3, 1, 1, 'Doppelzimmer', 75.00, 10);
    INSERT INTO hotelbuchung (id, anmeldung_id, hotel_kontingent_id, anreise, abreise, betrag_soll, eingecheckt_am) VALUES
      (1, 3, 1, '2026-05-08', '2026-05-10', 160.00, NULL),
      (2, 4, 2, '2026-05-08', '2026-05-09', 60.00, NULL),
      (3, 5, 1, '2026-05-08', '2026-05-10', 160.00, '2026-05-08 18:00:00'),
      (4, 1, 3, '2025-05-09', '2025-05-11', 150.00, '2025-05-09 17:00:00');
    INSERT INTO zahlung (id, anmeldung_id, betrag, eingang_am, verwendungszweck) VALUES
      (1, 1, 175.00, '2025-04-01', 'Berg 101'),
      (2, 3, 188.00, '2026-04-01', 'Berg 201'),
      (3, 4, 30.00, '2026-04-02', 'Carstens');
  `)
}
