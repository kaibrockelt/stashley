// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('connections')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull().unique())
    .addColumn('host', 'text', (col) => col.notNull())
    .addColumn('port', 'integer', (col) => col.notNull())
    .addColumn('database_name', 'text', (col) => col.notNull())
    .addColumn('engine', 'text')
    .addColumn('server_version', 'text')
    .addColumn('tls', 'text', (col) => col.notNull())
    .addColumn('timezone', 'text', (col) => col.notNull())
    .addColumn('query_timeout_ms', 'integer', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .execute()

  await db.schema
    .createTable('connection_credentials')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('connection_id', 'text', (col) =>
      col.notNull().references('connections.id').onDelete('cascade'),
    )
    .addColumn('purpose', 'text', (col) => col.notNull())
    .addColumn('username', 'text', (col) => col.notNull())
    .addColumn('password', 'text', (col) => col.notNull())
    .addColumn('grant_report', 'text')
    .addColumn('checked_at', 'integer')
    .addUniqueConstraint('connection_credentials_purpose', ['connection_id', 'purpose'])
    .execute()

  await db.schema
    .createTable('schema_snapshots')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('connection_id', 'text', (col) =>
      col.notNull().references('connections.id').onDelete('cascade'),
    )
    .addColumn('captured_at', 'integer', (col) => col.notNull())
    .addColumn('content_hash', 'text', (col) => col.notNull())
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('trigger', 'text', (col) => col.notNull())
    .execute()
  await db.schema
    .createIndex('schema_snapshots_connection')
    .on('schema_snapshots')
    .columns(['connection_id', 'captured_at'])
    .execute()

  await db.schema
    .createTable('schema_drifts')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('connection_id', 'text', (col) =>
      col.notNull().references('connections.id').onDelete('cascade'),
    )
    .addColumn('snapshot_id', 'text', (col) =>
      col.notNull().references('schema_snapshots.id').onDelete('cascade'),
    )
    .addColumn('detected_at', 'integer', (col) => col.notNull())
    .addColumn('diff', 'text', (col) => col.notNull())
    .addColumn('acknowledged_at', 'integer')
    .addColumn('acknowledged_by', 'text')
    .execute()
  await db.schema
    .createIndex('schema_drifts_connection')
    .on('schema_drifts')
    .column('connection_id')
    .execute()

  await db.schema
    .createTable('table_access')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('connection_id', 'text', (col) => col.notNull().references('connections.id'))
    .addColumn('object_name', 'text', (col) => col.notNull())
    .addColumn('object_type', 'text', (col) => col.notNull())
    .addColumn('ops', 'integer', (col) => col.notNull())
    .addColumn('key_column', 'text')
    .addColumn('display_template', 'text')
    .addColumn('api_resource', 'text', (col) => col.notNull().unique())
    .addColumn('mcp_enabled', 'integer', (col) => col.notNull())
    .addColumn('state', 'text', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .addUniqueConstraint('table_access_object', ['connection_id', 'object_name'])
    .execute()

  await db.schema
    .createTable('column_exclusions')
    .addColumn('table_access_id', 'text', (col) =>
      col.notNull().references('table_access.id').onDelete('cascade'),
    )
    .addColumn('column_name', 'text', (col) => col.notNull())
    .addColumn('scope', 'text', (col) => col.notNull())
    .addPrimaryKeyConstraint('column_exclusions_pk', ['table_access_id', 'column_name'])
    .execute()

  await db.schema
    .createTable('virtual_relations')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('connection_id', 'text', (col) =>
      col.notNull().references('connections.id').onDelete('cascade'),
    )
    .addColumn('source_object', 'text', (col) => col.notNull())
    .addColumn('source_column', 'text', (col) => col.notNull())
    .addColumn('target_object', 'text', (col) => col.notNull())
    .addColumn('target_column', 'text', (col) => col.notNull())
    .addColumn('kind', 'text', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addUniqueConstraint('virtual_relations_unique', [
      'connection_id',
      'source_object',
      'source_column',
      'target_object',
    ])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    'virtual_relations',
    'column_exclusions',
    'table_access',
    'schema_drifts',
    'schema_snapshots',
    'connection_credentials',
    'connections',
  ]) {
    await db.schema.dropTable(table).execute()
  }
}
