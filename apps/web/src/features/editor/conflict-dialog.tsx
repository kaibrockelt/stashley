// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { PageDetail, PageDocument } from '@stashley/shared'
import { useT } from '../../i18n/use-t.ts'
import { Actions, Button, Dialog } from '../../ui/controls.tsx'
import { ChangeList } from './changes.tsx'

/**
 * Another manager saved the draft in the meantime (§13.2, E2). The dialog shows what the own
 * version changes against the current draft; nothing is overwritten without a decision.
 */
export function ConflictDialog(props: {
  current: PageDetail
  mine: PageDocument
  onTakeCurrent: () => void
  onKeepMine: () => void
  onClose: () => void
  busy: boolean
}) {
  const t = useT()
  return (
    <Dialog
      title={t('editor.conflict.title')}
      isOpen
      isWide
      onOpenChange={(open) => !open && props.onClose()}
    >
      <p>{t('editor.conflict.text', { revision: props.current.draftRevision })}</p>
      <ChangeList before={props.current.draft} after={props.mine} />
      <Actions>
        <Button onPress={props.onTakeCurrent}>{t('editor.conflict.takeCurrent')}</Button>
        <Button variant="danger" onPress={props.onKeepMine} isDisabled={props.busy}>
          {t('editor.conflict.keepMine')}
        </Button>
      </Actions>
    </Dialog>
  )
}
