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
