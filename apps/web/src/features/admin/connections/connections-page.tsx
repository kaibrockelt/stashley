// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Connection } from '@stashley/shared'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { api } from '../../../api/client.ts'
import { useT } from '../../../i18n/use-t.ts'
import { Badge, Button, PageHeader } from '../../../ui/controls.tsx'
import table from '../../../ui/table.module.css'
import { ConnectionDialog } from './connection-dialog.tsx'
import styles from './connections.module.css'
import { connectionsKey, GrantBadge } from './texts.tsx'
import { ScrollArea } from '../../../ui/scroll-area.tsx'

export function ConnectionsPage() {
  const t = useT()
  const [adding, setAdding] = useState(false)
  const connections = useQuery({
    queryKey: connectionsKey,
    queryFn: () => api<{ data: Connection[] }>('GET', '/internal/admin/connections'),
  })
  return (
    <>
      <PageHeader
        title={t('connections.title')}
        actions={
          <Button variant="primary" onPress={() => setAdding(true)}>
            {t('connections.add')}
          </Button>
        }
      />
      <ScrollArea>
        <table className={table.table}>
          <thead>
            <tr>
              <th>{t('field.displayName')}</th>
              <th>{t('connections.database')}</th>
              <th>{t('connections.server')}</th>
              <th>{t('connections.grants')}</th>
              <th>{t('connections.schema')}</th>
            </tr>
          </thead>
          <tbody>
            {connections.data?.data.map((connection) => (
              <tr key={connection.id}>
                <td>
                  <Link
                    to="/admin/connections/$connectionId"
                    params={{ connectionId: connection.id }}
                  >
                    {connection.name}
                  </Link>
                </td>
                <td className={table.mono}>
                  {connection.host}:{String(connection.port)}/{connection.databaseName}
                </td>
                <td>
                  <div className={styles.badges}>
                    <span>
                      {connection.engine === 'mariadb' ? 'MariaDB' : 'MySQL'}{' '}
                      {connection.serverVersion ?? ''}
                    </span>
                    {connection.versionSupported === false && (
                      <Badge tone="warning">{t('connections.version.untested')}</Badge>
                    )}
                  </div>
                </td>
                <td>
                  <GrantBadge
                    reports={connection.credentials.map((credential) => credential.grants)}
                  />
                </td>
                <td>
                  {connection.openDrifts > 0 ? (
                    <Badge tone="warning">
                      {t('connections.drifts', { count: connection.openDrifts })}
                    </Badge>
                  ) : (
                    <Badge>{t('connections.schema.current')}</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {connections.data?.data.length === 0 && (
          <p className={table.empty}>{t('connections.empty')}</p>
        )}
      </ScrollArea>
      {adding && <ConnectionDialog onClose={() => setAdding(false)} />}
    </>
  )
}
