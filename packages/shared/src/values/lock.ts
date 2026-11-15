// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod'
import type { CatalogColumn, CatalogObject } from '../api/connections.ts'

/**
 * Optimistic locking of a table (§11, E7). The lock column is detected: an integer `version`
 * column, otherwise an `updated_at` DATETIME or TIMESTAMP. Admins can name another column on
 * the table access or turn the lock column off; without one, updates compare the original
 * values of the writable fields. A lock column is never excluded, because the write user no
 * longer reads excluded columns, and never generated, because the server writes it.
 */

export const lockSetting = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }).strict(),
  z.object({ mode: z.literal('column'), column: z.string().trim().min(1).max(64) }).strict(),
  z.object({ mode: z.literal('none') }).strict(),
])
export type LockSetting = z.infer<typeof lockSetting>

export type LockStrategy =
  | { kind: 'version'; column: string }
  /** `setByServer`: the column has no `ON UPDATE` default, so the server sets it. */
  | { kind: 'timestamp'; column: string; setByServer: boolean }
  | { kind: 'values' }

export type LockProblem = 'unknown_column' | 'excluded_column' | 'unsuitable_column'

const versionKinds = new Set(['integer', 'bigint'])
const timeKinds = new Set(['datetime', 'timestamp'])

function strategyOf(column: CatalogColumn): LockStrategy | undefined {
  if (column.generated) return undefined
  if (versionKinds.has(column.kind)) return { kind: 'version', column: column.name }
  if (timeKinds.has(column.kind)) {
    const onUpdate = column.onUpdate ?? null
    return {
      kind: 'timestamp',
      column: column.name,
      setByServer: onUpdate === null || !/current_timestamp|now\(/i.test(onUpdate),
    }
  }
  return undefined
}

/** The lock strategy of an object, and why a configured column cannot be used. */
export function lockStrategy(
  object: CatalogObject | undefined,
  excluded: ReadonlySet<string>,
  setting: LockSetting,
): { strategy: LockStrategy; problem?: LockProblem } {
  const values: LockStrategy = { kind: 'values' }
  if (object === undefined || object.type !== 'table' || setting.mode === 'none') {
    return { strategy: values }
  }
  const isExcluded = (name: string) =>
    [...excluded].some((column) => column.toLowerCase() === name.toLowerCase())
  const find = (name: string) =>
    object.columns.find((column) => column.name.toLowerCase() === name.toLowerCase())
  if (setting.mode === 'column') {
    const column = find(setting.column)
    if (column === undefined) return { strategy: values, problem: 'unknown_column' }
    if (isExcluded(column.name)) return { strategy: values, problem: 'excluded_column' }
    if (object.primaryKey.includes(column.name)) {
      return { strategy: values, problem: 'unsuitable_column' }
    }
    const strategy = strategyOf(column)
    return strategy === undefined
      ? { strategy: values, problem: 'unsuitable_column' }
      : { strategy }
  }
  for (const name of ['version', 'updated_at']) {
    const column = find(name)
    if (column === undefined || isExcluded(column.name)) continue
    const strategy = strategyOf(column)
    if (strategy !== undefined && (name === 'version') === (strategy.kind === 'version')) {
      return { strategy }
    }
  }
  return { strategy: values }
}
