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
} as const

type Definitions = typeof settingDefinitions
export type SettingKey = keyof Definitions
export type SettingValue<K extends SettingKey> = z.infer<Definitions[K]['schema']>

export class SettingsRepository {
  private readonly db: Kysely<Database>

  constructor(db: Kysely<Database>) {
    this.db = db
  }

  async get<K extends SettingKey>(
    key: K,
  ): Promise<SettingValue<K> | Definitions[K]['defaultValue']> {
    const row = await this.db
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
