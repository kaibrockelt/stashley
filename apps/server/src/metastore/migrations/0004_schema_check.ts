// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Kysely } from 'kysely'

/** Outcome of the last schema read per connection, so a failed daily check is visible. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('connections').addColumn('schema_checked_at', 'integer').execute()
  await db.schema.alterTable('connections').addColumn('schema_check_failure', 'text').execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('connections').dropColumn('schema_check_failure').execute()
  await db.schema.alterTable('connections').dropColumn('schema_checked_at').execute()
}
