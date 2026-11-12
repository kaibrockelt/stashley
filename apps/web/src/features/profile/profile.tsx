// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { formatLocales, type RecoveryCodes, type Theme, type UiLocale } from '@stashley/shared'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client.ts'
import { useRefreshSession, useSession, useUser } from '../../api/session.ts'
import { useErrorText } from '../../i18n/errors.ts'
import { useT } from '../../i18n/use-t.ts'
import {
  Actions,
  Badge,
  Button,
  Dialog,
  Form,
  Notice,
  PageHeader,
  Section,
  SelectField,
  TextField,
} from '../../ui/controls.tsx'
import { MfaEnrollment, RecoveryCodeList } from '../auth/mfa.tsx'

type Choice<T extends string> = T | 'default'

function ProfileForm() {
  const t = useT()
  const errors = useErrorText()
  const user = useUser()
  const refresh = useRefreshSession()
  const [name, setName] = useState(user.displayName)
  const [locale, setLocale] = useState<Choice<UiLocale>>(user.locale ?? 'default')
  const [formatLocale, setFormatLocale] = useState<string>(user.formatLocale ?? 'default')
  const [theme, setTheme] = useState<Theme>(user.theme)
  const save = useMutation({
    mutationFn: () =>
      api('PATCH', '/internal/profile', {
        displayName: name,
        locale: locale === 'default' ? null : locale,
        formatLocale: formatLocale === 'default' ? null : formatLocale,
        theme,
      }),
    onSuccess: () => refresh(),
  })
  return (
    <Section title={t('profile.section.profile')}>
      <Form onSubmit={() => save.mutate()}>
        {save.isSuccess && <Notice tone="success">{t('notice.saved')}</Notice>}
        {save.error !== null && errors.message(save.error) !== undefined && (
          <Notice tone="error">{errors.message(save.error)}</Notice>
        )}
        <TextField
          label={t('field.email')}
          value={user.email}
          onChange={() => undefined}
          isReadOnly
        />
        <TextField
          label={t('field.displayName')}
          value={name}
          onChange={setName}
          autoComplete="name"
          error={errors.field(save.error, 'displayName')}
        />
        <SelectField<Choice<UiLocale>>
          label={t('profile.language')}
          value={locale}
          onChange={setLocale}
          options={[
            { id: 'default', label: t('profile.language.browser') },
            { id: 'en', label: 'English' },
            { id: 'de', label: 'Deutsch' },
          ]}
        />
        <SelectField<string>
          label={t('profile.formatLocale')}
          value={formatLocale}
          onChange={setFormatLocale}
          options={[
            { id: 'default', label: t('profile.formatLocale.language') },
            ...formatLocales.map((id) => ({
              id,
              label: `${new Intl.DisplayNames([id], { type: 'region' }).of(id.split('-')[1] ?? '') ?? id} · ${new Intl.NumberFormat(id).format(1234.5)} · ${new Intl.DateTimeFormat(id).format(new Date(2026, 10, 30))}`,
            })),
          ]}
        />
        <SelectField<Theme>
          label={t('theme.label')}
          value={theme}
          onChange={setTheme}
          options={[
            { id: 'system', label: t('theme.system') },
            { id: 'light', label: t('theme.light') },
            { id: 'dark', label: t('theme.dark') },
          ]}
        />
        <Actions>
          <Button type="submit" variant="primary" isDisabled={save.isPending}>
            {t('action.save')}
          </Button>
        </Actions>
      </Form>
    </Section>
  )
}

function PasswordForm() {
  const t = useT()
  const errors = useErrorText()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const change = useMutation({
    mutationFn: () =>
      api('POST', '/internal/profile/password', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent('')
      setNext('')
    },
  })
  return (
    <Section title={t('profile.section.password')}>
      <Form onSubmit={() => change.mutate()}>
        {change.isSuccess && <Notice tone="success">{t('profile.password.changed')}</Notice>}
        {change.error !== null && errors.message(change.error) !== undefined && (
          <Notice tone="error">{errors.message(change.error)}</Notice>
        )}
        <TextField
          label={t('field.currentPassword')}
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={setCurrent}
          error={errors.field(change.error, 'currentPassword')}
          isRequired
        />
        <TextField
          label={t('field.newPassword')}
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={setNext}
          description={t('field.passwordHint')}
          error={errors.field(change.error, 'newPassword')}
          isRequired
        />
        <Actions>
          <Button type="submit" variant="primary" isDisabled={change.isPending}>
            {t('profile.password.change')}
          </Button>
        </Actions>
      </Form>
    </Section>
  )
}

/** Disabling 2FA and regenerating recovery codes both need a current code. */
function CodeDialog(props: {
  title: string
  submitLabel: string
  isOpen: boolean
  onClose: () => void
  onSubmit: (code: string) => Promise<unknown>
}) {
  const t = useT()
  const errors = useErrorText()
  const [code, setCode] = useState('')
  const action = useMutation({ mutationFn: () => props.onSubmit(code) })
  return (
    <Dialog
      title={props.title}
      isOpen={props.isOpen}
      onOpenChange={(open) => !open && props.onClose()}
    >
      <Form onSubmit={() => action.mutate()}>
        {action.error !== null && <Notice tone="error">{errors.message(action.error)}</Notice>}
        <TextField
          label={t('mfa.codeOrRecovery')}
          value={code}
          onChange={setCode}
          autoComplete="one-time-code"
          autoFocus
          isRequired
        />
        <Actions>
          <Button onPress={props.onClose}>{t('action.cancel')}</Button>
          <Button type="submit" variant="primary" isDisabled={action.isPending}>
            {props.submitLabel}
          </Button>
        </Actions>
      </Form>
    </Dialog>
  )
}

function TwoFactor() {
  const t = useT()
  const user = useUser()
  const { instance } = useSession()
  const refresh = useRefreshSession()
  const [mode, setMode] = useState<'idle' | 'enroll' | 'disable' | 'codes'>('idle')
  const [codes, setCodes] = useState<string[]>()
  return (
    <Section
      title={t('profile.section.twoFactor')}
      aside={
        <Badge tone={user.mfaEnabled ? 'success' : 'neutral'}>
          {user.mfaEnabled ? t('status.on') : t('status.off')}
        </Badge>
      }
    >
      {mode === 'enroll' ? (
        <MfaEnrollment autoStart onDone={() => setMode('idle')} onCancel={() => setMode('idle')} />
      ) : user.mfaEnabled ? (
        <>
          {codes !== undefined && (
            <>
              <Notice tone="info">{t('mfa.recoveryCodes.prompt')}</Notice>
              <RecoveryCodeList codes={codes} />
            </>
          )}
          <Actions>
            <Button onPress={() => setMode('codes')}>{t('mfa.recoveryCodes.regenerate')}</Button>
            {!instance.mfaEnforced && (
              <Button variant="danger" onPress={() => setMode('disable')}>
                {t('mfa.disable')}
              </Button>
            )}
          </Actions>
        </>
      ) : (
        <Actions>
          <Button variant="primary" onPress={() => setMode('enroll')}>
            {t('mfa.setup.start')}
          </Button>
        </Actions>
      )}
      <CodeDialog
        title={t('mfa.disable')}
        submitLabel={t('mfa.disable')}
        isOpen={mode === 'disable'}
        onClose={() => setMode('idle')}
        onSubmit={async (code) => {
          await api('POST', '/internal/profile/mfa/disable', { code })
          await refresh()
          setMode('idle')
        }}
      />
      <CodeDialog
        title={t('mfa.recoveryCodes.regenerate')}
        submitLabel={t('mfa.recoveryCodes.regenerate')}
        isOpen={mode === 'codes'}
        onClose={() => setMode('idle')}
        onSubmit={async (code) => {
          const result = await api<RecoveryCodes>('POST', '/internal/profile/mfa/recovery-codes', {
            code,
          })
          setCodes(result.recoveryCodes)
          setMode('idle')
        }}
      />
    </Section>
  )
}

export function ProfilePage() {
  const t = useT()
  const user = useUser()
  return (
    <>
      <PageHeader title={t('profile.title')} />
      <ProfileForm />
      {user.hasPassword && <PasswordForm />}
      {user.hasPassword && <TwoFactor />}
    </>
  )
}
