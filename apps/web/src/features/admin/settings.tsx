// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { InstanceSettings } from '@stashley/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client.ts'
import { sessionKey } from '../../api/session.ts'
import { useErrorText } from '../../i18n/errors.ts'
import { useT } from '../../i18n/use-t.ts'
import {
  Actions,
  Button,
  Form,
  Notice,
  PageHeader,
  Section,
  SwitchField,
  TextField,
} from '../../ui/controls.tsx'

const settingsKey = ['admin', 'settings'] as const

function SettingsForm(props: { settings: InstanceSettings }) {
  const t = useT()
  const errors = useErrorText()
  const client = useQueryClient()
  const [values, setValues] = useState(props.settings)
  const set = <K extends keyof InstanceSettings>(key: K, value: InstanceSettings[K]) =>
    setValues((current) => ({ ...current, [key]: value }))
  const number = (key: 'sessionIdleMinutes' | 'sessionMaxAgeDays' | 'auditRetentionDays') => ({
    value: String(values[key]),
    onChange: (value: string) => set(key, Number.parseInt(value, 10) || 0),
    type: 'number' as const,
    inputMode: 'numeric' as const,
  })
  const save = useMutation({
    mutationFn: () => api<InstanceSettings>('PATCH', '/internal/admin/settings', values),
    onSuccess: async (result) => {
      client.setQueryData(settingsKey, result)
      await client.invalidateQueries({ queryKey: sessionKey })
    },
  })
  const error = save.error
  return (
    <Form onSubmit={() => save.mutate()}>
      {save.isSuccess && <Notice tone="success">{t('notice.saved')}</Notice>}
      {error !== null && errors.message(error) !== undefined && (
        <Notice tone="error">{errors.message(error)}</Notice>
      )}
      <Section title={t('settings.section.signIn')}>
        <SwitchField
          label={t('settings.localLogin')}
          description={t('settings.localLogin.hint')}
          isSelected={values.localLoginEnabled}
          onChange={(value) => set('localLoginEnabled', value)}
          error={errors.field(error, 'localLoginEnabled')}
        />
        <SwitchField
          label={t('settings.enforceMfa')}
          isSelected={values.twoFactorEnforced}
          onChange={(value) => set('twoFactorEnforced', value)}
        />
        <TextField
          label={t('settings.sessionIdle')}
          {...number('sessionIdleMinutes')}
          error={errors.field(error, 'sessionIdleMinutes')}
        />
        <TextField
          label={t('settings.sessionMaxAge')}
          {...number('sessionMaxAgeDays')}
          error={errors.field(error, 'sessionMaxAgeDays')}
        />
      </Section>
      <Section title={t('settings.section.audit')}>
        <TextField
          label={t('settings.auditRetention')}
          {...number('auditRetentionDays')}
          error={errors.field(error, 'auditRetentionDays')}
        />
      </Section>
      <Actions>
        <Button type="submit" variant="primary" isDisabled={save.isPending}>
          {t('action.save')}
        </Button>
      </Actions>
    </Form>
  )
}

export function SettingsPage() {
  const t = useT()
  const settings = useQuery({
    queryKey: settingsKey,
    queryFn: () => api<InstanceSettings>('GET', '/internal/admin/settings'),
  })
  return (
    <>
      <PageHeader title={t('settings.title')} />
      {settings.data !== undefined && <SettingsForm settings={settings.data} />}
    </>
  )
}
