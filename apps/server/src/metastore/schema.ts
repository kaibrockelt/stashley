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
