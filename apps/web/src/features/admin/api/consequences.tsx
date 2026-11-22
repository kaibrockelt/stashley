// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiOperation, ChangeConsequence } from '@stashley/shared'
import { useEffect, useRef } from 'react'
import { ApiError } from '../../../api/client.ts'
import type { MessageId } from '../../../i18n/locale.ts'
import { useT } from '../../../i18n/use-t.ts'
import { Actions, Button, Notice } from '../../../ui/controls.tsx'

export const apiOperationLabels: Record<ApiOperation, MessageId> = {
  list: 'api.op.list',
  get: 'api.op.get',
  count: 'api.op.count',
  schema: 'api.op.schema',
  create: 'api.op.create',
  update: 'api.op.update',
  replace: 'api.op.replace',
  upsert: 'api.op.upsert',
  delete: 'api.op.delete',
}

/** A refused change: what it would take away (E15) and the confirmation for exactly that. */
export interface PendingConfirmation {
  consequences: ChangeConsequence[]
  confirmation: string
}

/** What a refused change would take away (E15), or undefined for other errors. */
export function consequencesOf(error: unknown): PendingConfirmation | undefined {
  if (!(error instanceof ApiError) || error.code !== 'confirmation_required') return undefined
  const list = error.body.consequences
  return {
    consequences: Array.isArray(list) ? (list as ChangeConsequence[]) : [],
    confirmation: typeof error.body.confirmation === 'string' ? error.body.confirmation : '',
  }
}

/**
 * Lists the consequences of a change and asks to go ahead (E15): nothing is saved until the
 * admin confirms, and the confirmation covers exactly this list. It scrolls into view, since
 * the button that asked may sit at the other end of a long dialog.
 */
export function ConsequencesNotice(props: {
  consequences: ChangeConsequence[]
  onConfirm: () => void
  onCancel: () => void
  isPending?: boolean
}) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const listed = JSON.stringify(props.consequences)
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [listed])
  const line = (consequence: ChangeConsequence) => {
    switch (consequence.kind) {
      case 'api_endpoint_removed':
        return t('consequence.endpointRemoved', {
          operation: t(apiOperationLabels[consequence.operation]),
        })
      case 'api_grant_removed':
        return t('consequence.grantRemoved', {
          token: consequence.tokenName,
          operation: t(apiOperationLabels[consequence.operation]),
        })
      case 'api_alias_changed':
        return t('consequence.aliasChanged', { from: consequence.from, to: consequence.to })
    }
  }
  return (
    <div ref={ref}>
      <Notice tone="info">
        <p>{t('consequence.intro')}</p>
        <ul>
          {props.consequences.map((consequence, index) => (
            <li key={index}>{line(consequence)}</li>
          ))}
        </ul>
        <Actions>
          <Button onPress={props.onCancel}>{t('action.cancel')}</Button>
          <Button variant="danger" onPress={props.onConfirm} isDisabled={props.isPending === true}>
            {t('consequence.confirm')}
          </Button>
        </Actions>
      </Notice>
    </div>
  )
}
