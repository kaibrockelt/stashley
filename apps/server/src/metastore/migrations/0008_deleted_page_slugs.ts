// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { type Kysely, sql } from 'kysely'

/**
 * Deleted pages give their address free: they keep `~<id>`, which no page address can be
 * (addresses are lower-case letters, digits and hyphens), so a new or imported page can use
 * the old one again.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE pages SET slug = '~' || id WHERE archived_at IS NOT NULL`.execute(db)
}

export async function down(): Promise<void> {
  // The original addresses are gone; deleted pages keep their placeholder.
}
