// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('email', 'text', (col) => col.notNull().unique())
    .addColumn('display_name', 'text', (col) => col.notNull())
    .addColumn('system_role', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('password_hash', 'text')
    .addColumn('totp_secret', 'text')
    .addColumn('totp_enabled_at', 'integer')
    .addColumn('totp_last_step', 'integer')
    .addColumn('locale', 'text')
    .addColumn('format_locale', 'text')
    .addColumn('theme', 'text', (col) => col.notNull().defaultTo('system'))
    .addColumn('invited_by', 'text')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .addColumn('last_login_at', 'integer')
    .execute()

  await db.schema
    .createTable('user_recovery_codes')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('code_hash', 'text', (col) => col.notNull())
    .addColumn('used_at', 'integer')
    .execute()
  await db.schema
    .createIndex('user_recovery_codes_user')
    .on('user_recovery_codes')
    .column('user_id')
    .execute()

  await db.schema
    .createTable('identity_providers')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('slug', 'text', (col) => col.notNull().unique())
    .addColumn('display_name', 'text', (col) => col.notNull())
    .addColumn('issuer_url', 'text', (col) => col.notNull())
    .addColumn('client_id', 'text', (col) => col.notNull())
    .addColumn('client_secret', 'text')
    .addColumn('scopes', 'text', (col) => col.notNull())
    .addColumn('auto_approve_domains', 'text', (col) => col.notNull())
    .addColumn('enabled', 'integer', (col) => col.notNull())
    .addColumn('position', 'integer', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .execute()

  await db.schema
    .createTable('user_identities')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('provider_id', 'text', (col) =>
      col.notNull().references('identity_providers.id').onDelete('cascade'),
    )
    .addColumn('subject', 'text', (col) => col.notNull())
    .addColumn('email', 'text')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addUniqueConstraint('user_identities_subject', ['provider_id', 'subject'])
    .execute()
  await db.schema
    .createIndex('user_identities_user')
    .on('user_identities')
    .column('user_id')
    .execute()

  await db.schema
    .createTable('sessions')
    .addColumn('id_hash', 'text', (col) => col.primaryKey())
    .addColumn('user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('state', 'text', (col) => col.notNull())
    .addColumn('auth_method', 'text', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('last_active_at', 'integer', (col) => col.notNull())
    .addColumn('expires_at', 'integer', (col) => col.notNull())
    .addColumn('ip', 'text')
    .addColumn('user_agent', 'text')
    .execute()
  await db.schema.createIndex('sessions_user').on('sessions').column('user_id').execute()

  await db.schema
    .createTable('user_tokens')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('purpose', 'text', (col) => col.notNull())
    .addColumn('token_hash', 'text', (col) => col.notNull().unique())
    .addColumn('expires_at', 'integer', (col) => col.notNull())
    .addColumn('consumed_at', 'integer')
    .addColumn('created_by', 'text')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .execute()

  await db.schema
    .createTable('audit_events')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('occurred_at', 'integer', (col) => col.notNull())
    .addColumn('actor_kind', 'text', (col) => col.notNull())
    .addColumn('actor_id', 'text')
    .addColumn('actor_label', 'text')
    .addColumn('action', 'text', (col) => col.notNull())
    .addColumn('ip', 'text')
    .addColumn('subject_kind', 'text')
    .addColumn('subject_id', 'text')
    .addColumn('subject_label', 'text')
    .addColumn('page_id', 'text')
    .addColumn('component_id', 'text')
    .addColumn('connection_id', 'text')
    .addColumn('object_name', 'text')
    .addColumn('row_key', 'text')
    .addColumn('changes', 'text')
    .addColumn('details', 'text')
    .execute()
  await db.schema
    .createIndex('audit_events_time')
    .on('audit_events')
    .column('occurred_at')
    .execute()
  await db.schema.createIndex('audit_events_action').on('audit_events').column('action').execute()
  await sql`create trigger audit_events_immutable before update on audit_events
    begin select raise(abort, 'audit events are immutable'); end`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop trigger if exists audit_events_immutable`.execute(db)
  for (const table of [
    'audit_events',
    'user_tokens',
    'sessions',
    'user_identities',
    'identity_providers',
    'user_recovery_codes',
    'users',
  ]) {
    await db.schema.dropTable(table).execute()
  }
}
