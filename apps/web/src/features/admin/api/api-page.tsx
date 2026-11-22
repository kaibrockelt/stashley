// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ApiEndpointBlocker,
  ApiEndpointState,
  ApiOperation,
  ApiToken,
  ApiTokenCreated,
  ApiTokenGrant,
} from '@stashley/shared'
import { apiOperations, defaultApiRateLimit } from '@stashley/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../api/client.ts'
import { useErrorText } from '../../../i18n/errors.ts'
import { useFormatDateTime } from '../../../i18n/format.ts'
import type { MessageId } from '../../../i18n/locale.ts'
import { useT } from '../../../i18n/use-t.ts'
import {
  Actions,
  Badge,
  Button,
  CheckboxField,
  CopyField,
  Dialog,
  Form,
  Notice,
  PageHeader,
  Section,
  TextAreaField,
  TextField,
} from '../../../ui/controls.tsx'
import table from '../../../ui/table.module.css'
import styles from '../connections/connections.module.css'
import { opLabels } from '../connections/texts.tsx'
import { apiOperationLabels, ConsequencesNotice, consequencesOf } from './consequences.tsx'
import { ScrollArea } from '../../../ui/scroll-area.tsx'

const endpointsKey = ['admin', 'api', 'endpoints'] as const
const tokensKey = ['admin', 'api', 'tokens'] as const

const blockerLabels: Record<ApiEndpointBlocker, MessageId> = {
  alias_is_object_name: 'api.blocker.alias',
  no_single_key: 'api.blocker.key',
  not_active: 'api.blocker.inactive',
}

/** Short labels for the table; the dialog explains them in full. */
const blockerBadges: Record<ApiEndpointBlocker, MessageId> = {
  alias_is_object_name: 'api.blocker.alias.short',
  no_single_key: 'api.blocker.key.short',
  not_active: 'api.blocker.inactive.short',
}

const iso = (time: number | null) => (time === null ? null : new Date(time).toISOString())

/** A time as the date of the browser's time zone, as a date field shows it. */
function localDate(time: number): string {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function EndpointDialog(props: { state: ApiEndpointState; onClose: () => void }) {
  const t = useT()
  const errors = useErrorText()
  const client = useQueryClient()
  const { state } = props
  const [enabled, setEnabled] = useState<ApiOperation[]>(state.enabled)
  const save = useMutation({
    mutationFn: (confirm?: string) =>
      api('PUT', `/internal/admin/api/endpoints/${state.tableAccessId}`, {
        operations: enabled,
        ...(confirm !== undefined && { confirm }),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['admin', 'api'] })
      props.onClose()
    },
  })
  const consequences = consequencesOf(save.error)
  const blocked = state.blockers.length > 0
  return (
    <Dialog title={state.apiResource} isOpen onOpenChange={(open) => !open && props.onClose()}>
      <Form onSubmit={() => save.mutate(undefined)}>
        {consequences !== undefined ? (
          <ConsequencesNotice
            consequences={consequences.consequences}
            onConfirm={() => save.mutate(consequences.confirmation)}
            onCancel={() => save.reset()}
            isPending={save.isPending}
          />
        ) : (
          save.error !== null &&
          errors.message(save.error) !== undefined && (
            <Notice tone="error">{errors.message(save.error)}</Notice>
          )
        )}
        <p className={styles.muted}>
          {t('api.endpoint.object', {
            object: `${state.connectionName}.${state.objectName}`,
            ceiling: state.ceiling.map((op) => t(opLabels[op])).join(', '),
          })}
        </p>
        {state.blockers.map((blocker) => (
          <Notice key={blocker} tone="info">
            {t(blockerLabels[blocker])}
          </Notice>
        ))}
        <div className={styles.checks}>
          {apiOperations.map((operation) => {
            const available = state.available.includes(operation)
            const on = enabled.includes(operation)
            return (
              <CheckboxField
                key={operation}
                label={t(apiOperationLabels[operation])}
                isSelected={on}
                // Beyond the ceiling an endpoint cannot be enabled (§16); blocked ones only close.
                isDisabled={(!available && !on) || (blocked && !on)}
                onChange={(selected) =>
                  setEnabled((current) =>
                    apiOperations.filter((entry) =>
                      entry === operation ? selected : current.includes(entry),
                    ),
                  )
                }
              />
            )
          })}
        </div>
        {errors.field(save.error, 'operations') !== undefined && (
          <p className={styles.danger}>{errors.field(save.error, 'operations')}</p>
        )}
        <p className={styles.muted}>{t('api.endpoint.hint')}</p>
        <Actions>
          <Button onPress={props.onClose}>{t('action.cancel')}</Button>
          <Button type="submit" variant="primary" isDisabled={save.isPending}>
            {t('action.save')}
          </Button>
        </Actions>
      </Form>
    </Dialog>
  )
}

function grantKey(grant: ApiTokenGrant): string {
  return `${grant.tableAccessId}:${grant.operation}`
}

function TokenDialog(props: {
  token: ApiToken | undefined
  endpoints: ApiEndpointState[]
  onClose: () => void
}) {
  const t = useT()
  const errors = useErrorText()
  const client = useQueryClient()
  const { token } = props
  const [name, setName] = useState(token?.name ?? '')
  const storedExpiry = token?.expiresAt ?? null
  const storedDate = storedExpiry === null ? '' : localDate(storedExpiry)
  const [expires, setExpires] = useState(storedDate)
  const [allowlist, setAllowlist] = useState((token?.ipAllowlist ?? []).join('\n'))
  const [limit, setLimit] = useState(String(token?.rateLimitPerMinute ?? defaultApiRateLimit))
  const [grants, setGrants] = useState<Set<string>>(new Set((token?.grants ?? []).map(grantKey)))
  const [secret, setSecret] = useState<string>()
  const open = props.endpoints.filter((state) => state.enabled.length > 0)
  const body = () => ({
    name,
    // The end of the chosen day in the browser's time zone; an unchanged date keeps the
    // stored time, so saving never moves the expiry.
    expiresAt:
      expires === ''
        ? null
        : expires === storedDate && storedExpiry !== null
          ? storedExpiry
          : new Date(`${expires}T23:59:59`).getTime(),
    ipAllowlist: allowlist
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
    rateLimitPerMinute: Number(limit),
    grants: [...grants].map((key) => {
      const [tableAccessId = '', operation = ''] = key.split(':')
      return { tableAccessId, operation }
    }),
  })
  const save = useMutation({
    mutationFn: (): Promise<ApiTokenCreated | ApiToken> =>
      token === undefined
        ? api<ApiTokenCreated>('POST', '/internal/admin/api/tokens', body())
        : api<ApiToken>('PUT', `/internal/admin/api/tokens/${token.id}`, body()),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: tokensKey })
      if ('secret' in result) setSecret(result.secret)
      else props.onClose()
    },
  })
  const revoke = useMutation({
    mutationFn: () => api('POST', `/internal/admin/api/tokens/${token?.id ?? ''}/revoke`),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: tokensKey })
      props.onClose()
    },
  })
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const toggle = (key: string, selected: boolean) =>
    setGrants((current) => {
      const next = new Set(current)
      if (selected) next.add(key)
      else next.delete(key)
      return next
    })

  if (secret !== undefined) {
    return (
      <Dialog title={name} isOpen onOpenChange={(isOpen) => !isOpen && props.onClose()}>
        <Notice tone="success">{t('api.token.created')}</Notice>
        <CopyField label={t('api.token.secret')} value={secret} />
        <p className={styles.muted}>{t('api.token.once')}</p>
        <Actions>
          <Button variant="primary" onPress={props.onClose}>
            {t('action.done')}
          </Button>
        </Actions>
      </Dialog>
    )
  }

  const error = save.error ?? revoke.error
  const revoked = token?.revokedAt !== null && token !== undefined
  return (
    <Dialog
      title={token === undefined ? t('api.token.new') : token.name}
      isOpen
      isWide
      onOpenChange={(isOpen) => !isOpen && props.onClose()}
    >
      <Form onSubmit={() => save.mutate()}>
        {error !== null && errors.message(error) !== undefined && (
          <Notice tone="error">{errors.message(error)}</Notice>
        )}
        {revoked && <Notice tone="info">{t('api.token.revokedNotice')}</Notice>}
        <div className={styles.grid}>
          <TextField
            label={t('field.name')}
            value={name}
            onChange={setName}
            error={errors.field(save.error, 'name')}
            isRequired
            autoFocus
          />
          <TextField
            label={t('api.token.expires')}
            value={expires}
            onChange={setExpires}
            type="date"
            description={t('api.token.expires.hint')}
            error={errors.field(save.error, 'expiresAt')}
          />
          <TextField
            label={t('api.token.rateLimit')}
            value={limit}
            onChange={setLimit}
            inputMode="numeric"
            description={t('api.token.rateLimit.hint')}
            error={errors.field(save.error, 'rateLimitPerMinute')}
          />
        </div>
        <TextAreaField
          label={t('api.token.allowlist')}
          value={allowlist}
          onChange={setAllowlist}
          rows={3}
          description={t('api.token.allowlist.hint')}
          error={
            body()
              .ipAllowlist.map((_, index) => errors.field(save.error, `ipAllowlist.${index}`))
              .find((message) => message !== undefined) ?? undefined
          }
        />
        <div className={styles.block}>
          <p className={styles.blockTitle}>{t('api.token.grants')}</p>
          <p className={styles.muted}>{t('api.token.grants.hint')}</p>
          {open.length === 0 ? (
            <p className={table.empty}>{t('api.token.grants.none')}</p>
          ) : (
            <ScrollArea>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th>{t('api.resource')}</th>
                    {apiOperations.map((operation) => (
                      <th key={operation}>{t(apiOperationLabels[operation])}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {open.map((state) => (
                    <tr key={state.tableAccessId}>
                      <td className={table.mono}>{state.apiResource}</td>
                      {apiOperations.map((operation) => {
                        const key = `${state.tableAccessId}:${operation}`
                        return (
                          <td key={operation}>
                            {state.enabled.includes(operation) && (
                              <CheckboxField
                                isLabelHidden
                                label={t('api.token.grant', {
                                  resource: state.apiResource,
                                  operation: t(apiOperationLabels[operation]),
                                })}
                                isSelected={grants.has(key)}
                                onChange={(selected) => toggle(key, selected)}
                              />
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>
          )}
        </div>
        {confirmRevoke && <Notice tone="info">{t('api.token.revoke.confirm')}</Notice>}
        <Actions>
          {token !== undefined &&
            !revoked &&
            (confirmRevoke ? (
              <Button
                variant="danger"
                onPress={() => revoke.mutate()}
                isDisabled={revoke.isPending}
              >
                {t('api.token.revoke')}
              </Button>
            ) : (
              <Button variant="ghost" onPress={() => setConfirmRevoke(true)}>
                {t('api.token.revoke')}
              </Button>
            ))}
          <Button onPress={props.onClose}>{t('action.cancel')}</Button>
          {!revoked && (
            <Button type="submit" variant="primary" isDisabled={save.isPending}>
              {token === undefined ? t('api.token.create') : t('action.save')}
            </Button>
          )}
        </Actions>
      </Form>
    </Dialog>
  )
}

async function downloadDocument(): Promise<null> {
  const document = await api<unknown>('GET', '/internal/admin/api/openapi')
  const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' })
  const link = window.document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = 'stashley-openapi.json'
  link.click()
  URL.revokeObjectURL(link.href)
  return null
}

/** The public REST API (§16): endpoints per table access and tokens. */
export function ApiPage() {
  const t = useT()
  const formatDate = useFormatDateTime()
  const endpoints = useQuery({
    queryKey: endpointsKey,
    queryFn: () => api<{ data: ApiEndpointState[] }>('GET', '/internal/admin/api/endpoints'),
  })
  const tokens = useQuery({
    queryKey: tokensKey,
    queryFn: () => api<{ data: ApiToken[] }>('GET', '/internal/admin/api/tokens'),
  })
  const [endpoint, setEndpoint] = useState<ApiEndpointState>()
  const [token, setToken] = useState<ApiToken>()
  const [creating, setCreating] = useState(false)
  const [now] = useState(() => Date.now())
  const errorText = useErrorText()
  const download = useMutation({ mutationFn: downloadDocument })
  const states = endpoints.data?.data ?? []
  const resourceOf = (id: string) =>
    states.find((state) => state.tableAccessId === id)?.apiResource ?? '?'
  const status = (entry: ApiToken) => {
    if (entry.revokedAt !== null) return <Badge tone="danger">{t('api.token.revoked')}</Badge>
    if (entry.expiresAt !== null && entry.expiresAt < now) {
      return <Badge tone="warning">{t('api.token.expired')}</Badge>
    }
    return <Badge tone="success">{t('api.token.active')}</Badge>
  }
  return (
    <>
      <PageHeader
        title={t('api.title')}
        actions={
          <Button onPress={() => download.mutate()} isDisabled={download.isPending}>
            {t('api.openapi.download')}
          </Button>
        }
      />
      {download.error !== null && <Notice tone="error">{errorText.message(download.error)}</Notice>}
      <p className={styles.muted}>{t('api.intro')}</p>
      <Section title={t('api.endpoints')}>
        <ScrollArea>
          <table className={table.table}>
            <thead>
              <tr>
                <th>{t('api.resource')}</th>
                <th>{t('api.object')}</th>
                <th>{t('api.enabled')}</th>
                <th>{t('api.state')}</th>
              </tr>
            </thead>
            <tbody>
              {states.map((state) => (
                <tr key={state.tableAccessId}>
                  <td>
                    <Button variant="ghost" onPress={() => setEndpoint(state)}>
                      <code>{state.apiResource}</code>
                    </Button>
                  </td>
                  <td className={table.muted}>
                    {state.connectionName}.{state.objectName}
                  </td>
                  <td>
                    {state.enabled.length === 0
                      ? t('api.closed')
                      : state.enabled.map((op) => t(apiOperationLabels[op])).join(', ')}
                  </td>
                  <td>
                    {state.blockers.map((blocker) => (
                      <Badge key={blocker} tone="warning">
                        {t(blockerBadges[blocker])}
                      </Badge>
                    ))}
                    {state.withheld.length > 0 && (
                      <Badge tone="danger">
                        {t('api.withheld', {
                          operations: state.withheld
                            .map((op) => t(apiOperationLabels[op]))
                            .join(', '),
                        })}
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {states.length === 0 && <p className={table.empty}>{t('api.endpoints.empty')}</p>}
        </ScrollArea>
      </Section>
      <Section
        title={t('api.tokens')}
        aside={
          <Button variant="primary" onPress={() => setCreating(true)}>
            {t('api.token.new')}
          </Button>
        }
      >
        <ScrollArea>
          <table className={table.table}>
            <thead>
              <tr>
                <th>{t('field.name')}</th>
                <th>{t('api.token.hint')}</th>
                <th>{t('api.token.grants')}</th>
                <th>{t('api.token.lastUsed')}</th>
                <th>{t('api.token.requests')}</th>
                <th>{t('api.state')}</th>
              </tr>
            </thead>
            <tbody>
              {tokens.data?.data.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <Button variant="ghost" onPress={() => setToken(entry)}>
                      {entry.name}
                    </Button>
                  </td>
                  <td className={table.mono}>…{entry.hint}</td>
                  <td className={table.muted}>
                    {entry.grants
                      .map(
                        (grant) =>
                          `${resourceOf(grant.tableAccessId)}: ${t(apiOperationLabels[grant.operation])}`,
                      )
                      .join(', ')}
                  </td>
                  <td className={table.muted}>
                    {entry.lastUsedAt === null
                      ? t('api.token.never')
                      : formatDate(iso(entry.lastUsedAt))}
                  </td>
                  <td>{entry.requestCount}</td>
                  <td>{status(entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {tokens.data?.data.length === 0 && <p className={table.empty}>{t('api.tokens.empty')}</p>}
        </ScrollArea>
      </Section>
      {endpoint !== undefined && (
        <EndpointDialog state={endpoint} onClose={() => setEndpoint(undefined)} />
      )}
      {(creating || token !== undefined) && (
        <TokenDialog
          token={token}
          endpoints={states}
          onClose={() => {
            setCreating(false)
            setToken(undefined)
          }}
        />
      )}
    </>
  )
}
