// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { MfaSetup, RecoveryCodes } from '@stashley/shared'
import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client.ts'
import { useRefreshSession } from '../../api/session.ts'
import { useErrorText } from '../../i18n/errors.ts'
import { useT } from '../../i18n/use-t.ts'
import { Actions, Button, Form, Notice, TextField } from '../../ui/controls.tsx'
import styles from './auth.module.css'
import { AuthText, AuthTitle } from './layout.tsx'

export function useSignOut(): () => void {
  const refresh = useRefreshSession()
  const navigate = useNavigate()
  return () => {
    void api('POST', '/internal/auth/logout')
      .catch(() => undefined)
      .then(refresh)
      .then(() => navigate({ to: '/sign-in' }))
  }
}

/** Second step of password sign-in. */
export function MfaChallenge() {
  const t = useT()
  const errors = useErrorText()
  const refresh = useRefreshSession()
  const navigate = useNavigate()
  const signOut = useSignOut()
  const [code, setCode] = useState('')
  const verify = useMutation({
    mutationFn: () => api('POST', '/internal/auth/mfa', { code }),
    onSuccess: async () => {
      await refresh()
      await navigate({ to: '/' })
    },
  })
  return (
    <>
      <AuthTitle>{t('mfa.title')}</AuthTitle>
      <AuthText>{t('mfa.prompt')}</AuthText>
      {verify.error !== null && <Notice tone="error">{errors.message(verify.error)}</Notice>}
      <Form onSubmit={() => verify.mutate()}>
        <TextField
          label={t('mfa.code')}
          value={code}
          onChange={setCode}
          autoComplete="one-time-code"
          autoFocus
          isRequired
        />
        <Button type="submit" variant="primary" isDisabled={verify.isPending}>
          {t('mfa.verify')}
        </Button>
      </Form>
      <Button variant="ghost" onPress={signOut}>
        {t('action.signOut')}
      </Button>
    </>
  )
}

export function RecoveryCodeList(props: { codes: string[] }) {
  return (
    <ul className={styles.codes}>
      {props.codes.map((code) => (
        <li key={code}>{code}</li>
      ))}
    </ul>
  )
}

/** Sets up an authenticator app; shows recovery codes when done. */
export function MfaEnrollment(props: {
  onDone: () => void
  onCancel?: () => void
  /** Requests the secret right away instead of showing a start button. */
  autoStart?: boolean
}) {
  const t = useT()
  const errors = useErrorText()
  const refresh = useRefreshSession()
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[]>()
  const start = useMutation({
    mutationFn: () => api<MfaSetup>('POST', '/internal/profile/mfa/setup'),
  })
  const started = useRef(false)
  const { mutate: startSetup } = start
  useEffect(() => {
    if (props.autoStart !== true || started.current) return
    started.current = true
    startSetup()
  }, [props.autoStart, startSetup])
  const confirm = useMutation({
    mutationFn: () => api<RecoveryCodes>('POST', '/internal/profile/mfa/confirm', { code }),
    onSuccess: async (result) => {
      setCodes(result.recoveryCodes)
      await refresh()
    },
  })

  if (codes !== undefined) {
    return (
      <>
        <AuthText>{t('mfa.recoveryCodes.prompt')}</AuthText>
        <RecoveryCodeList codes={codes} />
        <Actions>
          <Button variant="primary" onPress={props.onDone}>
            {t('action.done')}
          </Button>
        </Actions>
      </>
    )
  }

  if (start.data === undefined) {
    if (props.autoStart === true && start.error === null) return null
    return (
      <>
        {start.error !== null && <Notice tone="error">{errors.message(start.error)}</Notice>}
        <Actions>
          {props.onCancel !== undefined && (
            <Button onPress={props.onCancel}>{t('action.cancel')}</Button>
          )}
          <Button variant="primary" onPress={() => start.mutate()} isDisabled={start.isPending}>
            {t('mfa.setup.start')}
          </Button>
        </Actions>
      </>
    )
  }

  const qr = `data:image/svg+xml;base64,${btoa(start.data.qrSvg)}`
  return (
    <Form onSubmit={() => confirm.mutate()}>
      <AuthText>{t('mfa.setup.scan')}</AuthText>
      <img className={styles.qr} src={qr} alt={t('mfa.setup.qrAlt')} />
      <TextField
        label={t('mfa.setup.secret')}
        value={start.data.secret}
        onChange={() => undefined}
        isReadOnly
      />
      {confirm.error !== null && <Notice tone="error">{errors.message(confirm.error)}</Notice>}
      <TextField
        label={t('mfa.code')}
        value={code}
        onChange={setCode}
        autoComplete="one-time-code"
        inputMode="numeric"
        isRequired
      />
      <Actions>
        {props.onCancel !== undefined && (
          <Button onPress={props.onCancel}>{t('action.cancel')}</Button>
        )}
        <Button type="submit" variant="primary" isDisabled={confirm.isPending}>
          {t('mfa.setup.confirm')}
        </Button>
      </Actions>
    </Form>
  )
}

/** Shown when 2FA is enforced and the account has none yet. */
export function MfaRequiredSetup() {
  const t = useT()
  const navigate = useNavigate()
  const signOut = useSignOut()
  return (
    <>
      <AuthTitle>{t('mfa.setup.title')}</AuthTitle>
      <AuthText>{t('mfa.setup.required')}</AuthText>
      <MfaEnrollment onDone={() => void navigate({ to: '/' })} />
      <Button variant="ghost" onPress={signOut}>
        {t('action.signOut')}
      </Button>
    </>
  )
}

export function Pending() {
  const t = useT()
  const signOut = useSignOut()
  return (
    <>
      <AuthTitle>{t('pending.title')}</AuthTitle>
      <AuthText>{t('pending.text')}</AuthText>
      <Button onPress={signOut}>{t('action.signOut')}</Button>
    </>
  )
}
