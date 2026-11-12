// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Migration } from 'kysely/migration'
import * as m0001 from './0001_instance.ts'

/** Registered statically so the server can be bundled; names sort in apply order. */
export const migrations: Record<string, Migration> = {
  '0001_instance': m0001,
}
