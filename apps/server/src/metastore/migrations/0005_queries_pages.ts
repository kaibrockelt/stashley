// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Kysely } from 'kysely'

/** Roles, instance variables, the query library, sections and pages (M4). */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('sections')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('position', 'integer', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .execute()

  await db.schema
    .createTable('pages')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('section_id', 'text', (col) => col.references('sections.id').onDelete('set null'))
    .addColumn('position', 'integer', (col) => col.notNull())
    .addColumn('kind', 'text', (col) => col.notNull())
    .addColumn('slug', 'text', (col) => col.notNull().unique())
    .addColumn('draft', 'text', (col) => col.notNull())
    .addColumn('draft_revision', 'integer', (col) => col.notNull())
    .addColumn('draft_updated_by', 'text')
    .addColumn('draft_updated_at', 'integer', (col) => col.notNull())
    .addColumn('published_version', 'integer')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('archived_at', 'integer')
    .execute()

  await db.schema
    .createTable('page_versions')
    .addColumn('page_id', 'text', (col) => col.notNull().references('pages.id').onDelete('cascade'))
    .addColumn('version', 'integer', (col) => col.notNull())
    .addColumn('document', 'text', (col) => col.notNull())
    .addColumn('source_revision', 'integer', (col) => col.notNull())
    .addColumn('published_by', 'text')
    .addColumn('published_at', 'integer', (col) => col.notNull())
    .addPrimaryKeyConstraint('page_versions_pk', ['page_id', 'version'])
    .execute()

  await db.schema
    .createTable('roles')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull().unique())
    .addColumn('description', 'text', (col) => col.notNull())
    .addColumn('home_page_id', 'text', (col) => col.references('pages.id').onDelete('set null'))
    .addColumn('position', 'integer', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .execute()

  await db.schema
    .createTable('user_roles')
    .addColumn('user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('role_id', 'text', (col) => col.notNull().references('roles.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('user_roles_pk', ['user_id', 'role_id'])
    .execute()
  await db.schema.createIndex('user_roles_role').on('user_roles').column('role_id').execute()

  await db.schema
    .createTable('instance_variables')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull().unique())
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('value', 'text', (col) => col.notNull())
    .addColumn('description', 'text', (col) => col.notNull())
    .addColumn('updated_by', 'text')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .execute()

  await db.schema
    .createTable('queries')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('connection_id', 'text', (col) => col.notNull().references('connections.id'))
    .addColumn('name', 'text', (col) => col.notNull().unique())
    .addColumn('description', 'text', (col) => col.notNull())
    .addColumn('mode', 'text', (col) => col.notNull())
    .addColumn('cache_ttl_seconds', 'integer', (col) => col.notNull())
    .addColumn('latest_version', 'integer', (col) => col.notNull())
    .addColumn('created_by', 'text')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .addColumn('archived_at', 'integer')
    .execute()

  await db.schema
    .createTable('query_versions')
    .addColumn('query_id', 'text', (col) =>
      col.notNull().references('queries.id').onDelete('cascade'),
    )
    .addColumn('version', 'integer', (col) => col.notNull())
    .addColumn('sql_text', 'text', (col) => col.notNull())
    .addColumn('builder_spec', 'text')
    .addColumn('parameters', 'text', (col) => col.notNull())
    .addColumn('analysis', 'text', (col) => col.notNull())
    .addColumn('executable', 'text', (col) => col.notNull())
    .addColumn('result_columns', 'text')
    .addColumn('created_by', 'text')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addPrimaryKeyConstraint('query_versions_pk', ['query_id', 'version'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    'query_versions',
    'queries',
    'instance_variables',
    'user_roles',
    'roles',
    'page_versions',
    'pages',
    'sections',
  ]) {
    await db.schema.dropTable(table).execute()
  }
}
