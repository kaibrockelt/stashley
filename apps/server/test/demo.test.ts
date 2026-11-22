// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { verificationQuery } from '@stashley/demo'
import type mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prepareDatabase, rootConnection, loadDemoData, targets } from './support.ts'

// The demo data loads on every engine, and the views show what the scenario promises.
describe.each(targets)('demo data on $name', (target) => {
  let root: mysql.Connection

  beforeAll(async () => {
    root = await rootConnection(target.url)
    await prepareDatabase(root)
  })

  afterAll(async () => {
    await root.end()
  })

  it('meets every figure of the scenario', async () => {
    const facts = await loadDemoData(root)
    await root.query("SET time_zone = '+00:00'")
    const [rows] = await root.query<mysql.RowDataPacket[]>(verificationQuery(facts))
    expect(rows[0]?.failed).toBe('')
  })
})
