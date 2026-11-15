// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { PageMode, RenderPage } from '@stashley/shared'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useMemo, type ReactNode } from 'react'
import { ApiError } from '../../api/client.ts'
import { useUser } from '../../api/session.ts'
import { useT } from '../../i18n/use-t.ts'
import { StateView } from '../../ui/state.tsx'
import stateStyles from '../../ui/state.module.css'
import { useRenderPage } from './api.ts'
import { Block } from './blocks/block.tsx'
import { PageFilters } from './filters.tsx'
import { rowSpans } from './grid-layout.ts'
import { PageContextProvider, type PageContextValue } from './page-context.tsx'
import styles from './workspace.module.css'

export type PageSearch = Record<string, unknown>

/** Filter values live in the URL as `f.<filterId>`, URL parameters under their names (§13.6). */
export function splitSearch(page: RenderPage, search: PageSearch) {
  const filters: Record<string, unknown> = {}
  const params: Record<string, unknown> = {}
  for (const filter of page.filters) {
    const value = search[`f.${filter.id}`]
    if (value !== undefined && value !== '') filters[filter.id] = value
  }
  for (const parameter of page.parameters) {
    const value = search[parameter.name]
    if (value !== undefined && value !== '') params[parameter.name] = value
  }
  return { filters, params }
}

export function modeOf(search: PageSearch): { mode: PageMode; roles: string[] } {
  const mode = search.mode === 'edit' || search.mode === 'preview' ? search.mode : 'runtime'
  const roles =
    mode === 'preview' && typeof search.roles === 'string' && search.roles !== ''
      ? search.roles.split(',')
      : []
  return { mode, roles }
}

/** Rows of 1–4 blocks on a 12-column grid; missing blocks leave their width to the rest. */
export function PageGrid(props: {
  page: RenderPage
  renderBlock?: (component: RenderPage['rows'][number]['components'][number]) => ReactNode
}) {
  const render = props.renderBlock ?? ((component) => <Block component={component} />)
  if (props.page.table !== null)
    return <div className={styles.grid}>{render(props.page.table)}</div>
  return (
    <div className={styles.grid}>
      {props.page.rows.map((row) => {
        if (row.components.length === 0) return null
        const spans = rowSpans(row.layout, row.components.length)
        return (
          <div key={row.id} className={styles.row}>
            {row.components.map((component, index) => (
              <div
                key={component.id}
                className={styles.cell}
                style={{ gridColumn: `span ${spans[index] ?? 12}` }}
              >
                {render(component)}
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

export function PageView(props: { toolbar?: (page: RenderPage) => ReactNode }) {
  const t = useT()
  const user = useUser()
  const params: { slug?: string } = useParams({ strict: false })
  const slug = params.slug ?? ''
  const search: PageSearch = useSearch({ strict: false })
  const navigate = useNavigate()
  const { mode, roles } = modeOf(search)
  const page = useRenderPage(slug, mode, roles)
  const designer = user.systemRole === 'admin' || user.systemRole === 'manager'
  const split = useMemo(
    () => (page.data === undefined ? undefined : splitSearch(page.data, search)),
    [page.data, search],
  )

  if (page.isPending) return <StateView title={t('block.loading')} mascot={false} />
  if (page.isError) {
    const notFound = page.error instanceof ApiError && page.error.status === 404
    return (
      <StateView title={notFound ? t('notFound.title') : t('error.title')}>
        <Link to="/" className={stateStyles.action}>
          {t('notFound.action')}
        </Link>
      </StateView>
    )
  }
  const context: PageContextValue = {
    page: page.data,
    mode,
    roles,
    filters: split?.filters ?? {},
    params: split?.params ?? {},
    designer,
  }
  const setFilter = (id: string, value: unknown) =>
    void navigate({
      to: '.',
      search: (current: PageSearch) => {
        const next = { ...current }
        if (value === undefined) delete next[`f.${id}`]
        else next[`f.${id}`] = value
        return next
      },
      replace: true,
    })
  return (
    <PageContextProvider value={context}>
      <div className={styles.page}>
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>{page.data.title}</h1>
            {page.data.description !== undefined && page.data.description !== '' && (
              <p className={styles.description}>{page.data.description}</p>
            )}
          </div>
          {props.toolbar?.(page.data)}
        </header>
        <PageFilters onChange={setFilter} />
        <PageGrid page={page.data} />
      </div>
    </PageContextProvider>
  )
}
