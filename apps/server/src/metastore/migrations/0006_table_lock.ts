// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Kysely } from 'kysely'

/** The lock column of a table access (E7): detected (`auto`), named, or none. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('table_access')
    .addColumn('lock_mode', 'text', (column) => column.notNull().defaultTo('auto'))
    .execute()
  await db.schema.alterTable('table_access').addColumn('lock_column', 'text').execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('table_access').dropColumn('lock_column').execute()
  await db.schema.alterTable('table_access').dropColumn('lock_mode').execute()
}
