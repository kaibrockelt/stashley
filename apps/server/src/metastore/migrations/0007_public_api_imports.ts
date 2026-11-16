// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Kysely } from 'kysely'

/** The public REST API (endpoints, tokens, grants) and CSV import jobs (M7, §7.2). */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('api_endpoints')
    .addColumn('table_access_id', 'text', (col) =>
      col.notNull().references('table_access.id').onDelete('cascade'),
    )
    .addColumn('operation', 'text', (col) => col.notNull())
    .addColumn('enabled_by', 'text')
    .addColumn('enabled_at', 'integer', (col) => col.notNull())
    .addPrimaryKeyConstraint('api_endpoints_pk', ['table_access_id', 'operation'])
    .execute()

  await db.schema
    .createTable('api_tokens')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('token_hash', 'text', (col) => col.notNull().unique())
    .addColumn('token_hint', 'text', (col) => col.notNull())
    .addColumn('expires_at', 'integer')
    .addColumn('ip_allowlist', 'text', (col) => col.notNull())
    .addColumn('rate_limit_per_minute', 'integer', (col) => col.notNull())
    .addColumn('created_by', 'text')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .addColumn('revoked_at', 'integer')
    .addColumn('last_used_at', 'integer')
    .addColumn('request_count', 'integer', (col) => col.notNull())
    .execute()

  await db.schema
    .createTable('api_token_grants')
    .addColumn('token_id', 'text', (col) =>
      col.notNull().references('api_tokens.id').onDelete('cascade'),
    )
    .addColumn('table_access_id', 'text', (col) =>
      col.notNull().references('table_access.id').onDelete('cascade'),
    )
    .addColumn('operation', 'text', (col) => col.notNull())
    .addPrimaryKeyConstraint('api_token_grants_pk', ['token_id', 'table_access_id', 'operation'])
    .execute()
  await db.schema
    .createIndex('api_token_grants_table')
    .on('api_token_grants')
    .columns(['table_access_id', 'operation'])
    .execute()

  await db.schema
    .createTable('import_jobs')
    .addColumn('id', 'text', (col) => col.primaryKey())
    // Both are chosen after the upload.
    .addColumn('connection_id', 'text', (col) =>
      col.references('connections.id').onDelete('cascade'),
    )
    .addColumn('table_access_id', 'text', (col) =>
      col.references('table_access.id').onDelete('set null'),
    )
    .addColumn('new_table', 'text')
    .addColumn('mode', 'text', (col) => col.notNull())
    .addColumn('upsert_key', 'text')
    .addColumn('file_name', 'text', (col) => col.notNull())
    .addColumn('file_sha256', 'text', (col) => col.notNull())
    .addColumn('file_size', 'integer', (col) => col.notNull())
    .addColumn('encoding_detected', 'text', (col) => col.notNull())
    .addColumn('parse_options', 'text', (col) => col.notNull())
    .addColumn('mapping', 'text')
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('dry_run', 'text')
    .addColumn('result', 'text')
    .addColumn('created_by', 'text', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .addColumn('finished_at', 'integer')
    .addColumn('expires_at', 'integer', (col) => col.notNull())
    .execute()
  await db.schema.createIndex('import_jobs_expiry').on('import_jobs').column('expires_at').execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('import_jobs').execute()
  await db.schema.dropTable('api_token_grants').execute()
  await db.schema.dropTable('api_tokens').execute()
  await db.schema.dropTable('api_endpoints').execute()
}
