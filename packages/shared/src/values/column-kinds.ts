// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a column's values travel as JSON (architecture §9.5). The server encodes and decodes;
 * the client uses the kind to pick editors and formats.
 */
export const valueKinds = [
  'boolean',
  'integer',
  'bigint',
  'decimal',
  'float',
  'date',
  'datetime',
  'timestamp',
  'time',
  'year',
  'string',
  'enum',
  'set',
  'json',
  'unsupported',
] as const
export type ValueKind = (typeof valueKinds)[number]

const kindsByType: Record<string, ValueKind> = {
  bool: 'boolean',
  boolean: 'boolean',
  tinyint: 'integer',
  smallint: 'integer',
  mediumint: 'integer',
  int: 'integer',
  integer: 'integer',
  bigint: 'bigint',
  decimal: 'decimal',
  numeric: 'decimal',
  float: 'float',
  double: 'float',
  real: 'float',
  date: 'date',
  datetime: 'datetime',
  timestamp: 'timestamp',
  time: 'time',
  year: 'year',
  char: 'string',
  varchar: 'string',
  tinytext: 'string',
  text: 'string',
  mediumtext: 'string',
  longtext: 'string',
  uuid: 'string',
  inet4: 'string',
  inet6: 'string',
  enum: 'enum',
  set: 'set',
  json: 'json',
}

/** Maps `information_schema.COLUMNS` DATA_TYPE and COLUMN_TYPE to a value kind. */
export function valueKind(dataType: string, columnType: string): ValueKind {
  const type = dataType.toLowerCase()
  if (type === 'tinyint' && /^tinyint\(1\)/i.test(columnType)) return 'boolean'
  return kindsByType[type] ?? 'unsupported'
}

/** Kinds whose values read as text, used for the default display template. */
export function isTextKind(kind: ValueKind): boolean {
  return kind === 'string' || kind === 'enum'
}

/** Values of an `enum(...)` or `set(...)` column type, unquoted. */
export function enumValues(columnType: string): string[] {
  const match = /^(?:enum|set)\((.*)\)$/is.exec(columnType.trim())
  if (match === null) return []
  const values: string[] = []
  const pattern = /'((?:[^'\\]|''|\\.)*)'/g
  for (const item of (match[1] ?? '').matchAll(pattern)) {
    values.push((item[1] ?? '').replace(/''/g, "'").replace(/\\(.)/g, '$1'))
  }
  return values
}
