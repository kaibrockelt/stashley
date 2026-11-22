// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { InstanceVariable, ParamType } from '@stashley/shared'
import { paramTypes } from '@stashley/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client.ts'
import { useErrorText } from '../../i18n/errors.ts'
import { useFormatDateTime } from '../../i18n/format.ts'
import type { MessageId } from '../../i18n/locale.ts'
import { useT } from '../../i18n/use-t.ts'
import {
  Actions,
  Button,
  Dialog,
  Form,
  Notice,
  PageHeader,
  SelectField,
  SwitchField,
  TextAreaField,
  TextField,
} from '../../ui/controls.tsx'
import table from '../../ui/table.module.css'
import { ScrollArea } from '../../ui/scroll-area.tsx'

const variablesKey = ['design', 'variables'] as const

const typeLabels: Record<ParamType, MessageId> = {
  string: 'variables.type.string',
  integer: 'variables.type.integer',
  decimal: 'variables.type.decimal',
  date: 'variables.type.date',
  datetime: 'variables.type.datetime',
  boolean: 'variables.type.boolean',
}

const typeHints: Partial<Record<ParamType, MessageId>> = {
  date: 'variables.hint.date',
  datetime: 'variables.hint.datetime',
}

function VariableDialog(props: {
  variable: InstanceVariable | undefined
  isOpen: boolean
  onClose: () => void
}) {
  const t = useT()
  const errors = useErrorText()
  const client = useQueryClient()
  const variable = props.variable
  const [name, setName] = useState(variable?.name ?? '')
  const [type, setType] = useState<ParamType>(variable?.type ?? 'integer')
  const [text, setText] = useState(
    variable === undefined || typeof variable.value === 'boolean' ? '' : String(variable.value),
  )
  const [flag, setFlag] = useState(variable?.value === true)
  const [description, setDescription] = useState(variable?.description ?? '')
  const [confirming, setConfirming] = useState(false)
  const value = type === 'boolean' ? flag : text.trim()
  const done = async () => {
    await client.invalidateQueries({ queryKey: variablesKey })
    props.onClose()
  }
  const save = useMutation({
    mutationFn: () =>
      variable === undefined
        ? api<InstanceVariable>('POST', '/internal/design/variables', {
            name,
            type,
            value,
            description,
          })
        : api<InstanceVariable>('PATCH', `/internal/design/variables/${variable.id}`, {
            type,
            value,
            description,
          }),
    onSuccess: done,
  })
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/internal/design/variables/${variable?.id ?? ''}`),
    onSuccess: done,
  })
  const error = save.error ?? remove.error
  const hint = typeHints[type]
  return (
    <Dialog
      title={variable === undefined ? t('variables.new') : variable.name}
      isOpen={props.isOpen}
      onOpenChange={(open) => !open && props.onClose()}
    >
      <Form onSubmit={() => save.mutate()}>
        {error !== null && errors.message(error) !== undefined && (
          <Notice tone="error">{errors.message(error)}</Notice>
        )}
        {variable === undefined && (
          <TextField
            label={t('field.name')}
            value={name}
            onChange={setName}
            error={errors.field(save.error, 'name')}
            description={t('variables.hint.name')}
            autoFocus
            isRequired
          />
        )}
        <SelectField
          label={t('variables.column.type')}
          value={type}
          onChange={setType}
          options={paramTypes.map((id) => ({ id, label: t(typeLabels[id]) }))}
        />
        {type === 'boolean' ? (
          <SwitchField label={t('variables.column.value')} isSelected={flag} onChange={setFlag} />
        ) : (
          <TextField
            label={t('variables.column.value')}
            value={text}
            onChange={setText}
            error={errors.field(save.error, 'value')}
            {...(hint !== undefined && { description: t(hint) })}
            inputMode={type === 'integer' || type === 'decimal' ? 'numeric' : 'text'}
            isRequired
          />
        )}
        <TextAreaField
          label={t('field.description')}
          value={description}
          onChange={setDescription}
          error={errors.field(save.error, 'description')}
          rows={2}
        />
        {confirming && <Notice tone="info">{t('variables.delete.confirm')}</Notice>}
        <Actions>
          {variable !== undefined &&
            (confirming ? (
              <Button
                variant="danger"
                onPress={() => remove.mutate()}
                isDisabled={remove.isPending}
              >
                {t('variables.delete')}
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

export function VariablesPage() {
  const t = useT()
  const formatDate = useFormatDateTime()
  const variables = useQuery({
    queryKey: variablesKey,
    queryFn: () => api<{ data: InstanceVariable[] }>('GET', '/internal/design/variables'),
  })
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<InstanceVariable>()
  const shown = (variable: InstanceVariable) =>
    typeof variable.value === 'boolean'
      ? t(variable.value ? 'status.on' : 'status.off')
      : String(variable.value)
  return (
    <>
      <PageHeader
        title={t('variables.title')}
        actions={
          <Button variant="primary" onPress={() => setCreating(true)}>
            {t('variables.new')}
          </Button>
        }
      />
      <ScrollArea>
        <table className={table.table}>
          <thead>
            <tr>
              <th>{t('field.name')}</th>
              <th>{t('variables.column.type')}</th>
              <th>{t('variables.column.value')}</th>
              <th>{t('field.description')}</th>
              <th>{t('variables.column.updated')}</th>
            </tr>
          </thead>
          <tbody>
            {variables.data?.data.map((variable) => (
              <tr key={variable.id}>
                <td>
                  <Button variant="ghost" onPress={() => setSelected(variable)}>
                    <code>{variable.name}</code>
                  </Button>
                </td>
                <td>{t(typeLabels[variable.type])}</td>
                <td>{shown(variable)}</td>
                <td className={table.muted}>{variable.description}</td>
                <td className={table.muted}>
                  {formatDate(variable.updatedAt)}
                  {variable.updatedBy !== null && ` · ${variable.updatedBy}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {variables.data?.data.length === 0 && <p className={table.empty}>{t('variables.empty')}</p>}
      </ScrollArea>
      <VariableDialog
        key={creating ? 'new' : selected?.id}
        variable={selected}
        isOpen={creating || selected !== undefined}
        onClose={() => {
          setCreating(false)
          setSelected(undefined)
        }}
      />
    </>
  )
}
