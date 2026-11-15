// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Kysely table types of the metadata store. Timestamps are milliseconds since the epoch,
 * booleans are 0/1 and JSON values are TEXT; repositories convert at their boundary.
 */
export interface Database {
  settings: SettingsTable
  instance_heartbeat: InstanceHeartbeatTable
  job_runs: JobRunsTable
  users: UsersTable
  user_recovery_codes: UserRecoveryCodesTable
  identity_providers: IdentityProvidersTable
  user_identities: UserIdentitiesTable
  sessions: SessionsTable
  user_tokens: UserTokensTable
  audit_events: AuditEventsTable
  connections: ConnectionsTable
  connection_credentials: ConnectionCredentialsTable
  schema_snapshots: SchemaSnapshotsTable
  schema_drifts: SchemaDriftsTable
  table_access: TableAccessTable
  column_exclusions: ColumnExclusionsTable
  virtual_relations: VirtualRelationsTable
  sections: SectionsTable
  pages: PagesTable
  page_versions: PageVersionsTable
  roles: RolesTable
  user_roles: UserRolesTable
  instance_variables: InstanceVariablesTable
  queries: QueriesTable
  query_versions: QueryVersionsTable
}

export interface SectionsTable {
  id: string
  name: string
  position: number
  created_at: number
  updated_at: number
}

export interface PagesTable {
  id: string
  section_id: string | null
  position: number
  kind: 'dashboard' | 'table'
  slug: string
  /** JSON page document (§13.1). */
  draft: string
  draft_revision: number
  draft_updated_by: string | null
  draft_updated_at: number
  published_version: number | null
  created_at: number
  archived_at: number | null
}

export interface PageVersionsTable {
  page_id: string
  version: number
  /** JSON page document with pinned query versions. */
  document: string
  source_revision: number
  published_by: string | null
  published_at: number
}

export interface RolesTable {
  id: string
  name: string
  description: string
  home_page_id: string | null
  position: number
  created_at: number
  updated_at: number
}

export interface UserRolesTable {
  user_id: string
  role_id: string
}

export interface InstanceVariablesTable {
  id: string
  name: string
  type: 'string' | 'integer' | 'decimal' | 'date' | 'datetime' | 'boolean'
  /** JSON value. */
  value: string
  description: string
  updated_by: string | null
  created_at: number
  updated_at: number
}

export interface QueriesTable {
  id: string
  connection_id: string
  name: string
  description: string
  mode: 'builder' | 'sql'
  /** 0 means live. */
  cache_ttl_seconds: number
  latest_version: number
  created_by: string | null
  created_at: number
  updated_at: number
  archived_at: number | null
}

export interface QueryVersionsTable {
  query_id: string
  version: number
  sql_text: string
  /** JSON builder spec; null for SQL queries. */
  builder_spec: string | null
  /** JSON parameter definitions. */
  parameters: string
  /** JSON analysis (§10.2). */
  analysis: string
  /** JSON executable form (§10.4). */
  executable: string
  /** JSON result columns of the last test run, if any. */
  result_columns: string | null
  created_by: string | null
  created_at: number
}

export interface ConnectionsTable {
  id: string
  name: string
  host: string
  port: number
  database_name: string
  engine: 'mariadb' | 'mysql' | null
  server_version: string | null
  /** JSON: `{ mode, caPem, serverName }`. */
  tls: string
  timezone: string
  query_timeout_ms: number
  created_at: number
  updated_at: number
  /** Last schema read, manual or scheduled; null before the first. */
  schema_checked_at: number | null
  /** Failure code of the last schema read, null when it succeeded. */
  schema_check_failure: string | null
}

export interface ConnectionCredentialsTable {
  id: string
  connection_id: string
  purpose: 'read' | 'write' | 'schema'
  username: string
  /** Encrypted, AAD `connection_credentials:<id>:password`. */
  password: string
  /** JSON grant report (§9.4). */
  grant_report: string | null
  checked_at: number | null
}

export interface SchemaSnapshotsTable {
  id: string
  connection_id: string
  captured_at: number
  content_hash: string
  /** JSON list of catalog objects (§9.3). */
  content: string
  trigger: 'manual' | 'scheduled' | 'import'
}

export interface SchemaDriftsTable {
  id: string
  connection_id: string
  snapshot_id: string
  detected_at: number
  /** JSON: `{ diff, impact }`. */
  diff: string
  acknowledged_at: number | null
  acknowledged_by: string | null
}

export interface TableAccessTable {
  id: string
  connection_id: string
  object_name: string
  object_type: 'table' | 'view'
  /** Bitmask: read 1, create 2, update 4, delete 8. */
  ops: number
  key_column: string | null
  display_template: string | null
  api_resource: string
  mcp_enabled: number
  state: 'active' | 'pending_grants'
  /** Optimistic locking (E7). */
  lock_mode: 'auto' | 'column' | 'none'
  lock_column: string | null
  created_at: number
  updated_at: number
}

export interface ColumnExclusionsTable {
  table_access_id: string
  column_name: string
  scope: 'all' | 'mcp'
}

export interface VirtualRelationsTable {
  id: string
  connection_id: string
  source_object: string
  source_column: string
  target_object: string
  target_column: string
  kind: 'many_to_one' | 'one_to_one'
  created_at: number
}

export interface SettingsTable {
  key: string
  value: string
  updated_at: number
  updated_by: string | null
}

export interface InstanceHeartbeatTable {
  id: number
  pid: number
  started_at: number
  heartbeat_at: number
}

export interface JobRunsTable {
  name: string
  last_started_at: number | null
  last_finished_at: number | null
  last_status: 'succeeded' | 'failed' | null
  last_error_code: string | null
}

export type SystemRole = 'admin' | 'manager' | 'user'
export type UserStatus = 'pending' | 'active' | 'disabled'
export type SessionState = 'mfa_required' | 'mfa_enrollment_required' | 'active'

export interface UsersTable {
  id: string
  email: string
  display_name: string
  system_role: SystemRole
  status: UserStatus
  password_hash: string | null
  /** Encrypted; set during enrollment, active once `totp_enabled_at` is set. */
  totp_secret: string | null
  totp_enabled_at: number | null
  /** Last accepted TOTP time step; codes cannot be replayed. */
  totp_last_step: number | null
  locale: string | null
  format_locale: string | null
  theme: string
  invited_by: string | null
  created_at: number
  updated_at: number
  last_login_at: number | null
}

export interface UserRecoveryCodesTable {
  id: string
  user_id: string
  code_hash: string
  used_at: number | null
}

export interface IdentityProvidersTable {
  id: string
  slug: string
  display_name: string
  issuer_url: string
  client_id: string
  /** Encrypted. */
  client_secret: string | null
  scopes: string
  /** JSON array of lower-case domains. */
  auto_approve_domains: string
  enabled: number
  position: number
  created_at: number
  updated_at: number
}

export interface UserIdentitiesTable {
  id: string
  user_id: string
  provider_id: string
  subject: string
  email: string | null
  created_at: number
}

export interface SessionsTable {
  id_hash: string
  user_id: string
  state: SessionState
  auth_method: 'password' | 'oidc' | 'invitation' | 'password_reset'
  created_at: number
  last_active_at: number
  expires_at: number
  ip: string | null
  user_agent: string | null
}

export interface UserTokensTable {
  id: string
  user_id: string
  purpose: 'invitation' | 'password_reset'
  token_hash: string
  expires_at: number
  consumed_at: number | null
  created_by: string | null
  created_at: number
}

export interface AuditEventsTable {
  id: string
  occurred_at: number
  actor_kind: 'user' | 'api_token' | 'mcp' | 'system' | 'cli'
  actor_id: string | null
  actor_label: string | null
  action: string
  ip: string | null
  subject_kind: string | null
  subject_id: string | null
  subject_label: string | null
  page_id: string | null
  component_id: string | null
  connection_id: string | null
  object_name: string | null
  row_key: string | null
  /** JSON object: field -> [old, new]. */
  changes: string | null
  /** JSON object. */
  details: string | null
}
