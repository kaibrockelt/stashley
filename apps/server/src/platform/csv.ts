// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only

/** Cells starting with these characters are prefixed so spreadsheets do not run them. */
const formulaStart = /^[=+\-@\t\r]/

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text = typeof value === 'string' ? value : JSON.stringify(value)
  if (formulaStart.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function csvRow(values: unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`
}

/**
 * CSV for spreadsheets (E12): the delimiter and decimal separator follow the user's format,
 * `;` and `,` where the decimal separator is a comma. Dates stay ISO, date-times become wall
 * times in the instance time zone. Only text is defused against formulas; numbers stay
 * numbers, so `-5` is not turned into text.
 */
export interface ExportFormat {
  delimiter: ',' | ';'
  decimal: '.' | ','
  timeZone: string
}

export function exportFormat(locale: string, timeZone: string): ExportFormat {
  let decimal: '.' | ',' = '.'
  try {
    const part = new Intl.NumberFormat(locale)
      .formatToParts(1.5)
      .find((entry) => entry.type === 'decimal')
    if (part?.value === ',') decimal = ','
  } catch {
    // An unknown locale exports like en-US.
  }
  return { delimiter: decimal === ',' ? ';' : ',', decimal, timeZone }
}

const numericKinds = new Set(['integer', 'bigint', 'decimal', 'float', 'year'])

function quote(text: string, delimiter: string): string {
  return text.includes(delimiter) || /["\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function exportCell(value: unknown, kind: string, format: ExportFormat): string {
  if (value === null || value === undefined) return ''
  let text: string
  if (numericKinds.has(kind) && (typeof value === 'number' || typeof value === 'string')) {
    text = String(value)
    if (format.decimal === ',') text = text.replace('.', ',')
    return quote(text, format.delimiter)
  }
  if ((kind === 'datetime' || kind === 'timestamp') && typeof value === 'string') {
    const wall = Temporal.Instant.from(value).toZonedDateTimeISO(format.timeZone).toPlainDateTime()
    return wall.toString({ smallestUnit: 'second' }).replace('T', ' ')
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  text = Array.isArray(value)
    ? value.join(', ')
    : typeof value === 'string'
      ? value
      : JSON.stringify(value)
  if (formulaStart.test(text)) text = `'${text}`
  return quote(text, format.delimiter)
}

export function exportRow(cells: string[], format: ExportFormat): string {
  return `${cells.join(format.delimiter)}\r\n`
}
