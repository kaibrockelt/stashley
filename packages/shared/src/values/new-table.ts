// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { CatalogColumn } from '../api/connections.ts'
import type { FieldError } from '../api/errors.ts'
import type { NewTableColumn, NewTableDefinition } from '../api/imports.ts'
import { valueKind } from './column-kinds.ts'
import { isValidNewName } from './names.ts'
import { checkNewColumnType, type NewColumnType } from './type-inference.ts'

/**
 * Checks of a new table (§17 step 7, E28), shared by the editor and the server. The server
 * builds its `CREATE TABLE` only from a definition that passes them, so every name, type,
 * length and default in the statement is one of a few fixed forms.
 */

/** InnoDB indexes at most 3072 bytes per column, which is 768 utf8mb4 characters. */
export const maxKeyCharacters = 768
/** MySQL and MariaDB refuse rows above this many bytes (TEXT counts with its pointer). */
export const maxRowBytes = 65_535

const integerText = /^-?(0|[1-9]\d{0,19})$/
const decimalText = /^-?(\d+)(?:\.(\d+))?$/
const dateText = /^(\d{4})-(\d{2})-(\d{2})$/
const dateTimeText = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
/**
 * Text defaults: no control characters (C0, DEL, C1) and no backslash, so quoting cannot
 * depend on modes.
 */
function safeText(text: string): boolean {
  return [...text].every((char) => {
    const code = char.charCodeAt(0)
    return code >= 0x20 && !(code >= 0x7f && code <= 0x9f) && char !== '\\'
  })
}

const int32 = [-2147483648n, 2147483647n] as const
const int64 = [-9223372036854775808n, 9223372036854775807n] as const

function validDate(year: number, month: number, day: number): boolean {
  if (year < 1000 || month < 1 || month > 12 || day < 1) return false
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Why a default does not fit its column, or undefined. */
export function checkNewDefault(column: NewTableColumn): string | undefined {
  const value = column.default
  if (value === null) return undefined
  if (value.kind === 'now') return column.type === 'datetime' ? undefined : 'not_supported'
  const text = value.value
  switch (column.type) {
    case 'int':
    case 'bigint': {
      if (!integerText.test(text)) return 'invalid'
      const parsed = BigInt(text)
      const [min, max] = column.type === 'int' ? int32 : int64
      return parsed < min || parsed > max ? 'out_of_range' : undefined
    }
    case 'decimal': {
      const match = decimalText.exec(text)
      if (match === null) return 'invalid'
      const whole = (match[1] ?? '').replace(/^0+(?=\d)/, '')
      const fraction = match[2] ?? ''
      const scale = column.scale ?? 0
      const precision = column.precision ?? 10
      if (fraction.length > scale || whole.length > precision - scale) return 'out_of_range'
      return undefined
    }
    case 'boolean':
      return text === 'true' || text === 'false' ? undefined : 'invalid'
    case 'date': {
      const match = dateText.exec(text)
      return match !== null && validDate(Number(match[1]), Number(match[2]), Number(match[3]))
        ? undefined
        : 'invalid'
    }
    case 'datetime': {
      const match = dateTimeText.exec(text)
      if (match === null) return 'invalid'
      const [hour, minute, second] = [Number(match[4]), Number(match[5]), Number(match[6])]
      return validDate(Number(match[1]), Number(match[2]), Number(match[3])) &&
        hour < 24 &&
        minute < 60 &&
        second < 60
        ? undefined
        : 'invalid'
    }
    case 'varchar':
      if (!safeText(text)) return 'invalid'
      return [...text].length > (column.length ?? 0) ? 'too_long' : undefined
    case 'text':
      // MySQL accepts TEXT defaults only as expressions; Stashley offers none.
      return 'not_supported'
  }
}

function typeOf(column: NewTableColumn): NewColumnType {
  return {
    type: column.type,
    ...(column.length !== undefined && { length: column.length }),
    ...(column.precision !== undefined && { precision: column.precision }),
    ...(column.scale !== undefined && { scale: column.scale }),
  }
}

/** The bytes a column takes in a row at most, for the row size limit. */
function rowBytes(column: NewColumnType): number {
  switch (column.type) {
    case 'int':
      return 4
    case 'bigint':
      return 8
    case 'decimal':
      return Math.ceil((column.precision ?? 10) / 2) + 1
    case 'boolean':
      return 1
    case 'date':
      return 3
    case 'datetime':
      return 8
    case 'varchar':
      return (column.length ?? 0) * 4 + 2
    case 'text':
      return 12
  }
}

/** The column type text as the DDL writes it. */
export function columnTypeText(column: {
  type: NewColumnType['type']
  length?: number | undefined
  precision?: number | undefined
  scale?: number | undefined
}): string {
  switch (column.type) {
    case 'int':
      return 'INT'
    case 'bigint':
      return 'BIGINT'
    case 'decimal':
      return `DECIMAL(${column.precision ?? 10},${column.scale ?? 0})`
    case 'boolean':
      return 'BOOLEAN'
    case 'date':
      return 'DATE'
    case 'datetime':
      return 'DATETIME'
    case 'varchar':
      return `VARCHAR(${column.length ?? 255})`
    case 'text':
      return 'TEXT'
  }
}

/**
 * The definition's problems as field errors (`name`, `columns.3.default`, `primaryKey`, …).
 * `taken` lists object names that exist already; `sourceCount` the columns of the CSV file,
 * when the table is filled from one.
 */
export function checkNewTable(
  definition: NewTableDefinition,
  context: { taken: readonly string[]; sourceCount?: number | undefined },
): FieldError[] {
  const errors: FieldError[] = []
  const lower = (name: string) => name.toLowerCase()
  if (!isValidNewName(definition.name)) errors.push({ field: 'name', code: 'invalid_name' })
  else if (context.taken.some((name) => lower(name) === lower(definition.name))) {
    errors.push({ field: 'name', code: 'taken' })
  }

  const key = definition.primaryKey
  const names = new Set<string>()
  if (key.kind === 'added') {
    if (!isValidNewName(key.name)) errors.push({ field: 'primaryKey.name', code: 'invalid_name' })
    names.add(lower(key.name))
  }
  const sources = new Set<number>()
  let bytes = key.kind === 'added' ? 8 : 0
  definition.columns.forEach((column, index) => {
    const at = `columns.${index}`
    if (!isValidNewName(column.name)) errors.push({ field: `${at}.name`, code: 'invalid_name' })
    else if (names.has(lower(column.name))) errors.push({ field: `${at}.name`, code: 'duplicate' })
    names.add(lower(column.name))
    const type = typeOf(column)
    const typeProblem = checkNewColumnType(type)
    if (typeProblem !== undefined) errors.push({ field: `${at}.${typeProblem}`, code: 'invalid' })
    bytes += rowBytes(type)
    if (column.source !== null) {
      if (context.sourceCount === undefined || column.source >= context.sourceCount) {
        errors.push({ field: `${at}.source`, code: 'invalid' })
      } else if (sources.has(column.source)) {
        errors.push({ field: `${at}.source`, code: 'duplicate' })
      }
      sources.add(column.source)
    }
    const indexed = column.unique || (key.kind === 'column' && key.column === column.name)
    if (indexed && column.type === 'text') {
      errors.push({ field: `${at}.type`, code: 'not_indexable' })
    } else if (indexed && column.type === 'varchar' && (column.length ?? 0) > maxKeyCharacters) {
      errors.push({
        field: `${at}.length`,
        code: 'too_long_for_key',
        params: { max: maxKeyCharacters },
      })
    }
    const defaultProblem = checkNewDefault(column)
    if (defaultProblem !== undefined) errors.push({ field: `${at}.default`, code: defaultProblem })
    if (column.caseSensitive === true && column.type !== 'varchar' && column.type !== 'text') {
      errors.push({ field: `${at}.caseSensitive`, code: 'not_supported' })
    }
  })
  if (key.kind === 'column') {
    const column = definition.columns.find((entry) => entry.name === key.column)
    if (column === undefined) errors.push({ field: 'primaryKey.column', code: 'unknown_column' })
    else if (column.default !== null) {
      errors.push({ field: 'primaryKey.column', code: 'default_not_allowed' })
    }
  }
  if (bytes > maxRowBytes) errors.push({ field: 'columns', code: 'row_too_large' })
  return errors
}

/** The collation of text columns that compare case and accents (`caseSensitive`). */
export const caseSensitiveCollation = 'utf8mb4_bin'

/**
 * The catalog columns the table will have, so the import can check values before the table
 * exists (dry run) and write them without reading the catalog (the read user may not see the
 * table yet). `collation` is the one text columns get without `caseSensitive`.
 */
export function newTableCatalog(
  definition: NewTableDefinition,
  collation: string | null = null,
): CatalogColumn[] {
  const key = definition.primaryKey
  const columns: CatalogColumn[] = []
  if (key.kind === 'added') {
    columns.push({
      name: key.name,
      position: 1,
      dataType: 'bigint',
      columnType: 'bigint(20)',
      kind: 'bigint',
      nullable: false,
      defaultValue: null,
      autoIncrement: true,
      generated: false,
      onUpdate: null,
      maxLength: null,
      precision: 19,
      scale: 0,
    })
  }
  definition.columns.forEach((column) => {
    const isKey = key.kind === 'column' && key.column === column.name
    const dataType =
      column.type === 'boolean' ? 'tinyint' : column.type === 'decimal' ? 'decimal' : column.type
    const columnType =
      column.type === 'boolean'
        ? 'tinyint(1)'
        : column.type === 'decimal'
          ? `decimal(${column.precision ?? 10},${column.scale ?? 0})`
          : column.type === 'varchar'
            ? `varchar(${column.length ?? 255})`
            : column.type
    const value = column.default
    columns.push({
      name: column.name,
      position: columns.length + 1,
      dataType,
      columnType,
      kind: valueKind(dataType, columnType),
      nullable: !(column.required || isKey),
      defaultValue:
        value === null
          ? null
          : value.kind === 'now'
            ? 'current_timestamp()'
            : column.type === 'boolean'
              ? value.value === 'true'
                ? '1'
                : '0'
              : value.value,
      autoIncrement: false,
      generated: false,
      onUpdate: null,
      maxLength:
        column.type === 'varchar' ? (column.length ?? 255) : column.type === 'text' ? 65_535 : null,
      collation:
        column.type === 'varchar' || column.type === 'text'
          ? column.caseSensitive === true
            ? caseSensitiveCollation
            : collation
          : null,
      precision:
        column.type === 'decimal' ? (column.precision ?? 10) : column.type === 'int' ? 10 : null,
      scale: column.type === 'decimal' ? (column.scale ?? 0) : null,
    })
  })
  return columns
}
