// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { InvitationInfo } from '@stashley/shared'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { api, ApiError } from '../../api/client.ts'
import { useRefreshSession } from '../../api/session.ts'
import { useErrorText } from '../../i18n/errors.ts'
import { useT } from '../../i18n/use-t.ts'
import { Button, Form, Notice, TextField } from '../../ui/controls.tsx'
import { AuthText, AuthTitle } from './layout.tsx'

/** New password with confirmation; the confirmation is checked on the client only. */
function usePasswordPair() {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  return {
    password,
    setPassword,
    confirmation,
    setConfirmation,
    matches: password === confirmation,
  }
}

export function InvitationPage({ token }: { token: string }) {
  const t = useT()
  const errors = useErrorText()
  const refresh = useRefreshSession()
  const navigate = useNavigate()
  const pair = usePasswordPair()
  const [name, setName] = useState<string>()
  const [mismatch, setMismatch] = useState(false)
  const info = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api<InvitationInfo>('GET', `/internal/invitations/${token}`),
    retry: false,
  })
  const accept = useMutation({
    mutationFn: () =>
      api('POST', `/internal/invitations/${token}`, {
        password: pair.password,
        ...(name !== undefined && { displayName: name }),
      }),
    onSuccess: async () => {
      await refresh()
      await navigate({ to: '/' })
    },
  })

  if (info.error !== null) {
    return (
      <>
        <AuthTitle>{t('invitation.title')}</AuthTitle>
        <Notice tone="error">{errors.message(info.error)}</Notice>
        <Link to="/sign-in">{t('signIn.title')}</Link>
      </>
    )
  }
  if (info.data === undefined) return null

  return (
    <>
      <AuthTitle>{t('invitation.title')}</AuthTitle>
      <AuthText>{info.data.email}</AuthText>
      {accept.error !== null && errors.message(accept.error) !== undefined && (
        <Notice tone="error">{errors.message(accept.error)}</Notice>
      )}
      <Form
        onSubmit={() => {
          setMismatch(!pair.matches)
          if (pair.matches) accept.mutate()
        }}
      >
        <TextField
          label={t('field.displayName')}
          value={name ?? info.data.displayName}
          onChange={setName}
          autoComplete="name"
          error={errors.field(accept.error, 'displayName')}
        />
        <TextField
          label={t('field.newPassword')}
          type="password"
          autoComplete="new-password"
          value={pair.password}
          onChange={pair.setPassword}
          description={t('field.passwordHint')}
          error={errors.field(accept.error, 'password')}
          isRequired
        />
        <TextField
          label={t('field.confirmPassword')}
          type="password"
          autoComplete="new-password"
          value={pair.confirmation}
          onChange={pair.setConfirmation}
          error={mismatch ? t('field.mismatch') : undefined}
          isRequired
        />
        <Button type="submit" variant="primary" isDisabled={accept.isPending}>
          {t('invitation.submit')}
        </Button>
      </Form>
    </>
  )
}

export function PasswordResetRequest() {
  const t = useT()
  const errors = useErrorText()
  const [email, setEmail] = useState('')
  const request = useMutation({
    mutationFn: () => api('POST', '/internal/auth/password-reset', { email }),
  })
  return (
    <>
      <AuthTitle>{t('passwordReset.title')}</AuthTitle>
      {request.isSuccess ? (
        <Notice tone="success">{t('passwordReset.sent')}</Notice>
      ) : (
        <Form onSubmit={() => request.mutate()}>
          {request.error !== null && <Notice tone="error">{errors.message(request.error)}</Notice>}
          <TextField
            label={t('field.email')}
            type="email"
            autoComplete="username"
            value={email}
            onChange={setEmail}
            error={errors.field(request.error, 'email')}
            autoFocus
            isRequired
          />
          <Button type="submit" variant="primary" isDisabled={request.isPending}>
            {t('passwordReset.send')}
          </Button>
        </Form>
      )}
      <Link to="/sign-in">{t('signIn.title')}</Link>
    </>
  )
}

export function PasswordResetComplete({ token }: { token: string }) {
  const t = useT()
  const errors = useErrorText()
  const navigate = useNavigate()
  const pair = usePasswordPair()
  const [mismatch, setMismatch] = useState(false)
  const complete = useMutation({
    mutationFn: () =>
      api('POST', '/internal/auth/password-reset/complete', { token, password: pair.password }),
    onSuccess: () => navigate({ to: '/sign-in' }),
  })
  const linkInvalid = complete.error instanceof ApiError && complete.error.code === 'link_invalid'
  return (
    <>
      <AuthTitle>{t('passwordReset.newTitle')}</AuthTitle>
      {complete.error !== null && errors.message(complete.error) !== undefined && (
        <Notice tone="error">{errors.message(complete.error)}</Notice>
      )}
      {!linkInvalid && (
        <Form
          onSubmit={() => {
            setMismatch(!pair.matches)
            if (pair.matches) complete.mutate()
          }}
        >
          <TextField
            label={t('field.newPassword')}
            type="password"
            autoComplete="new-password"
            value={pair.password}
            onChange={pair.setPassword}
            description={t('field.passwordHint')}
            error={errors.field(complete.error, 'password')}
            autoFocus
            isRequired
          />
          <TextField
            label={t('field.confirmPassword')}
            type="password"
            autoComplete="new-password"
            value={pair.confirmation}
            onChange={pair.setConfirmation}
            error={mismatch ? t('field.mismatch') : undefined}
            isRequired
          />
          <Button type="submit" variant="primary" isDisabled={complete.isPending}>
            {t('passwordReset.save')}
          </Button>
        </Form>
      )}
      <Link to="/sign-in">{t('signIn.title')}</Link>
    </>
  )
}
