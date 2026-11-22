// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  CatalogObject,
  CatalogSnapshot,
  Connection,
  Relation,
  SchemaDrift,
  SchemaRefreshResult,
  TableAccess,
} from '@stashley/shared'
import { features } from '@stashley/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { api, ApiError } from '../../../api/client.ts'
import { useErrorText } from '../../../i18n/errors.ts'
import { useFormatDateTime } from '../../../i18n/format.ts'
import { useT } from '../../../i18n/use-t.ts'
import { Badge, Button, Notice, PageHeader } from '../../../ui/controls.tsx'
import { NewTableDialog } from '../tables/table-editor.tsx'
import table from '../../../ui/table.module.css'
import { AccessDialog } from './access-dialog.tsx'
import { ConnectionDialog } from './connection-dialog.tsx'
import styles from './connections.module.css'
import { RelationDialog } from './relation-dialog.tsx'
import {
  AccessWarnings,
  connectionsKey,
  DiffSummary,
  failureLabels,
  GrantSummary,
  ImpactList,
  opLabels,
  purposeLabels,
  relationKindLabels,
  tlsLabels,
} from './texts.tsx'
import { UserScopePanel } from './user-scope.tsx'
import { ScrollArea } from '../../../ui/scroll-area.tsx'

function useConnectionData(id: string) {
  const key = ['admin', 'connection', id] as const
  const connection = useQuery({
    queryKey: [...key, 'details'],
    queryFn: () => api<Connection>('GET', `/internal/admin/connections/${id}`),
  })
  const schema = useQuery({
    queryKey: [...key, 'schema'],
    queryFn: async () => {
      try {
        return await api<CatalogSnapshot>('GET', `/internal/admin/connections/${id}/schema`)
      } catch (error) {
        if (error instanceof ApiError && error.code === 'not_found') return null
        throw error
      }
    },
  })
  const access = useQuery({
    queryKey: [...key, 'access'],
    queryFn: () =>
      api<{ data: TableAccess[] }>('GET', `/internal/admin/table-access?connectionId=${id}`),
  })
  const relations = useQuery({
    queryKey: [...key, 'relations'],
    queryFn: () => api<{ data: Relation[] }>('GET', `/internal/admin/relations?connectionId=${id}`),
  })
  const drifts = useQuery({
    queryKey: [...key, 'drifts'],
    queryFn: () =>
      api<{ data: SchemaDrift[] }>('GET', `/internal/admin/connections/${id}/schema/drifts`),
  })
  return { key, connection, schema, access, relations, drifts }
}

function Section(props: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{props.title}</h2>
        {props.aside}
      </div>
      {props.children}
    </section>
  )
}

export function ConnectionPage() {
  const t = useT()
  const errors = useErrorText()
  const formatDate = useFormatDateTime()
  const client = useQueryClient()
  const navigate = useNavigate()
  const params: { connectionId?: string } = useParams({ strict: false })
  const connectionId = params.connectionId ?? ''
  const data = useConnectionData(connectionId)
  const [editing, setEditing] = useState(false)
  const [sharing, setSharing] = useState<CatalogObject>()
  const [addingRelation, setAddingRelation] = useState(false)
  const [designing, setDesigning] = useState(false)
  const [refreshResult, setRefreshResult] = useState<SchemaRefreshResult>()
  const invalidate = async () => {
    await client.invalidateQueries({ queryKey: data.key })
    await client.invalidateQueries({ queryKey: connectionsKey })
  }
  const recheck = useMutation({
    mutationFn: () => api('POST', `/internal/admin/connections/${connectionId}/grants`),
    onSuccess: invalidate,
  })
  const refresh = useMutation({
    mutationFn: () =>
      api<SchemaRefreshResult>(
        'POST',
        `/internal/admin/connections/${connectionId}/schema/refresh`,
      ),
    onSuccess: async (result) => {
      setRefreshResult(result)
      await invalidate()
    },
  })
  const acknowledge = useMutation({
    mutationFn: (driftId: string) =>
      api(
        'POST',
        `/internal/admin/connections/${connectionId}/schema/drifts/${driftId}/acknowledge`,
      ),
    onSuccess: invalidate,
  })
  const removeRelation = useMutation({
    mutationFn: (id: string) => api('DELETE', `/internal/admin/relations/${id}`),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/internal/admin/connections/${connectionId}`),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: connectionsKey })
      await navigate({ to: '/admin/connections' })
    },
  })

  const connection = data.connection.data
  if (connection === undefined) return null
  const accesses = data.access.data?.data ?? []
  const objects = data.schema.data?.objects ?? []
  const accessOf = (name: string) => accesses.find((entry) => entry.objectName === name)
  const missingObjects = accesses.filter(
    (entry) => !objects.some((object) => object.name === entry.objectName),
  )
  const error = recheck.error ?? refresh.error ?? remove.error ?? removeRelation.error
  const openDrifts = (data.drifts.data?.data ?? []).filter((drift) => drift.acknowledgedAt === null)

  return (
    <>
      <PageHeader
        title={connection.name}
        actions={
          <div className={styles.badges}>
            <Button onPress={() => setEditing(true)}>{t('action.edit')}</Button>
            <Button onPress={() => recheck.mutate()} isDisabled={recheck.isPending}>
              {t('connections.recheck')}
            </Button>
            <Button onPress={() => refresh.mutate()} isDisabled={refresh.isPending}>
              {t('connections.refresh')}
            </Button>
            {connection.credentials.some((credential) => credential.purpose === 'schema') && (
              <Button onPress={() => setDesigning(true)}>{t('tables.new')}</Button>
            )}
            <Button variant="danger" onPress={() => remove.mutate()} isDisabled={remove.isPending}>
              {t('action.delete')}
            </Button>
          </div>
        }
      />
      {error !== null && errors.message(error) !== undefined && (
        <Notice tone="error">
          {errors.message(error)}
          {error instanceof ApiError &&
            error.errors.map((entry) => ` ${errors.field(error, entry.field) ?? ''}`).join('')}
        </Notice>
      )}
      {connection.schemaCheck.failure !== null && (
        <Notice tone="error">
          {t('connections.schemaCheck.failed', {
            time: formatDate(connection.schemaCheck.checkedAt),
            reason: t(failureLabels[connection.schemaCheck.failure]),
          })}
        </Notice>
      )}
      <dl className={styles.facts}>
        <div>
          <dt>{t('connections.address')}</dt>
          <dd className={styles.mono}>
            {connection.host}:{String(connection.port)}/{connection.databaseName}
          </dd>
        </div>
        <div>
          <dt>{t('connections.server')}</dt>
          <dd>
            {connection.engine === 'mariadb' ? 'MariaDB' : 'MySQL'} {connection.serverVersion ?? ''}
          </dd>
        </div>
        <div>
          <dt>{t('connections.tls')}</dt>
          <dd>{t(tlsLabels[connection.tls.mode])}</dd>
        </div>
        <div>
          <dt>{t('connections.timezone')}</dt>
          <dd>{connection.timezone}</dd>
        </div>
        <div>
          <dt>{t('connections.schema.read')}</dt>
          <dd>{formatDate(connection.schemaCapturedAt)}</dd>
        </div>
      </dl>
      {connection.versionSupported === false && (
        <Notice tone="info">{t('connections.version.unsupported')}</Notice>
      )}

      <Section title={t('connections.users')}>
        <div className={styles.grid}>
          {connection.credentials.map((credential) => (
            <div key={credential.purpose} className={styles.block}>
              <div className={styles.blockHead}>
                <h3 className={styles.blockTitle}>{t(purposeLabels[credential.purpose])}</h3>
                <span className={styles.mono}>{credential.username}</span>
              </div>
              <GrantSummary report={credential.grants} />
              <p className={styles.muted}>
                {t('connections.checkedAt', { time: formatDate(credential.checkedAt) })}
              </p>
            </div>
          ))}
        </div>
        {(['read', 'write'] as const)
          .filter((purpose) =>
            connection.credentials.some((credential) => credential.purpose === purpose),
          )
          .map((purpose) => (
            <div key={purpose} className={styles.block}>
              <UserScopePanel connectionId={connectionId} purpose={purpose} />
            </div>
          ))}
      </Section>

      {(refreshResult !== undefined || openDrifts.length > 0) && (
        <Section title={t('drift.title')}>
          {refreshResult !== undefined && (
            <div className={styles.block}>
              <p className={styles.blockTitle}>{t('drift.refresh')}</p>
              {refreshResult.changed ? (
                <>
                  <DiffSummary diff={refreshResult.diff} />
                  <ImpactList impact={refreshResult.impact} />
                </>
              ) : (
                <p className={styles.muted}>{t('drift.unchanged')}</p>
              )}
            </div>
          )}
          {openDrifts.map((drift) => (
            <div key={drift.id} className={styles.block}>
              <div className={styles.blockHead}>
                <p className={styles.blockTitle}>
                  {t('drift.detected', { time: formatDate(drift.detectedAt) })}
                </p>
                <Button
                  onPress={() => acknowledge.mutate(drift.id)}
                  isDisabled={acknowledge.isPending}
                >
                  {t('drift.acknowledge')}
                </Button>
              </div>
              <DiffSummary diff={drift.diff} />
              <ImpactList impact={drift.impact} />
            </div>
          ))}
        </Section>
      )}

      <Section title={t('access.title')}>
        <p className={styles.muted}>{t('access.hint')}</p>
        <ScrollArea>
          <table className={table.table}>
            <thead>
              <tr>
                <th>{t('access.object')}</th>
                <th>{t('access.type')}</th>
                <th>{t('access.rows')}</th>
                <th>{t('access.ceiling')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {objects.map((object) => {
                const access = accessOf(object.name)
                return (
                  <tr key={object.name}>
                    <td className={table.mono}>{object.name}</td>
                    <td>
                      {object.type === 'view' ? t('access.type.view') : t('access.type.table')}
                    </td>
                    <td className={table.muted}>
                      {object.rowEstimate === null ? '–' : String(object.rowEstimate)}
                    </td>
                    <td>
                      {access === undefined ? (
                        <span className={table.muted}>{t('access.notShared')}</span>
                      ) : (
                        <div className={styles.badges}>
                          {access.ops.map((op) => (
                            <Badge key={op} tone="accent">
                              {t(opLabels[op])}
                            </Badge>
                          ))}
                          {features.mcp && access.mcpEnabled && (
                            <Badge>{t('access.mcp.badge')}</Badge>
                          )}
                          {access.warnings.length > 0 && (
                            <Badge tone="warning">
                              {t('access.warnings', { count: access.warnings.length })}
                            </Badge>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      <Button variant="ghost" onPress={() => setSharing(object)}>
                        {access === undefined ? t('access.share') : t('action.edit')}
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {data.schema.data === null && <p className={table.empty}>{t('access.noSchema')}</p>}
        </ScrollArea>
        {missingObjects.map((entry) => (
          <Notice key={entry.id} tone="error">
            {t('access.missing', { object: entry.objectName })}
            <AccessWarnings warnings={entry.warnings} />
          </Notice>
        ))}
      </Section>

      <Section
        title={t('relations.title')}
        aside={
          <Button onPress={() => setAddingRelation(true)} isDisabled={objects.length === 0}>
            {t('relations.add')}
          </Button>
        }
      >
        <ScrollArea>
          <table className={table.table}>
            <thead>
              <tr>
                <th>{t('relations.source')}</th>
                <th>{t('relations.target')}</th>
                <th>{t('relations.kind')}</th>
                <th>{t('relations.origin')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data.relations.data?.data ?? []).map((relation) => (
                <tr key={relation.id ?? relation.name}>
                  <td className={table.mono}>
                    {relation.sourceObject}.{relation.sourceColumn}
                  </td>
                  <td className={table.mono}>
                    {relation.targetObject}.{relation.targetColumn}
                  </td>
                  <td>{t(relationKindLabels[relation.kind])}</td>
                  <td>
                    {relation.origin === 'constraint'
                      ? t('relations.origin.constraint')
                      : t('relations.origin.virtual')}
                  </td>
                  <td>
                    {relation.id !== null && (
                      <Button
                        variant="ghost"
                        onPress={() => removeRelation.mutate(relation.id ?? '')}
                        isDisabled={removeRelation.isPending}
                      >
                        {t('action.delete')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.relations.data?.data.length === 0 && (
            <p className={table.empty}>{t('relations.empty')}</p>
          )}
        </ScrollArea>
      </Section>

      {editing && <ConnectionDialog connection={connection} onClose={() => setEditing(false)} />}
      {sharing !== undefined && (
        <AccessDialog
          key={sharing.name}
          connectionId={connectionId}
          object={sharing}
          access={accessOf(sharing.name)}
          onClose={() => setSharing(undefined)}
        />
      )}
      {addingRelation && (
        <RelationDialog
          connectionId={connectionId}
          objects={objects}
          onClose={() => setAddingRelation(false)}
        />
      )}
      {designing && (
        <NewTableDialog connectionId={connection.id} onClose={() => setDesigning(false)} />
      )}
    </>
  )
}
