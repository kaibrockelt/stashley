// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Migration } from 'kysely/migration'
import * as m0001 from './0001_instance.ts'
import * as m0002 from './0002_accounts.ts'
import * as m0003 from './0003_connections.ts'
import * as m0004 from './0004_schema_check.ts'
import * as m0005 from './0005_queries_pages.ts'
import * as m0006 from './0006_table_lock.ts'

/** Registered statically so the server can be bundled; names sort in apply order. */
export const migrations: Record<string, Migration> = {
  '0001_instance': m0001,
  '0002_accounts': m0002,
  '0003_connections': m0003,
  '0004_schema_check': m0004,
  '0005_queries_pages': m0005,
  '0006_table_lock': m0006,
}
