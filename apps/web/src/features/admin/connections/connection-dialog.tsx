// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  Connection,
  ConnectionInput,
  ConnectionTestResult,
  CredentialPurpose,
  TlsMode,
} from '@stashley/shared'
import { sameConnectionTarget, tlsModes } from '@stashley/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { api } from '../../../api/client.ts'
import { useSession } from '../../../api/session.ts'
import { useErrorText } from '../../../i18n/errors.ts'
import { useT } from '../../../i18n/use-t.ts'
import {
  Actions,
  Button,
  Dialog,
  Form,
  Notice,
  SelectField,
  SwitchField,
  TextAreaField,
  TextField,
} from '../../../ui/controls.tsx'
import styles from './connections.module.css'
import { connectionsKey, GrantSummary, purposeHints, purposeLabels, tlsLabels } from './texts.tsx'

interface UserState {
  enabled: boolean
  username: string
  password: string
}

function UserFields(props: {
  purpose: CredentialPurpose
  state: UserState
  onChange: (state: UserState) => void
  /** `keep`: an empty field keeps the stored password; `reenter`: the target changed. */
  storedPassword: 'keep' | 'reenter' | null
  error: unknown
}) {
  const t = useT()
  const errors = useErrorText()
  const { purpose, state } = props
  const field = `credentials.${purpose}`
  return (
    <div className={styles.block}>
      <div className={styles.blockHead}>
        <h3 className={styles.blockTitle}>{t(purposeLabels[purpose])}</h3>
      </div>
      <p className={styles.muted}>{t(purposeHints[purpose])}</p>
      {purpose !== 'read' && (
        <SwitchField
          label={t('connections.user.use')}
          isSelected={state.enabled}
          onChange={(enabled) => props.onChange({ ...state, enabled })}
        />
      )}
      {state.enabled && (
        <div className={styles.grid}>
          <TextField
            label={t('connections.username')}
            value={state.username}
            onChange={(username) => props.onChange({ ...state, username })}
            autoComplete="off"
            error={errors.field(props.error, `${field}.username`)}
            isRequired
          />
          <TextField
            label={t('field.password')}
            type="password"
            autoComplete="new-password"
            value={state.password}
            onChange={(password) => props.onChange({ ...state, password })}
            {...(props.storedPassword === 'keep' && {
              description: t('connections.password.keep'),
            })}
            {...(props.storedPassword === 'reenter' && {
              description: t('connections.password.reenter'),
            })}
            isRequired={props.storedPassword !== 'keep'}
            error={errors.field(props.error, `${field}.password`)}
          />
        </div>
      )}
      {errors.field(props.error, field) !== undefined && (
        <Notice tone="error">{errors.field(props.error, field)}</Notice>
      )}
    </div>
  )
}

export function ConnectionDialog(props: { connection?: Connection; onClose: () => void }) {
  const t = useT()
  const errors = useErrorText()
  const client = useQueryClient()
  const navigate = useNavigate()
  const { instance } = useSession()
  const existing = props.connection
  const stored = (purpose: CredentialPurpose) =>
    existing?.credentials.find((credential) => credential.purpose === purpose)
  const initialUser = (purpose: CredentialPurpose): UserState => ({
    enabled: purpose === 'read' || stored(purpose) !== undefined,
    username: stored(purpose)?.username ?? '',
    password: '',
  })
  const [name, setName] = useState(existing?.name ?? '')
  const [host, setHost] = useState(existing?.host ?? '')
  const [port, setPort] = useState(String(existing?.port ?? 3306))
  const [database, setDatabase] = useState(existing?.databaseName ?? '')
  const [timezone, setTimezone] = useState(existing?.timezone ?? instance.timeZone)
  const [timeout, setTimeoutSeconds] = useState(String(existing?.queryTimeoutSeconds ?? 30))
  const [tlsMode, setTlsMode] = useState<TlsMode>(existing?.tls.mode ?? 'disabled')
  const [caPem, setCaPem] = useState(existing?.tls.caPem ?? '')
  const [serverName, setServerName] = useState(existing?.tls.serverName ?? '')
  const [users, setUsers] = useState<Record<CredentialPurpose, UserState>>({
    read: initialUser('read'),
    write: initialUser('write'),
    schema: initialUser('schema'),
  })

  const tls = {
    mode: tlsMode,
    caPem: caPem.trim() === '' ? null : caPem,
    serverName: serverName.trim() === '' ? null : serverName,
  }
  // Mirrors the server: stored passwords go only to the server they were saved for.
  const sameTarget =
    existing !== undefined && sameConnectionTarget(existing, { host, port: Number(port), tls })
  const storedPassword = (purpose: CredentialPurpose) => {
    if (stored(purpose) === undefined) return null
    return sameTarget ? 'keep' : 'reenter'
  }

  const input = (): ConnectionInput => {
    const credential = (purpose: CredentialPurpose) => {
      const user = users[purpose]
      if (!user.enabled) return null
      return {
        username: user.username,
        ...(user.password !== '' && { password: user.password }),
      }
    }
    return {
      name,
      host,
      port: Number(port),
      databaseName: database,
      tls,
      timezone,
      queryTimeoutSeconds: Number(timeout),
      credentials: {
        read: credential('read') ?? { username: users.read.username },
        write: credential('write'),
        schema: credential('schema'),
      },
    }
  }

  const test = useMutation({
    mutationFn: () =>
      api<ConnectionTestResult>('POST', '/internal/admin/connections/test', {
        ...input(),
        ...(existing !== undefined && { connectionId: existing.id }),
      }),
  })
  const save = useMutation({
    mutationFn: () =>
      existing === undefined
        ? api<Connection>('POST', '/internal/admin/connections', input())
        : api<Connection>('PUT', `/internal/admin/connections/${existing.id}`, input()),
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: connectionsKey })
      props.onClose()
      if (existing === undefined) {
        await navigate({
          to: '/admin/connections/$connectionId',
          params: { connectionId: saved.id },
        })
      }
    },
  })
  const error = save.error ?? test.error
  const busy = save.isPending || test.isPending

  return (
    <Dialog
      title={existing?.name ?? t('connections.add')}
      isOpen
      isWide
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
          description={t('connections.name.hint')}
          error={errors.field(error, 'name')}
          isRequired
        />
        <div className={styles.grid}>
          <TextField
            label={t('connections.host')}
            value={host}
            onChange={setHost}
            error={errors.field(error, 'host')}
            isRequired
          />
          <TextField
            label={t('connections.port')}
            value={port}
            onChange={setPort}
            inputMode="numeric"
            error={errors.field(error, 'port')}
            isRequired
          />
          <TextField
            label={t('connections.database')}
            value={database}
            onChange={setDatabase}
            error={errors.field(error, 'databaseName')}
            isRequired
          />
        </div>
        <div className={styles.grid}>
          <TextField
            label={t('connections.timezone')}
            value={timezone}
            onChange={setTimezone}
            description={t('connections.timezone.hint')}
            error={errors.field(error, 'timezone')}
            isRequired
          />
          <TextField
            label={t('connections.timeout')}
            value={timeout}
            onChange={setTimeoutSeconds}
            inputMode="numeric"
            error={errors.field(error, 'queryTimeoutSeconds')}
            isRequired
          />
        </div>
        <SelectField
          label={t('connections.tls')}
          value={tlsMode}
          onChange={setTlsMode}
          options={tlsModes.map((mode) => ({ id: mode, label: t(tlsLabels[mode]) }))}
        />
        {(tlsMode === 'disabled' || tlsMode === 'required') && (
          <Notice tone="info">{t('connections.tls.unverified')}</Notice>
        )}
        {(tlsMode === 'verify-ca' || tlsMode === 'verify-full') && (
          <>
            <TextAreaField
              label={t('connections.tls.ca')}
              value={caPem}
              onChange={setCaPem}
              description={t('connections.tls.ca.hint')}
              error={errors.field(error, 'tls.caPem')}
              isMono
            />
            {tlsMode === 'verify-full' && (
              <TextField
                label={t('connections.tls.serverName')}
                value={serverName}
                onChange={setServerName}
                description={t('connections.tls.serverName.hint')}
                error={errors.field(error, 'tls.serverName')}
              />
            )}
          </>
        )}
        {(['read', 'write', 'schema'] as const).map((purpose) => (
          <UserFields
            key={purpose}
            purpose={purpose}
            state={users[purpose]}
            onChange={(state) => setUsers((current) => ({ ...current, [purpose]: state }))}
            storedPassword={storedPassword(purpose)}
            error={error}
          />
        ))}
        {test.data !== undefined && (
          <div className={styles.block}>
            <div className={styles.blockHead}>
              <h3 className={styles.blockTitle}>{t('connections.test.result')}</h3>
              <span className={styles.muted}>
                {test.data.engine === 'mariadb' ? 'MariaDB' : 'MySQL'} {test.data.serverVersion}
              </span>
            </div>
            {!test.data.versionSupported && (
              <Notice tone="info">{t('connections.version.unsupported')}</Notice>
            )}
            {test.data.grants.map((report) => (
              <div key={report.purpose}>
                <p className={styles.blockTitle}>{t(purposeLabels[report.purpose])}</p>
                <GrantSummary report={report} />
              </div>
            ))}
          </div>
        )}
        <Actions>
          <Button onPress={props.onClose}>{t('action.cancel')}</Button>
          <Button onPress={() => test.mutate()} isDisabled={busy}>
            {t('connections.test')}
          </Button>
          <Button type="submit" variant="primary" isDisabled={busy}>
            {t('action.save')}
          </Button>
        </Actions>
      </Form>
    </Dialog>
  )
}
