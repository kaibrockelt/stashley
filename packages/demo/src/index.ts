// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import path from 'node:path'

export { DEMO_SEED, generateDemo } from './generate.ts'
export type { DemoData, DemoFacts, DemoOptions } from './generate.ts'
export { verificationQuery } from './verify.ts'
export {
  demoCeilings,
  demoConfig,
  demoConnectionName,
  demoId,
  demoIds,
  demoRoles,
  demoViewKeys,
} from './scenario.ts'
export type { DemoRole } from './scenario.ts'

const sqlDirectory = path.join(import.meta.dirname, '..', 'sql')

/** `CREATE TABLE` and `CREATE VIEW` statements of the demo schema. */
export const schemaSql = (): string => readFileSync(path.join(sqlDirectory, 'schema.sql'), 'utf8')

/** The demo database users, including the deliberately over-privileged one. */
export const usersSql = (): string => readFileSync(path.join(sqlDirectory, 'users.sql'), 'utf8')
