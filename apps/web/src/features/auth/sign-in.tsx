// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client.ts'
import { useRefreshSession, useSession } from '../../api/session.ts'
import { useErrorText } from '../../i18n/errors.ts'
import { useT } from '../../i18n/use-t.ts'
import { Button, buttonClass, Form, Notice, TextField } from '../../ui/controls.tsx'
import styles from './auth.module.css'
import { AuthTitle } from './layout.tsx'

export function SignIn() {
  const t = useT()
  const errors = useErrorText()
  const { instance } = useSession()
  const search: { error?: string } = useSearch({ strict: false })
  const refresh = useRefreshSession()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const login = useMutation({
    mutationFn: () => api('POST', '/internal/auth/login', { email, password }),
    onSuccess: async () => {
      await refresh()
      await navigate({ to: '/' })
    },
  })
  const error = login.error ?? undefined

  return (
    <>
      <AuthTitle>{t('signIn.title')}</AuthTitle>
      {search.error !== undefined && <Notice tone="error">{errors.signIn(search.error)}</Notice>}
      {error !== undefined && errors.message(error) !== undefined && (
        <Notice tone="error">{errors.message(error)}</Notice>
      )}
      {instance.localLogin && (
        <Form onSubmit={() => login.mutate()}>
          <TextField
            label={t('field.email')}
            type="email"
            autoComplete="username"
            value={email}
            onChange={setEmail}
            error={errors.field(error, 'email')}
            autoFocus
            isRequired
          />
          <TextField
            label={t('field.password')}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            error={errors.field(error, 'password')}
            isRequired
          />
          <Button type="submit" variant="primary" isDisabled={login.isPending}>
            {t('signIn.submit')}
          </Button>
        </Form>
      )}
      {instance.providers.length > 0 && (
        <>
          {instance.localLogin && <div className={styles.divider}>{t('signIn.or')}</div>}
          <div className={styles.providers}>
            {instance.providers.map((provider) => (
              <a
                key={provider.slug}
                className={buttonClass()}
                href={`/auth/oidc/${provider.slug}/start`}
              >
                {t('signIn.withProvider', { provider: provider.displayName })}
              </a>
            ))}
          </div>
        </>
      )}
      {instance.localLogin && instance.smtp && (
        <div className={styles.links}>
          <Link to="/password-reset">{t('signIn.forgotPassword')}</Link>
        </div>
      )}
    </>
  )
}
