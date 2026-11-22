// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { IdentityProvider } from '@stashley/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client.ts'
import { sessionKey } from '../../api/session.ts'
import { useErrorText } from '../../i18n/errors.ts'
import { useT } from '../../i18n/use-t.ts'
import {
  Actions,
  Badge,
  Button,
  CopyField,
  Dialog,
  Form,
  Notice,
  PageHeader,
  SwitchField,
  TextField,
} from '../../ui/controls.tsx'
import table from '../../ui/table.module.css'
import { ScrollArea } from '../../ui/scroll-area.tsx'

const providersKey = ['admin', 'identity-providers'] as const

function ProviderDialog(props: { provider: IdentityProvider | 'new'; onClose: () => void }) {
  const t = useT()
  const errors = useErrorText()
  const client = useQueryClient()
  const existing = props.provider === 'new' ? undefined : props.provider
  const [slug, setSlug] = useState(existing?.slug ?? '')
  const [name, setName] = useState(existing?.displayName ?? '')
  const [issuer, setIssuer] = useState(existing?.issuerUrl ?? '')
  const [clientId, setClientId] = useState(existing?.clientId ?? '')
  const [secret, setSecret] = useState('')
  const [scopes, setScopes] = useState(existing?.scopes ?? 'openid email profile')
  const [domains, setDomains] = useState(existing?.autoApproveDomains.join(', ') ?? '')
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: providersKey })
    await client.invalidateQueries({ queryKey: sessionKey })
  }
  const save = useMutation({
    mutationFn: () => {
      const body = {
        slug,
        displayName: name,
        issuerUrl: issuer,
        clientId,
        ...(secret !== '' && { clientSecret: secret }),
        scopes,
        autoApproveDomains: domains.split(/[\s,]+/).filter((domain) => domain !== ''),
        enabled,
      }
      return existing === undefined
        ? api('POST', '/internal/admin/identity-providers', body)
        : api('PUT', `/internal/admin/identity-providers/${existing.id}`, body)
    },
    onSuccess: async () => {
      await refresh()
      props.onClose()
    },
  })
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/internal/admin/identity-providers/${existing?.id ?? ''}`),
    onSuccess: async () => {
      await refresh()
      props.onClose()
    },
  })
  const error = save.error ?? remove.error
  return (
    <Dialog
      title={existing?.displayName ?? t('providers.add')}
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
    >
      <Form onSubmit={() => save.mutate()}>
        {error !== null && errors.message(error) !== undefined && (
          <Notice tone="error">{errors.message(error)}</Notice>
        )}
        <TextField
          label={t('field.displayName')}
          value={name}
          onChange={setName}
          error={errors.field(save.error, 'displayName')}
          isRequired
        />
        <TextField
          label={t('providers.slug')}
          value={slug}
          onChange={setSlug}
          description={t('providers.slug.hint')}
          error={errors.field(save.error, 'slug')}
          isRequired
        />
        <TextField
          label={t('providers.issuer')}
          type="url"
          value={issuer}
          onChange={setIssuer}
          error={errors.field(save.error, 'issuerUrl')}
          isRequired
        />
        <TextField
          label={t('providers.clientId')}
          value={clientId}
          onChange={setClientId}
          error={errors.field(save.error, 'clientId')}
          isRequired
        />
        <TextField
          label={t('providers.clientSecret')}
          type="password"
          autoComplete="off"
          value={secret}
          onChange={setSecret}
          {...(existing?.hasClientSecret === true && {
            description: t('providers.clientSecret.keep'),
          })}
          error={errors.field(save.error, 'clientSecret')}
        />
        <TextField
          label={t('providers.scopes')}
          value={scopes}
          onChange={setScopes}
          error={errors.field(save.error, 'scopes')}
          isRequired
        />
        <TextField
          label={t('providers.autoApprove')}
          value={domains}
          onChange={setDomains}
          description={t('providers.autoApprove.hint')}
          error={errors.field(save.error, 'autoApproveDomains')}
        />
        <SwitchField label={t('providers.enabled')} isSelected={enabled} onChange={setEnabled} />
        {existing !== undefined && (
          <CopyField label={t('providers.callback')} value={existing.callbackUrl} />
        )}
        <Actions>
          {existing !== undefined && (
            <Button variant="danger" onPress={() => remove.mutate()} isDisabled={remove.isPending}>
              {t('action.delete')}
            </Button>
          )}
          <Button onPress={props.onClose}>{t('action.cancel')}</Button>
          <Button type="submit" variant="primary" isDisabled={save.isPending}>
            {t('action.save')}
          </Button>
        </Actions>
      </Form>
    </Dialog>
  )
}

export function IdentityProvidersPage() {
  const t = useT()
  const [editing, setEditing] = useState<IdentityProvider | 'new'>()
  const providers = useQuery({
    queryKey: providersKey,
    queryFn: () => api<{ data: IdentityProvider[] }>('GET', '/internal/admin/identity-providers'),
  })
  return (
    <>
      <PageHeader
        title={t('providers.title')}
        actions={
          <Button variant="primary" onPress={() => setEditing('new')}>
            {t('providers.add')}
          </Button>
        }
      />
      <ScrollArea>
        <table className={table.table}>
          <thead>
            <tr>
              <th>{t('field.displayName')}</th>
              <th>{t('providers.issuer')}</th>
              <th>{t('providers.callback')}</th>
              <th>{t('field.status')}</th>
            </tr>
          </thead>
          <tbody>
            {providers.data?.data.map((provider) => (
              <tr key={provider.id}>
                <td>
                  <Button variant="ghost" onPress={() => setEditing(provider)}>
                    {provider.displayName}
                  </Button>
                </td>
                <td className={table.mono}>{provider.issuerUrl}</td>
                <td className={table.mono}>{provider.callbackUrl}</td>
                <td>
                  <Badge tone={provider.enabled ? 'success' : 'neutral'}>
                    {provider.enabled ? t('status.on') : t('status.off')}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {providers.data?.data.length === 0 && <p className={table.empty}>{t('providers.empty')}</p>}
      </ScrollArea>
      {editing !== undefined && (
        <ProviderDialog
          key={editing === 'new' ? 'new' : editing.id}
          provider={editing}
          onClose={() => setEditing(undefined)}
        />
      )}
    </>
  )
}
