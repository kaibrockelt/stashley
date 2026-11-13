// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { CatalogObject, RelationKind } from '@stashley/shared'
import { relationKinds } from '@stashley/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../api/client.ts'
import { useErrorText } from '../../../i18n/errors.ts'
import { useT } from '../../../i18n/use-t.ts'
import { Actions, Button, Dialog, Form, Notice, SelectField } from '../../../ui/controls.tsx'
import styles from './connections.module.css'
import { relationKindLabels } from './texts.tsx'

export function RelationDialog(props: {
  connectionId: string
  objects: CatalogObject[]
  onClose: () => void
}) {
  const t = useT()
  const errors = useErrorText()
  const client = useQueryClient()
  const first = props.objects[0]
  const [source, setSource] = useState(first?.name ?? '')
  const [sourceColumn, setSourceColumn] = useState(first?.columns[0]?.name ?? '')
  const [target, setTarget] = useState(first?.name ?? '')
  const [targetColumn, setTargetColumn] = useState(first?.columns[0]?.name ?? '')
  const [kind, setKind] = useState<RelationKind>('many_to_one')
  const columnsOf = (name: string) =>
    (props.objects.find((object) => object.name === name)?.columns ?? []).map((column) => ({
      id: column.name,
      label: column.name,
    }))
  const objectOptions = props.objects.map((object) => ({ id: object.name, label: object.name }))
  const save = useMutation({
    mutationFn: () =>
      api('POST', '/internal/admin/relations', {
        connectionId: props.connectionId,
        sourceObject: source,
        sourceColumn,
        targetObject: target,
        targetColumn,
        kind,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['admin', 'connection', props.connectionId] })
      props.onClose()
    },
  })
  return (
    <Dialog title={t('relations.add')} isOpen onOpenChange={(open) => !open && props.onClose()}>
      <Form onSubmit={() => save.mutate()}>
        {save.error !== null && errors.message(save.error) !== undefined && (
          <Notice tone="error">{errors.message(save.error)}</Notice>
        )}
        <p className={styles.muted}>{t('relations.add.hint')}</p>
        <div className={styles.grid}>
          <SelectField
            label={t('relations.source')}
            value={source}
            onChange={(name) => {
              setSource(name)
              setSourceColumn(columnsOf(name)[0]?.id ?? '')
            }}
            options={objectOptions}
            error={errors.field(save.error, 'sourceObject')}
          />
          <SelectField
            label={t('relations.sourceColumn')}
            value={sourceColumn}
            onChange={setSourceColumn}
            options={columnsOf(source)}
            error={errors.field(save.error, 'sourceColumn')}
          />
        </div>
        <div className={styles.grid}>
          <SelectField
            label={t('relations.target')}
            value={target}
            onChange={(name) => {
              setTarget(name)
              setTargetColumn(columnsOf(name)[0]?.id ?? '')
            }}
            options={objectOptions}
            error={errors.field(save.error, 'targetObject')}
          />
          <SelectField
            label={t('relations.targetColumn')}
            value={targetColumn}
            onChange={setTargetColumn}
            options={columnsOf(target)}
            error={errors.field(save.error, 'targetColumn')}
          />
        </div>
        <SelectField
          label={t('relations.kind')}
          value={kind}
          onChange={setKind}
          options={relationKinds.map((id) => ({ id, label: t(relationKindLabels[id]) }))}
        />
        <Actions>
          <Button onPress={props.onClose}>{t('action.cancel')}</Button>
          <Button type="submit" variant="primary" isDisabled={save.isPending}>
            {t('action.save')}
          </Button>
        </Actions>
      </Form>
    </Dialog>
  )
}
