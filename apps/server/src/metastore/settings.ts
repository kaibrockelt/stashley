// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { Database } from './schema.ts'

/** One Zod schema per settings key; the default applies while no row exists. */
export const settingDefinitions = {
  'backup.automatic': {
    schema: z.object({ enabled: z.boolean(), retentionDays: z.number().int().min(1).max(365) }),
    defaultValue: { enabled: false, retentionDays: 14 },
  },
  'crypto.keyCheck': {
    schema: z.string(),
    defaultValue: undefined,
  },
  'auth.localLogin': {
    schema: z.object({ enabled: z.boolean() }),
    defaultValue: { enabled: true },
  },
  'auth.twoFactor': {
    schema: z.object({ enforced: z.boolean() }),
    defaultValue: { enforced: false },
  },
  'auth.session': {
    schema: z.object({
      idleMinutes: z
        .number()
        .int()
        .min(5)
        .max(60 * 24 * 30),
      maxAgeDays: z.number().int().min(1).max(90),
    }),
    defaultValue: { idleMinutes: 12 * 60, maxAgeDays: 7 },
  },
  'audit.retention': {
    schema: z.object({ days: z.number().int().min(30).max(3650) }),
    defaultValue: { days: 365 },
  },
} as const

type Definitions = typeof settingDefinitions
export type SettingKey = keyof Definitions
export type SettingValue<K extends SettingKey> = z.infer<Definitions[K]['schema']>

export class SettingsRepository {
  private readonly db: Kysely<Database>

  constructor(db: Kysely<Database>) {
    this.db = db
  }

  /** `db` is a transaction handle when the read is part of one. */
  async get<K extends SettingKey>(
    key: K,
    db: Kysely<Database> = this.db,
  ): Promise<SettingValue<K> | Definitions[K]['defaultValue']> {
    const row = await db
      .selectFrom('settings')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst()
    const definition = settingDefinitions[key]
    if (row === undefined) return definition.defaultValue
    return definition.schema.parse(JSON.parse(row.value)) as SettingValue<K>
  }

  async set<K extends SettingKey>(
    key: K,
    value: SettingValue<K>,
    updatedBy: string | null = null,
  ): Promise<void> {
    const parsed: unknown = settingDefinitions[key].schema.parse(value)
    const row = {
      key,
      value: JSON.stringify(parsed),
      updated_at: Date.now(),
      updated_by: updatedBy,
    }
    await this.db
      .insertInto('settings')
      .values(row)
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({
          value: row.value,
          updated_at: row.updated_at,
          updated_by: row.updated_by,
        }),
      )
      .execute()
  }
}
