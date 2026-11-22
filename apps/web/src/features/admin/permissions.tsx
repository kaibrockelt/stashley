// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import {
  authenticatedPrincipal,
  type Connection,
  type PermissionEntry,
  type Role,
} from '@stashley/shared'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client.ts'
import { useT } from '../../i18n/use-t.ts'
import { Badge, PageHeader, SelectField } from '../../ui/controls.tsx'
import { StateView } from '../../ui/state.tsx'
import table from '../../ui/table.module.css'
import { opLabels } from './connections/texts.tsx'
import { ScrollArea } from '../../ui/scroll-area.tsx'

const all = '__all'

/**
 * Who may do what on which table, through which page and component (§8.7). Derived from the
 * published pages; nothing here is edited.
 */
export function PermissionsPage() {
  const t = useT()
  const [object, setObject] = useState(all)
  const [principal, setPrincipal] = useState(all)
  const [page, setPage] = useState(all)
  const entries = useQuery({
    queryKey: ['admin', 'permissions'],
    queryFn: () => api<{ data: PermissionEntry[] }>('GET', '/internal/admin/permissions'),
  })
  const roles = useQuery({
    queryKey: ['design', 'roles'],
    queryFn: () => api<{ data: Role[] }>('GET', '/internal/design/roles'),
  })
  const connections = useQuery({
    queryKey: ['admin', 'connections'],
    queryFn: () => api<{ data: Connection[] }>('GET', '/internal/admin/connections'),
  })
  const data = entries.data?.data ?? []
  const roleName = (id: string) =>
    id === authenticatedPrincipal
      ? t('editor.everyone')
      : (roles.data?.data.find((role) => role.id === id)?.name ?? t('permissions.deletedRole'))
  const connectionName = (id: string) =>
    connections.data?.data.find((connection) => connection.id === id)?.name ?? ''
  const objectKey = (entry: PermissionEntry) => `${entry.connectionId}/${entry.object}`
  const objectLabel = (entry: PermissionEntry) =>
    (connections.data?.data.length ?? 0) > 1
      ? `${connectionName(entry.connectionId)} · ${entry.object}`
      : entry.object

  const unique = <T,>(items: T[], key: (item: T) => string) => [
    ...new Map(items.map((item) => [key(item), item])).values(),
  ]
  const objectOptions = unique(data, objectKey)
    .map((entry) => ({ id: objectKey(entry), label: objectLabel(entry) }))
    .sort((a, b) => a.label.localeCompare(b.label))
  const principalOptions = unique(data, (entry) => entry.principal)
    .map((entry) => ({ id: entry.principal, label: roleName(entry.principal) }))
    .sort((a, b) => a.label.localeCompare(b.label))
  const pageOptions = unique(data, (entry) => entry.pageId)
    .map((entry) => ({ id: entry.pageId, label: entry.pageTitle }))
    .sort((a, b) => a.label.localeCompare(b.label))

  const shown = data
    .filter(
      (entry) =>
        (object === all || objectKey(entry) === object) &&
        (principal === all || entry.principal === principal) &&
        (page === all || entry.pageId === page),
    )
    .sort(
      (a, b) =>
        objectLabel(a).localeCompare(objectLabel(b)) ||
        roleName(a.principal).localeCompare(roleName(b.principal)) ||
        a.pageTitle.localeCompare(b.pageTitle) ||
        a.componentTitle.localeCompare(b.componentTitle),
    )

  return (
    <>
      <PageHeader title={t('permissions.title')} />
      <div className={table.toolbar}>
        <SelectField
          label={t('permissions.table')}
          value={object}
          onChange={setObject}
          options={[{ id: all, label: t('permissions.all') }, ...objectOptions]}
        />
        <SelectField
          label={t('permissions.role')}
          value={principal}
          onChange={setPrincipal}
          options={[{ id: all, label: t('permissions.all') }, ...principalOptions]}
        />
        <SelectField
          label={t('permissions.page')}
          value={page}
          onChange={setPage}
          options={[{ id: all, label: t('permissions.all') }, ...pageOptions]}
        />
      </div>
      {entries.isSuccess && data.length === 0 ? (
        <StateView title={t('permissions.empty')} />
      ) : (
        <ScrollArea>
          <table className={table.table}>
            <thead>
              <tr>
                <th scope="col">{t('permissions.table')}</th>
                <th scope="col">{t('permissions.role')}</th>
                <th scope="col">{t('permissions.page')}</th>
                <th scope="col">{t('permissions.component')}</th>
                <th scope="col">{t('permissions.ops')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((entry) => (
                <tr
                  key={`${objectKey(entry)}:${entry.principal}:${entry.pageId}:${entry.componentId}`}
                >
                  <td className={table.mono}>{objectLabel(entry)}</td>
                  <td>{roleName(entry.principal)}</td>
                  <td>{entry.pageTitle}</td>
                  <td>{entry.componentTitle}</td>
                  <td>
                    {entry.ops.map((op) => (
                      <Badge key={op} tone="accent">
                        {t(opLabels[op])}
                      </Badge>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollArea>
      )}
    </>
  )
}
