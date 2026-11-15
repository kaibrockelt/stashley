// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useT } from '../../i18n/use-t.ts'
import { Actions, Button, CheckboxField, Dialog } from '../../ui/controls.tsx'
import { useRoles } from '../design/design-api.ts'
import styles from './workspace.module.css'

/** Chooses the roles whose rights a preview uses (§8.5); `authenticated` always applies. */
export function PreviewRolesDialog(props: { selected: readonly string[]; onClose: () => void }) {
  const t = useT()
  const roles = useRoles()
  const navigate = useNavigate()
  const [selected, setSelected] = useState<string[]>([...props.selected])
  return (
    <Dialog title={t('preview.choose')} isOpen onOpenChange={(open) => !open && props.onClose()}>
      <p>{t('preview.chooseText')}</p>
      {(roles.data ?? []).map((role) => (
        <CheckboxField
          key={role.id}
          label={role.name}
          isSelected={selected.includes(role.id)}
          onChange={(on) =>
            setSelected(on ? [...selected, role.id] : selected.filter((id) => id !== role.id))
          }
        />
      ))}
      <Actions>
        <Button onPress={props.onClose}>{t('action.cancel')}</Button>
        <Button
          variant="primary"
          onPress={() => {
            props.onClose()
            void navigate({
              to: '.',
              search: {
                mode: 'preview',
                ...(selected.length > 0 && { roles: selected.join(',') }),
              },
            })
          }}
        >
          {t('preview.start')}
        </Button>
      </Actions>
    </Dialog>
  )
}

/** Shown above a page in preview: whose rights apply, and the way back to editing. */
export function PreviewBar(props: { roles: readonly string[]; empty: boolean }) {
  const t = useT()
  const roles = useRoles()
  const navigate = useNavigate()
  const [choosing, setChoosing] = useState(false)
  const names = props.roles.map((id) => roles.data?.find((role) => role.id === id)?.name ?? id)
  return (
    <div className={styles.banner} role="status">
      <strong>{t('preview.title')}</strong>
      <span>
        {names.length === 0
          ? t('preview.onlyEveryone')
          : t('preview.as', { roles: names.join(', ') })}
      </span>
      {props.empty && <span>{t('preview.nothing')}</span>}
      <Button variant="ghost" onPress={() => setChoosing(true)}>
        {t('preview.change')}
      </Button>
      <Button variant="ghost" onPress={() => void navigate({ to: '.', search: { mode: 'edit' } })}>
        {t('preview.back')}
      </Button>
      {choosing && <PreviewRolesDialog selected={props.roles} onClose={() => setChoosing(false)} />}
    </div>
  )
}
