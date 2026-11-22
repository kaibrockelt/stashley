// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { demoConfig, generateDemo, schemaSql, usersSql, verificationQuery } from '@stashley/demo'
import mysql from 'mysql2/promise'
import { env, runDirectory } from './env.ts'

/**
 * Seeds the demo database before every run (§ Testdaten: the suite reseeds), so the event day
 * is around now, and writes the demo configuration for the import specs.
 */
export default async function globalSetup(): Promise<void> {
  const root = await mysql.createConnection({
    host: env.db.host,
    user: 'root',
    password: env.db.rootPassword,
    multipleStatements: true,
  })
  try {
    await root.query('DROP DATABASE IF EXISTS wanderverein')
    await root.query('CREATE DATABASE wanderverein CHARACTER SET utf8mb4')
    await root.query('USE wanderverein')
    // Views keep the creating session's collation; use the server's, as Stashley does.
    await root.query('SET NAMES utf8mb4')
    await root.query(schemaSql())
    await root.query(usersSql())
    const demo = generateDemo({ now: new Date() })
    for (const statement of demo.statements) await root.query(statement)
    await root.query("SET time_zone = '+00:00'")
    const [rows] = await root.query<mysql.RowDataPacket[]>(verificationQuery(demo.facts))
    if (rows[0]?.failed !== '')
      throw new Error(`demo data check failed: ${String(rows[0]?.failed)}`)
    rmSync(runDirectory, { recursive: true, force: true })
    mkdirSync(runDirectory, { recursive: true })
    writeFileSync(path.join(runDirectory, 'facts.json'), JSON.stringify(demo.facts))
    writeFileSync(
      path.join(runDirectory, 'demo-config.json'),
      `${JSON.stringify(demoConfig(), null, 2)}\n`,
    )
  } finally {
    await root.end()
  }
}
