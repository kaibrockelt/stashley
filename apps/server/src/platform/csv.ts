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
