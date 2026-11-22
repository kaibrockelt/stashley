// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import mysql from 'mysql2/promise'
import { env } from './env.ts'

/** Runs one statement against the demo database as root, for checks and test fixtures. */
export async function sql<T = mysql.RowDataPacket>(statement: string, values: unknown[] = []) {
  const connection = await mysql.createConnection({
    host: env.db.host,
    user: 'root',
    password: env.db.rootPassword,
    database: 'wanderverein',
    timezone: 'Z',
  })
  try {
    // The server's default collation, as the views were created with it.
    await connection.query("SET NAMES utf8mb4, time_zone = '+00:00'")
    const [rows] = await connection.query(statement, values)
    return rows as T[]
  } finally {
    await connection.end()
  }
}
