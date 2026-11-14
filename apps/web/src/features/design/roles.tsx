// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { Role } from '@stashley/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client.ts'
import { useSession, useUser } from '../../api/session.ts'
import { useErrorText } from '../../i18n/errors.ts'
import { useT } from '../../i18n/use-t.ts'
import {
  Actions,
  Button,
  Dialog,
  Form,
  Notice,
  PageHeader,
  TextAreaField,
  TextField,
} from '../../ui/controls.tsx'
import table from '../../ui/table.module.css'

export const rolesKey = ['design', 'roles'] as const

export function useRoles() {
  return useQuery({
    queryKey: rolesKey,
    queryFn: () => api<{ data: Role[] }>('GET', '/internal/design/roles'),
  })
}

/** Whether the current account may create, rename and delete roles (D14). */
function useMayManage(): boolean {
  const user = useUser()
  const { instance } = useSession()
  return user.systemRole === 'admin' || instance.managersCreateRoles
}

function RoleDialog(props: { role: Role | undefined; isOpen: boolean; onClose: () => void }) {
  const t = useT()
  const errors = useErrorText()
  const client = useQueryClient()
  const role = props.role
  const [name, setName] = useState(role?.name ?? '')
  const [description, setDescription] = useState(role?.description ?? '')
  const done = async () => {
    await client.invalidateQueries({ queryKey: rolesKey })
    props.onClose()
  }
  const save = useMutation({
    mutationFn: () =>
      role === undefined
        ? api<Role>('POST', '/internal/design/roles', { name, description, homePageId: null })
        : api<Role>('PATCH', `/internal/design/roles/${role.id}`, { name, description }),
    onSuccess: done,
  })
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/internal/design/roles/${role?.id ?? ''}`),
    onSuccess: done,
  })
  const [confirming, setConfirming] = useState(false)
  const error = save.error ?? remove.error
  return (
    <Dialog
      title={role === undefined ? t('roles.new') : role.name}
      isOpen={props.isOpen}
      onOpenChange={(open) => !open && props.onClose()}
    >
      <Form onSubmit={() => save.mutate()}>
        {error !== null && errors.message(error) !== undefined && (
          <Notice tone="error">{errors.message(error)}</Notice>
        )}
        <TextField
          label={t('field.name')}
          value={name}
          onChange={setName}
          error={errors.field(save.error, 'name')}
          autoFocus
          isRequired
        />
        <TextAreaField
          label={t('field.description')}
          value={description}
          onChange={setDescription}
          error={errors.field(save.error, 'description')}
          rows={3}
        />
        {confirming && <Notice tone="info">{t('roles.delete.confirm')}</Notice>}
        <Actions>
          {role !== undefined &&
            (confirming ? (
              <Button
                variant="danger"
                onPress={() => remove.mutate()}
                isDisabled={remove.isPending}
              >
                {t('roles.delete')}
              </Button>
            ) : (
              <Button variant="ghost" onPress={() => setConfirming(true)}>
                {t('action.delete')}
              </Button>
            ))}
          <Button onPress={props.onClose}>{t('action.cancel')}</Button>
          <Button type="submit" variant="primary" isDisabled={save.isPending}>
            {t('action.save')}
          </Button>
        </Actions>
      </Form>
    </Dialog>
  )
}

export function RolesPage() {
  const t = useT()
  const roles = useRoles()
  const mayManage = useMayManage()
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<Role>()
  return (
    <>
      <PageHeader
        title={t('roles.title')}
        actions={
          mayManage && (
            <Button variant="primary" onPress={() => setCreating(true)}>
              {t('roles.new')}
            </Button>
          )
        }
      />
      {!mayManage && <Notice tone="info">{t('roles.adminsOnly')}</Notice>}
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr>
              <th>{t('field.name')}</th>
              <th>{t('field.description')}</th>
              <th>{t('roles.column.users')}</th>
            </tr>
          </thead>
          <tbody>
            {roles.data?.data.map((role) => (
              <tr key={role.id}>
                <td>
                  {mayManage ? (
                    <Button variant="ghost" onPress={() => setSelected(role)}>
                      {role.name}
                    </Button>
                  ) : (
                    role.name
                  )}
                </td>
                <td className={table.muted}>{role.description}</td>
                <td>{role.userCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {roles.data?.data.length === 0 && <p className={table.empty}>{t('roles.empty')}</p>}
      </div>
      <RoleDialog
        key={creating ? 'new' : selected?.id}
        role={selected}
        isOpen={creating || selected !== undefined}
        onClose={() => {
          setCreating(false)
          setSelected(undefined)
        }}
      />
    </>
  )
}
