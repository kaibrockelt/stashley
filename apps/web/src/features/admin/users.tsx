// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { AdminUser, LinkResult, SystemRole, UserStatus } from '@stashley/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client.ts'
import { useSession, useUser } from '../../api/session.ts'
import { useErrorText } from '../../i18n/errors.ts'
import { useFormatDateTime } from '../../i18n/format.ts'
import type { MessageId } from '../../i18n/locale.ts'
import { useT } from '../../i18n/use-t.ts'
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
  SelectField,
  TextField,
} from '../../ui/controls.tsx'
import table from '../../ui/table.module.css'
import { rolesKey, useRoles } from '../design/roles.tsx'

const usersKey = ['admin', 'users'] as const

export const roleLabels: Record<SystemRole, MessageId> = {
  admin: 'role.admin',
  manager: 'role.manager',
  user: 'role.user',
}

const statusLabels: Record<UserStatus, MessageId> = {
  pending: 'status.pending',
  active: 'status.active',
  disabled: 'status.disabled',
}

const statusTones = { pending: 'warning', active: 'success', disabled: 'neutral' } as const

function useRoleOptions() {
  const t = useT()
  return (['user', 'manager', 'admin'] as const).map((id) => ({ id, label: t(roleLabels[id]) }))
}

function LinkNotice(props: { result: LinkResult; label: string }) {
  const t = useT()
  if (props.result.emailed) return <Notice tone="success">{t('users.link.emailed')}</Notice>
  if (props.result.link === null) return null
  return <CopyField label={props.label} value={props.result.link} />
}

function InviteDialog(props: { isOpen: boolean; onClose: () => void }) {
  const t = useT()
  const errors = useErrorText()
  const client = useQueryClient()
  const roles = useRoleOptions()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<SystemRole>('user')
  const invite = useMutation({
    mutationFn: () =>
      api<{ user: AdminUser } & LinkResult>('POST', '/internal/admin/users', {
        email,
        displayName: name,
        systemRole: role,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: usersKey }),
  })
  const close = () => {
    invite.reset()
    setEmail('')
    setName('')
    setRole('user')
    props.onClose()
  }
  return (
    <Dialog
      title={t('users.invite')}
      isOpen={props.isOpen}
      onOpenChange={(open) => !open && close()}
    >
      {invite.data !== undefined ? (
        <>
          <LinkNotice result={invite.data} label={t('users.link.invitation')} />
          <Actions>
            <Button variant="primary" onPress={close}>
              {t('action.done')}
            </Button>
          </Actions>
        </>
      ) : (
        <Form onSubmit={() => invite.mutate()}>
          {invite.error !== null && errors.message(invite.error) !== undefined && (
            <Notice tone="error">{errors.message(invite.error)}</Notice>
          )}
          <TextField
            label={t('field.email')}
            type="email"
            value={email}
            onChange={setEmail}
            error={errors.field(invite.error, 'email')}
            autoFocus
            isRequired
          />
          <TextField
            label={t('field.displayName')}
            value={name}
            onChange={setName}
            error={errors.field(invite.error, 'displayName')}
            isRequired
          />
          <SelectField
            label={t('field.systemRole')}
            value={role}
            onChange={setRole}
            options={roles}
          />
          <Actions>
            <Button onPress={close}>{t('action.cancel')}</Button>
            <Button type="submit" variant="primary" isDisabled={invite.isPending}>
              {t('users.invite.submit')}
            </Button>
          </Actions>
        </Form>
      )}
    </Dialog>
  )
}

function UserDialog(props: { user: AdminUser | undefined; onClose: () => void }) {
  const t = useT()
  const errors = useErrorText()
  const client = useQueryClient()
  const roles = useRoleOptions()
  const self = useUser()
  const user = props.user
  const [role, setRole] = useState<SystemRole>(user?.systemRole ?? 'user')
  const [name, setName] = useState(user?.displayName ?? '')
  const [roleIds, setRoleIds] = useState<string[]>(user?.roleIds ?? [])
  const [link, setLink] = useState<{ result: LinkResult; label: string }>()
  const allRoles = useRoles()
  const refresh = () => client.invalidateQueries({ queryKey: usersKey })
  const update = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const id = user?.id ?? ''
      const updated = await api<AdminUser>('PATCH', `/internal/admin/users/${id}`, body)
      const before = [...(user?.roleIds ?? [])].sort().join()
      if ([...roleIds].sort().join() !== before) {
        await api('PUT', `/internal/admin/users/${id}/roles`, { roleIds })
        // The role list counts users per role.
        await client.invalidateQueries({ queryKey: rolesKey })
      }
      return updated
    },
    onSuccess: async () => {
      await refresh()
      props.onClose()
    },
  })
  const action = useMutation({
    mutationFn: async (kind: 'reset' | 'invitation' | 'mfa') => {
      const id = user?.id ?? ''
      if (kind === 'mfa') {
        await api('POST', `/internal/admin/users/${id}/mfa/reset`)
        return undefined
      }
      const path = kind === 'reset' ? 'password-reset' : 'invitation'
      return api<LinkResult>('POST', `/internal/admin/users/${id}/${path}`)
    },
    onSuccess: async (result, kind) => {
      if (result !== undefined) {
        setLink({
          result,
          label: t(kind === 'reset' ? 'users.link.reset' : 'users.link.invitation'),
        })
      }
      await refresh()
    },
  })
  const removeIdentity = useMutation({
    mutationFn: (identityId: string) =>
      api('DELETE', `/internal/admin/users/${user?.id ?? ''}/identities/${identityId}`),
    onSuccess: refresh,
  })
  if (user === undefined) return null
  const isSelf = user.id === self.id
  const error = update.error ?? action.error ?? removeIdentity.error

  return (
    <Dialog title={user.displayName} isOpen onOpenChange={(open) => !open && props.onClose()}>
      <p className={table.muted}>{user.email}</p>
      {error !== null && errors.message(error) !== undefined && (
        <Notice tone="error">{errors.message(error)}</Notice>
      )}
      {link !== undefined && <LinkNotice result={link.result} label={link.label} />}
      <Form
        onSubmit={() => update.mutate({ displayName: name, ...(!isSelf && { systemRole: role }) })}
      >
        <TextField
          label={t('field.displayName')}
          value={name}
          onChange={setName}
          error={errors.field(update.error, 'displayName')}
        />
        {!isSelf && (
          <SelectField
            label={t('field.systemRole')}
            value={role}
            onChange={setRole}
            options={roles}
          />
        )}
        {(allRoles.data?.data.length ?? 0) > 0 && (
          <fieldset className={table.fieldset}>
            <legend>{t('users.roles')}</legend>
            {allRoles.data?.data.map((entry) => (
              <CheckboxField
                key={entry.id}
                label={entry.name}
                isSelected={roleIds.includes(entry.id)}
                onChange={(selected) =>
                  setRoleIds((current) =>
                    selected ? [...current, entry.id] : current.filter((id) => id !== entry.id),
                  )
                }
              />
            ))}
          </fieldset>
        )}
        <Actions>
          <Button type="submit" variant="primary" isDisabled={update.isPending}>
            {t('action.save')}
          </Button>
        </Actions>
      </Form>
      {user.identities.length > 0 && (
        <ul className={table.muted}>
          {user.identities.map((identity) => (
            <li key={identity.id}>
              {identity.provider} · {identity.email}{' '}
              <Button variant="ghost" onPress={() => removeIdentity.mutate(identity.id)}>
                {t('users.identity.remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Actions>
        {user.status === 'active' && !user.hasPassword && (
          <Button onPress={() => action.mutate('invitation')}>
            {t('users.invitation.resend')}
          </Button>
        )}
        {user.status === 'active' && user.hasPassword && (
          <Button onPress={() => action.mutate('reset')}>{t('users.passwordReset')}</Button>
        )}
        {user.mfaEnabled && (
          <Button onPress={() => action.mutate('mfa')}>{t('users.mfaReset')}</Button>
        )}
        {!isSelf && user.status === 'pending' && (
          <Button
            variant="primary"
            onPress={() => update.mutate({ status: 'active', systemRole: role })}
          >
            {t('users.approve')}
          </Button>
        )}
        {!isSelf && user.status === 'active' && (
          <Button variant="danger" onPress={() => update.mutate({ status: 'disabled' })}>
            {t('users.disable')}
          </Button>
        )}
        {!isSelf && user.status === 'disabled' && (
          <Button onPress={() => update.mutate({ status: 'active' })}>{t('users.enable')}</Button>
        )}
      </Actions>
    </Dialog>
  )
}

export function UsersPage() {
  const t = useT()
  const formatDate = useFormatDateTime()
  useSession()
  const [status, setStatus] = useState<UserStatus | 'all'>('all')
  const [query, setQuery] = useState('')
  const [inviting, setInviting] = useState(false)
  const [selected, setSelected] = useState<AdminUser>()
  const params = new URLSearchParams({
    ...(status !== 'all' && { status }),
    ...(query !== '' && { q: query }),
  })
  const roles = useRoles()
  const roleNames = new Map(roles.data?.data.map((role) => [role.id, role.name]))
  const users = useQuery({
    queryKey: [...usersKey, status, query],
    queryFn: () => api<{ data: AdminUser[] }>('GET', `/internal/admin/users?${params.toString()}`),
  })
  return (
    <>
      <PageHeader
        title={t('users.title')}
        actions={
          <Button variant="primary" onPress={() => setInviting(true)}>
            {t('users.invite')}
          </Button>
        }
      />
      <div className={table.toolbar}>
        <TextField label={t('action.search')} value={query} onChange={setQuery} />
        <SelectField<UserStatus | 'all'>
          label={t('field.status')}
          value={status}
          onChange={setStatus}
          options={[
            { id: 'all', label: t('status.all') },
            { id: 'pending', label: t('status.pending') },
            { id: 'active', label: t('status.active') },
            { id: 'disabled', label: t('status.disabled') },
          ]}
        />
      </div>
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr>
              <th>{t('field.displayName')}</th>
              <th>{t('field.email')}</th>
              <th>{t('field.systemRole')}</th>
              <th>{t('users.roles')}</th>
              <th>{t('field.status')}</th>
              <th>{t('users.column.mfa')}</th>
              <th>{t('users.column.lastSignIn')}</th>
            </tr>
          </thead>
          <tbody>
            {users.data?.data.map((user) => (
              <tr key={user.id}>
                <td>
                  <Button variant="ghost" onPress={() => setSelected(user)}>
                    {user.displayName}
                  </Button>
                </td>
                <td>{user.email}</td>
                <td>{t(roleLabels[user.systemRole])}</td>
                <td className={table.muted}>
                  {user.roleIds.map((id) => roleNames.get(id) ?? '').join(', ')}
                </td>
                <td>
                  <Badge tone={statusTones[user.status]}>{t(statusLabels[user.status])}</Badge>
                </td>
                <td>{user.mfaEnabled ? t('status.on') : t('status.off')}</td>
                <td className={table.muted}>{formatDate(user.lastLoginAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.data?.data.length === 0 && <p className={table.empty}>{t('users.empty')}</p>}
      </div>
      <InviteDialog isOpen={inviting} onClose={() => setInviting(false)} />
      <UserDialog key={selected?.id} user={selected} onClose={() => setSelected(undefined)} />
    </>
  )
}
