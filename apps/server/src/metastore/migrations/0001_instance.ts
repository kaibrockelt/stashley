// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('settings')
    .addColumn('key', 'text', (col) => col.primaryKey())
    .addColumn('value', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .addColumn('updated_by', 'text')
    .execute()

  await db.schema
    .createTable('instance_heartbeat')
    .addColumn('id', 'integer', (col) => col.primaryKey())
    .addColumn('pid', 'integer', (col) => col.notNull())
    .addColumn('started_at', 'integer', (col) => col.notNull())
    .addColumn('heartbeat_at', 'integer', (col) => col.notNull())
    .execute()

  await db.schema
    .createTable('job_runs')
    .addColumn('name', 'text', (col) => col.primaryKey())
    .addColumn('last_started_at', 'integer')
    .addColumn('last_finished_at', 'integer')
    .addColumn('last_status', 'text')
    .addColumn('last_error_code', 'text')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('job_runs').execute()
  await db.schema.dropTable('instance_heartbeat').execute()
  await db.schema.dropTable('settings').execute()
}
