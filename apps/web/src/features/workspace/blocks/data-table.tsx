// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ColumnFormat, ValueKind } from '@stashley/shared'
import type { ReactNode } from 'react'
import { useT } from '../../../i18n/use-t.ts'
import table from '../../../ui/table.module.css'
import { useValueFormatter } from '../format.ts'
import styles from './blocks.module.css'

export interface DataColumn {
  id: string
  label: string
  kind?: ValueKind | undefined
  format?: ColumnFormat | undefined
}

const numericKinds = new Set<ValueKind>(['integer', 'bigint', 'decimal', 'float'])

/** A read-only table of values, for table blocks and the table view of charts. */
export function DataTable(props: {
  caption: string
  columns: DataColumn[]
  rows: readonly Record<string, unknown>[]
  sort?: { columnId: string; direction: 'asc' | 'desc' } | null | undefined
  onSort?: ((columnId: string) => void) | undefined
  /** Renders a cell, e.g. as a row link; the formatted text is passed in. */
  cell?:
    | ((row: Record<string, unknown>, column: DataColumn, text: string, index: number) => ReactNode)
    | undefined
  /** A last column with actions per row, e.g. edit and delete. */
  actions?: { label: string; render: (index: number) => ReactNode } | undefined
}) {
  const t = useT()
  const formatValue = useValueFormatter()
  const sortLabel = (columnId: string) =>
    props.sort?.columnId !== columnId
      ? undefined
      : props.sort.direction === 'asc'
        ? 'ascending'
        : 'descending'
  if (props.rows.length === 0) return <p className={table.empty}>{t('block.empty')}</p>
  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <caption className={styles.visuallyHidden}>{props.caption}</caption>
        <thead>
          <tr>
            {props.columns.map((column) => {
              const numeric = column.kind !== undefined && numericKinds.has(column.kind)
              return (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={sortLabel(column.id)}
                  className={numeric ? styles.numeric : undefined}
                >
                  {props.onSort === undefined ? (
                    column.label
                  ) : (
                    <button
                      type="button"
                      className={styles.sortButton}
                      onClick={() => props.onSort?.(column.id)}
                    >
                      {column.label}
                      <span aria-hidden="true">
                        {sortLabel(column.id) === 'ascending'
                          ? '▲'
                          : sortLabel(column.id) === 'descending'
                            ? '▼'
                            : ''}
                      </span>
                    </button>
                  )}
                </th>
              )
            })}
            {props.actions !== undefined && (
              <th scope="col">
                <span className={styles.visuallyHidden}>{props.actions.label}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, index) => (
            <tr key={index}>
              {props.columns.map((column) => {
                const text = formatValue(row[column.id], column.kind, column.format)
                const numeric = column.kind !== undefined && numericKinds.has(column.kind)
                return (
                  <td key={column.id} className={numeric ? styles.numeric : undefined}>
                    {props.cell === undefined ? text : props.cell(row, column, text, index)}
                  </td>
                )
              })}
              {props.actions !== undefined && (
                <td className={styles.rowActions}>{props.actions.render(index)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
