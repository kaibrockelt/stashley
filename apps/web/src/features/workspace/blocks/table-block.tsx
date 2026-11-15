// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ColumnDisplay, ComponentResult, RenderComponent, TableResult } from '@stashley/shared'
import { parseSettings } from '@stashley/shared'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useT } from '../../../i18n/use-t.ts'
import { Button } from '../../../ui/controls.tsx'
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
 * server: keyset pages for table sources, the cached result for queries (§10.7). Editing
 * follows in M6.
 */
export function TableBlock(props: { component: RenderComponent }) {
  const t = useT()
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
  const options = { sort, search: debouncedSearch, cursor: cursors.at(-1), pageSize }
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

  let body
  let columns: DataColumn[] = []
  let rows: Record<string, unknown>[]
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
    body = (
      <>
        <LimitHint exceeded={false} truncated={'truncated' in result && result.truncated} />
        <DataTable
          caption={component.title}
          columns={columns}
          rows={rows}
          sort={sort}
          onSort={toggleSort}
          cell={
            link !== undefined && slug !== undefined
              ? (row, column, text) =>
                  column.id === columns[0]?.id ? (
                    <Link
                      to="/pages/$slug"
                      params={{ slug }}
                      search={{ [link.parameter]: row[link.column] }}
                    >
                      {text}
                    </Link>
                  ) : (
                    text
                  )
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
        searchable ? (
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
      {body}
    </BlockFrame>
  )
}
