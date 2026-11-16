// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { RenderPage, TableRow } from '@stashley/shared'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams, useSearch } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { api, ApiError } from '../../api/client.ts'
import { useUser } from '../../api/session.ts'
import { useT } from '../../i18n/use-t.ts'
import { Button } from '../../ui/controls.tsx'
import { StateView } from '../../ui/state.tsx'
import stateStyles from '../../ui/state.module.css'
import { useRenderPage } from './api.ts'
import { BlockFrame, BlockState } from './blocks/block-frame.tsx'
import { TableBlock } from './blocks/table-block.tsx'
import { useValueFormatter } from './format.ts'
import { RowDialog } from './form/row-editing.tsx'
import { PageContextProvider, type PageContextValue } from './page-context.tsx'
import { modeOf, splitSearch, type PageSearch } from './page-view.tsx'
import styles from './workspace.module.css'
import form from './form/form.module.css'

/** The shown record: the main table's columns of one row, within its base filter. */
function RecordPanel(props: { page: RenderPage; context: PageContextValue; recordKey: string }) {
  const t = useT()
  const formatValue = useValueFormatter()
  const [editing, setEditing] = useState(false)
  const table = props.page.table
  const query = new URLSearchParams({
    ...(props.context.mode !== 'runtime' && { mode: props.context.mode }),
    ...(props.context.roles.length > 0 && { roles: props.context.roles.join(',') }),
  })
  const row = useQuery({
    queryKey: [
      'workspace',
      'component',
      props.page.id,
      table?.id,
      'row',
      props.recordKey,
      query.toString(),
    ],
    queryFn: () =>
      api<TableRow>(
        'GET',
        `/internal/pages/${props.page.id}/components/${table?.id ?? ''}/rows/${encodeURIComponent(props.recordKey)}?${query}`,
      ),
    enabled: table !== null,
    retry: false,
  })
  if (table === null) return null
  const editable =
    table.table?.editing?.ops.includes('update') === true && table.table.editing.dialog
  return (
    <BlockFrame
      component={{ ...table, title: t('detail.record') }}
      tools={
        editable ? <Button onPress={() => setEditing(true)}>{t('table.edit')}</Button> : undefined
      }
    >
      {row.isPending ? (
        <BlockState kind="loading" />
      ) : row.isError ? (
        <BlockState
          kind={row.error instanceof ApiError && row.error.status === 404 ? 'empty' : 'error'}
        />
      ) : (
        <dl className={form.extras}>
          {(table.table?.columns ?? []).map((column) => (
            <div key={column.id}>
              <dt>{column.label ?? column.id}</dt>
              <dd>{formatValue(row.data.values[column.id], column.kind)}</dd>
            </div>
          ))}
        </dl>
      )}
      {editing && (
        <RowDialog component={table} rowKey={props.recordKey} onClose={() => setEditing(false)} />
      )}
    </BlockFrame>
  )
}

/**
 * The detail view of a table page (§ Tabellenseiten): one record with the records of other
 * tables that refer to it, each a component with its own rights.
 */
export function DetailView() {
  const t = useT()
  const user = useUser()
  const params: { slug?: string; recordKey?: string } = useParams({ strict: false })
  const search: PageSearch = useSearch({ strict: false })
  const { mode, roles } = modeOf(search)
  const page = useRenderPage(params.slug ?? '', mode, roles)
  const split = useMemo(
    () => (page.data === undefined ? undefined : splitSearch(page.data, search)),
    [page.data, search],
  )
  if (page.isPending) return <StateView title={t('block.loading')} mascot={false} />
  if (page.isError || page.data.kind !== 'table') {
    return (
      <StateView title={t('notFound.title')}>
        <Link to="/" className={stateStyles.action}>
          {t('notFound.action')}
        </Link>
      </StateView>
    )
  }
  const recordKey = params.recordKey ?? ''
  const context: PageContextValue = {
    page: page.data,
    mode,
    roles,
    filters: split?.filters ?? {},
    params: split?.params ?? {},
    designer: user.systemRole === 'admin' || user.systemRole === 'manager',
  }
  return (
    <PageContextProvider value={context}>
      <div className={styles.page}>
        <header className={styles.header}>
          <div>
            <Link
              to="/pages/$slug"
              params={{ slug: page.data.slug }}
              search={{
                ...(mode !== 'runtime' && { mode }),
                ...(roles.length > 0 && { roles: roles.join(',') }),
              }}
            >
              ← {page.data.title}
            </Link>
            <h1 className={styles.title}>{t('detail.title', { key: recordKey })}</h1>
          </div>
        </header>
        <div className={styles.grid}>
          <RecordPanel page={page.data} context={context} recordKey={recordKey} />
          {page.data.detail.map((component) => (
            <TableBlock key={component.id} component={component} record={recordKey} />
          ))}
        </div>
      </div>
    </PageContextProvider>
  )
}
