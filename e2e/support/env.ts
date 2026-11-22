// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import path from 'node:path'

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '')
    throw new Error(`${name} is not set (see e2e/compose.yml)`)
  return value
}

/** The end-to-end environment from `e2e/compose.yml`. */
export const env = {
  /** The main instance: set up through the UI, then runs the scenario. */
  a: { base: required('E2E_BASE_A'), adminPassword: required('E2E_ADMIN_PASSWORD_A') },
  /** The second instance: receives the configuration export of the first. */
  b: { base: required('E2E_BASE_B'), adminPassword: required('E2E_ADMIN_PASSWORD_B') },
  adminEmail: required('E2E_ADMIN_EMAIL'),
  db: { host: required('E2E_DB_HOST'), rootPassword: required('E2E_DB_ROOT_PASSWORD') },
  oidcIssuer: required('E2E_OIDC_ISSUER'),
}

/** Files shared between specs of one run (the demo configuration, the export). */
export const runDirectory = path.join(import.meta.dirname, '..', '.tmp')

/** The demo database as Stashley's connection form takes it. */
export const demoDatabase = {
  name: 'wanderverein',
  host: 'db',
  port: 3306,
  database: 'wanderverein',
  read: { username: 'stashley_read', password: 'demo-read-password' },
  write: { username: 'stashley_write', password: 'demo-write-password' },
  schema: { username: 'stashley_schema', password: 'demo-schema-password' },
  overPrivileged: { username: 'stashley_zuviel', password: 'demo-zuviel-password' },
}

/** Password of every test account the specs create. */
export const userPassword = 'e2e user passphrase'
