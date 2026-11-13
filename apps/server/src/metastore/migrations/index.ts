// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Migration } from 'kysely/migration'
import * as m0001 from './0001_instance.ts'
import * as m0002 from './0002_accounts.ts'
import * as m0003 from './0003_connections.ts'

/** Registered statically so the server can be bundled; names sort in apply order. */
export const migrations: Record<string, Migration> = {
  '0001_instance': m0001,
  '0002_accounts': m0002,
  '0003_connections': m0003,
}
