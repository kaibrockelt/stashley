// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ColumnDisplay,
  ComponentResult,
  RenderComponent,
  TableResult,
  TableRow,
} from '@stashley/shared'
import { parseSettings } from '@stashley/shared'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useT } from '../../../i18n/use-t.ts'
import { download } from '../../../api/client.ts'
import { Button, Notice } from '../../../ui/controls.tsx'
import { DeleteDialog, InlineCell, RowDialog } from '../form/row-editing.tsx'
import { useWriteErrors } from '../form/write-errors.ts'
import { modeFields, usePageContext } from '../page-context.tsx'
import { useDebounced } from '../../../ui/use-debounced.ts'
import { useNavigation } from '../api.ts'
import { BlockFrame, BlockState, FreshnessLine, LimitHint } from './block-frame.tsx'
import workspace from '../workspace.module.css'
import styles from './blocks.module.css'
import { DataTable, type DataColumn } from './data-table.tsx'
import { useComponentCount, useComponentData } from './use-component.ts'

/** Slugs of pages by ID, for row links. */
function usePageSlugs(): Map<string, string> {
  const navigation = useNavigation()
  const map = new Map<string, string>()
  for (const section of navigation.data?.sections ?? [])
    for (const page of section.pages) map.set(page.id, page.slug)
  for (const page of navigation.data?.pages ?? []) map.set(page.id, page.slug)
  return map
}

/**
 * A stored query or a table source (§ Blöcke: Tabelle). Sorting, search and paging run on the
 * server: keyset pages for table sources, the cached result for queries (§10.7). Table sources
 * with editing create, edit (inline or in a dialog) and delete rows within the caller's
 * rights; tables export as CSV while the caller may read (§ Tabellenseiten).
 */
export function TableBlock(props: {
  component: RenderComponent
  /** Related tables of a detail view read the rows of this record. */
  record?: string
  /** The main table of a table page with a detail view links its rows there. */
  detailSlug?: string
}) {
  const t = useT()
  const context = usePageContext()
  const writeErrors = useWriteErrors()
  const [dialog, setDialog] = useState<
    | { kind: 'create' }
    | { kind: 'edit'; key: unknown }
    | { kind: 'delete'; key: unknown; label: string }
    | null
  >(null)
  const [exportError, setExportError] = useState<unknown>(null)
  const component = props.component
  const settings = parseSettings('table', component.settings)
  const value = settings.ok ? settings.value : {}
  const tableSource = component.sourceKind === 'table'
  const [sort, setSort] = useState(component.table?.sort ?? undefined)
  const [search, setSearch] = useState('')
  // Every search is a read on the target database: wait until the user pauses typing.
  const debouncedSearch = useDebounced(search.trim())
  const [cursors, setCursors] = useState<string[]>([])
  const pageSize = value.pageSize ?? component.table?.pageSize ?? 50
  const options = {
    sort,
    search: debouncedSearch,
    cursor: cursors.at(-1),
    pageSize,
    ...(props.record !== undefined && { record: props.record }),
  }
  const { query, refresh } = useComponentData<ComponentResult | TableResult>(component.id, options)
  const count = useComponentCount(component.id, options, tableSource)
  const slugs = usePageSlugs()
  const searchable = tableSource ? component.table?.searchable === true : value.searchable === true

  const reset = () => setCursors([])
  const toggleSort = (columnId: string) => {
    setSort((current) =>
      current?.columnId === columnId
        ? { columnId, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { columnId, direction: 'asc' },
    )
    reset()
  }

  const editing = component.table?.editing
  const canDelete = editing?.ops.includes('delete') === true
  const canEditRow = editing?.ops.includes('update') === true && editing.dialog
  const canCreate = editing?.ops.includes('create') === true
  const exportable =
    component.ops.includes('read') &&
    (tableSource ? component.table?.csvExport === true : value.csvExport !== false)

  let body
  let columns: DataColumn[] = []
  let rows: Record<string, unknown>[]
  let tableRows: TableRow[] = []
  if (!settings.ok) body = <BlockState kind="error" />
  else if (query.isPending) body = <BlockState kind="loading" />
  else if (query.isError) body = <BlockState kind="error" />
  else {
    const result = query.data
    if (tableSource) {
      const table = result as TableResult
      columns = table.columns.map((column) => ({
        id: column.id,
        label: column.label ?? column.id,
        kind: column.kind,
        format: value.formats?.[column.id],
      }))
      tableRows = table.rows
      rows = table.rows.map((row) => row.values)
    } else {
      const queryResult = result as ComponentResult
      const shown: ColumnDisplay[] =
        value.columns ?? queryResult.columns.map((column) => ({ column: column.name }))
      columns = shown.map((entry) => ({
        id: entry.column,
        label: entry.label ?? value.labels?.[entry.column] ?? entry.column,
        kind: queryResult.columns.find((column) => column.name === entry.column)?.kind,
        format: entry.format ?? value.formats?.[entry.column],
      }))
      rows = queryResult.rows
    }
    const link = value.rowLink
    const slug = link === undefined ? undefined : slugs.get(link.pageId)
    const inline = new Map(
      editing?.inline === true
        ? (component.table?.columns ?? []).flatMap((column) => {
            const field = editing.fields.find((entry) => entry.id === column.field)
            return field === undefined ? [] : [[column.id, field] as const]
          })
        : [],
    )
    const keyText = (key: unknown) =>
      typeof key === 'string' || typeof key === 'number' ? String(key) : ''
    body = (
      <>
        <LimitHint exceeded={false} truncated={'truncated' in result && result.truncated} />
        <DataTable
          caption={component.title}
          columns={columns}
          rows={rows}
          sort={sort}
          onSort={toggleSort}
          cell={(row, column, text, index) => {
            const key = tableRows[index]?.key
            const field = inline.get(column.id)
            if (field !== undefined && key !== undefined) {
              return <InlineCell component={component} field={field} rowKey={key} text={text} />
            }
            if (column.id !== columns[0]?.id) return text
            if (props.detailSlug !== undefined && key !== undefined) {
              return (
                <Link
                  to="/pages/$slug/$recordKey"
                  params={{ slug: props.detailSlug, recordKey: keyText(key) }}
                  search={{
                    ...(context.mode !== 'runtime' && { mode: context.mode }),
                    ...(context.roles.length > 0 && { roles: context.roles.join(',') }),
                  }}
                >
                  {text}
                </Link>
              )
            }
            if (link !== undefined && slug !== undefined) {
              return (
                <Link
                  to="/pages/$slug"
                  params={{ slug }}
                  search={{ [link.parameter]: row[link.column] }}
                >
                  {text}
                </Link>
              )
            }
            return text
          }}
          actions={
            canDelete || canEditRow
              ? {
                  label: t('table.actions'),
                  render: (index) => {
                    const row = tableRows[index]
                    if (row === undefined) return null
                    const label = keyText(row.values[columns[0]?.id ?? ''] ?? row.key)
                    return (
                      <span className={styles.rowButtons}>
                        {canEditRow && (
                          <Button
                            variant="ghost"
                            aria-label={t('table.editRowOf', { row: label })}
                            onPress={() => setDialog({ kind: 'edit', key: row.key })}
                          >
                            {t('table.edit')}
                          </Button>
                        )}
                        {canDelete && (
                          <Button
                            variant="ghost"
                            aria-label={t('table.deleteRowOf', { row: label })}
                            onPress={() => setDialog({ kind: 'delete', key: row.key, label })}
                          >
                            {t('table.delete')}
                          </Button>
                        )}
                      </span>
                    )
                  },
                }
              : undefined
          }
        />
      </>
    )
  }
  const result = query.data
  const total = tableSource
    ? count.data?.count
    : result !== undefined && 'total' in result
      ? result.total
      : undefined
  return (
    <BlockFrame
      component={component}
      tools={
        searchable || exportable || canCreate ? (
          <>
            {searchable && (
              <input
                type="search"
                className={workspace.nativeInput}
                aria-label={t('table.search')}
                placeholder={t('table.search')}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  reset()
                }}
              />
            )}
            {exportable && (
              <Button
                variant="ghost"
                onPress={() => {
                  setExportError(null)
                  download(`/internal/pages/${context.page.id}/components/${component.id}/export`, {
                    ...modeFields(context),
                    filters: context.filters,
                    params: context.params,
                    ...(sort !== undefined && { sort }),
                    ...(debouncedSearch !== '' && { search: debouncedSearch }),
                    ...(props.record !== undefined && { record: props.record }),
                  }).catch(setExportError)
                }}
              >
                {t('table.export')}
              </Button>
            )}
            {canCreate && (
              <Button variant="primary" onPress={() => setDialog({ kind: 'create' })}>
                {t('table.newRow')}
              </Button>
            )}
          </>
        ) : undefined
      }
      footer={
        <>
          <div className={styles.pager}>
            <span role="status">
              {total !== undefined && total !== null
                ? t(count.data?.approximate === true ? 'table.totalApprox' : 'table.total', {
                    count: total,
                  })
                : ''}
            </span>
            <span>
              <Button
                variant="ghost"
                isDisabled={cursors.length === 0}
                onPress={() => setCursors((list) => list.slice(0, -1))}
              >
                {t('table.previous')}
              </Button>
              <Button
                variant="ghost"
                isDisabled={result?.nextCursor == null}
                onPress={() => {
                  const next = result?.nextCursor
                  if (next !== null && next !== undefined) setCursors((list) => [...list, next])
                }}
              >
                {t('table.next')}
              </Button>
            </span>
          </div>
          <FreshnessLine
            freshness={result}
            onRefresh={() => refresh.mutate()}
            refreshing={refresh.isPending}
            refreshError={refresh.error}
          />
        </>
      }
    >
      {exportError !== null && <Notice tone="error">{writeErrors.message(exportError)}</Notice>}
      {body}
      {dialog?.kind === 'create' && (
        <RowDialog component={component} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'edit' && (
        <RowDialog component={component} rowKey={dialog.key} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteDialog
          component={component}
          rowKey={dialog.key}
          label={dialog.label}
          onClose={() => setDialog(null)}
        />
      )}
    </BlockFrame>
  )
}
