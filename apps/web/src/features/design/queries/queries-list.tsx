// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { Link } from '@tanstack/react-router'
import { useFormatDateTime } from '../../../i18n/format.ts'
import { useT } from '../../../i18n/use-t.ts'
import { Badge, buttonClass, PageHeader } from '../../../ui/controls.tsx'
import table from '../../../ui/table.module.css'
import { useDesignConnections, useQueries } from '../design-api.ts'
import { useTtlLabel } from './ttl.ts'

/** The query library (§10.1): named, versioned queries shared by blocks. */
export function QueriesListPage() {
  const t = useT()
  const formatDate = useFormatDateTime()
  const ttlLabel = useTtlLabel()
  const queries = useQueries()
  const connections = useDesignConnections()
  const connectionName = (id: string) =>
    connections.data?.find((entry) => entry.id === id)?.name ?? id
  return (
    <>
      <PageHeader
        title={t('queries.title')}
        actions={
          <Link
            to="/design/queries/$queryId"
            params={{ queryId: 'new' }}
            className={buttonClass('primary')}
          >
            {t('queries.new')}
          </Link>
        }
      />
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr>
              <th>{t('field.name')}</th>
              <th>{t('queries.column.connection')}</th>
              <th>{t('queries.column.mode')}</th>
              <th>{t('queries.column.version')}</th>
              <th>{t('queries.column.cache')}</th>
              <th>{t('queries.column.updated')}</th>
            </tr>
          </thead>
          <tbody>
            {(queries.data ?? []).map((query) => (
              <tr key={query.id}>
                <td>
                  <Link to="/design/queries/$queryId" params={{ queryId: query.id }}>
                    {query.name}
                  </Link>
                  {query.description !== '' && (
                    <div className={table.muted}>{query.description}</div>
                  )}
                </td>
                <td>{connectionName(query.connectionId)}</td>
                <td>
                  <Badge>
                    {query.mode === 'builder' ? t('queries.mode.builder') : t('queries.mode.sql')}
                  </Badge>
                </td>
                <td>{query.latestVersion}</td>
                <td>{ttlLabel(query.cacheTtlSeconds)}</td>
                <td>{formatDate(query.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {queries.data?.length === 0 && <p className={table.empty}>{t('queries.empty')}</p>}
      </div>
    </>
  )
}
