// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { QueryResult, ResultColumn, ValueKind } from '@stashley/shared'
import { encodeValue } from '../../target/encoding.ts'
import type { FieldInfo } from '../../target/pools.ts'

const notNullFlag = 1
const primaryKeyFlag = 2
const enumFlag = 256
const setFlag = 2048
const binaryCharset = 63

const typeNames: Record<number, string> = {
  0: 'DECIMAL',
  1: 'TINYINT',
  2: 'SMALLINT',
  3: 'INT',
  4: 'FLOAT',
  5: 'DOUBLE',
  6: 'NULL',
  7: 'TIMESTAMP',
  8: 'BIGINT',
  9: 'MEDIUMINT',
  10: 'DATE',
  11: 'TIME',
  12: 'DATETIME',
  13: 'YEAR',
  14: 'DATE',
  15: 'VARCHAR',
  16: 'BIT',
  245: 'JSON',
  246: 'DECIMAL',
  247: 'ENUM',
  248: 'SET',
  249: 'TINYBLOB',
  250: 'MEDIUMBLOB',
  251: 'LONGBLOB',
  252: 'BLOB',
  253: 'VARCHAR',
  254: 'CHAR',
  255: 'GEOMETRY',
}

/** The value kind of a result column, from its protocol type (§9.5). */
export function fieldKind(field: FieldInfo): ValueKind {
  switch (field.columnType) {
    case 1:
      // TINYINT(1) is how both servers store booleans.
      return field.columnLength === 1 ? 'boolean' : 'integer'
    case 2:
    case 3:
    case 9:
      return 'integer'
    case 8:
      return 'bigint'
    case 13:
      return 'year'
    case 0:
    case 246:
      return 'decimal'
    case 4:
    case 5:
      return 'float'
    case 10:
    case 14:
      return 'date'
    case 12:
      return 'datetime'
    case 7:
      return 'timestamp'
    case 11:
      return 'time'
    case 245:
      return 'json'
    case 6:
      return 'string'
    case 247:
      return 'enum'
    case 248:
      return 'set'
    case 15:
    case 249:
    case 250:
    case 251:
    case 252:
    case 253:
    case 254:
      if (field.characterSet === binaryCharset) return 'unsupported'
      if ((field.flags & enumFlag) !== 0) return 'enum'
      if ((field.flags & setFlag) !== 0) return 'set'
      return 'string'
    default:
      return 'unsupported'
  }
}

const numericKinds = new Set<ValueKind>(['integer', 'bigint', 'decimal', 'float'])
const timeKinds = new Set<ValueKind>(['date', 'datetime', 'timestamp', 'year'])

/** The inferred role (§ Ergebnisformen); managers can override it per block. */
export function inferRole(
  name: string,
  kind: ValueKind,
  primaryKey: boolean,
): ResultColumn['role'] {
  const integer = kind === 'integer' || kind === 'bigint'
  if (integer && (primaryKey || name === 'id' || name.endsWith('_id'))) return 'identifier'
  if (numericKinds.has(kind)) return 'measure'
  if (timeKinds.has(kind)) return 'time'
  return 'category'
}

/** Column names unique within the result; a repeated name gets a numbered suffix. */
function uniqueNames(fields: FieldInfo[]): string[] {
  const seen = new Map<string, number>()
  return fields.map((field) => {
    const count = (seen.get(field.name) ?? 0) + 1
    seen.set(field.name, count)
    return count === 1 ? field.name : `${field.name}_${count}`
  })
}

export function resultColumns(fields: FieldInfo[]): ResultColumn[] {
  const names = uniqueNames(fields)
  return fields.map((field, index) => {
    const kind = fieldKind(field)
    const name = names[index] as string
    return {
      name,
      type: typeNames[field.columnType] ?? 'UNKNOWN',
      kind,
      nullable: (field.flags & notNullFlag) === 0,
      role: inferRole(field.name, kind, (field.flags & primaryKeyFlag) !== 0),
    }
  })
}

/**
 * Encodes driver rows as JSON values (§9.5) and cuts them to the limit; one row beyond it
 * marks the result as truncated. Binary values are never returned.
 */
export function normalizeResult(
  rows: unknown[][],
  fields: FieldInfo[],
  limit: number,
  timeZone: string,
): QueryResult & { size: number } {
  const columns = resultColumns(fields)
  const truncated = rows.length > limit
  const invalidRows: number[] = []
  let size = 0
  const encoded = rows.slice(0, limit).map((row, rowIndex) => {
    const out: Record<string, unknown> = {}
    let invalid = false
    columns.forEach((column, index) => {
      const raw = row[index]
      const value =
        raw instanceof Uint8Array || column.kind === 'unsupported'
          ? { value: null }
          : encodeValue(column.kind, raw as string | number | null | undefined, timeZone)
      if (value.invalid === true) invalid = true
      out[column.name] = value.value
    })
    if (invalid) invalidRows.push(rowIndex)
    size += JSON.stringify(out).length
    return out
  })
  return {
    columns,
    rows: encoded,
    truncated,
    ...(invalidRows.length > 0 && { invalidRows }),
    size: size * 2,
  }
}
