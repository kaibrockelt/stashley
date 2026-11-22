// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { PageDocument, PageFilter, ParamType } from '@stashley/shared'
import { features, paramTypes } from '@stashley/shared'
import { useState } from 'react'
import type { MessageId } from '../../i18n/locale.ts'
import { useT } from '../../i18n/use-t.ts'
import {
  Actions,
  Button,
  CheckboxField,
  Dialog,
  Form,
  Notice,
  SelectField,
  SwitchField,
  TextAreaField,
  TextField,
} from '../../ui/controls.tsx'
import { useQueries, useQueryDetail, useRoles } from '../design/design-api.ts'
import { unsetId } from './block-dialog.tsx'
import {
  newId,
  setViewers,
  unknownPrincipals,
  withDescription,
  withoutPrincipals,
} from './document-ops.ts'
import styles from './editor.module.css'

const typeLabels: Record<ParamType, MessageId> = {
  string: 'variables.type.string',
  integer: 'variables.type.integer',
  decimal: 'variables.type.decimal',
  date: 'variables.type.date',
  datetime: 'variables.type.datetime',
  boolean: 'variables.type.boolean',
}

function SelectFilterFields(props: {
  filter: Extract<PageFilter, { kind: 'select' }>
  onChange: (filter: PageFilter) => void
}) {
  const t = useT()
  const queries = useQueries()
  const detail = useQueryDetail(
    props.filter.source.queryId === unsetId ? undefined : props.filter.source.queryId,
  )
  const columns = detail.data?.current.resultColumns?.map((column) => column.name) ?? []
  const columnField = (label: string, value: string, key: 'valueColumn' | 'labelColumn') =>
    columns.length > 0 ? (
      <SelectField
        label={label}
        value={value}
        onChange={(next) => props.onChange({ ...props.filter, [key]: next })}
        options={columns.map((id) => ({ id, label: id }))}
      />
    ) : (
      <TextField
        label={label}
        value={value}
        onChange={(next) => props.onChange({ ...props.filter, [key]: next })}
      />
    )
  return (
    <>
      <SelectField
        label={t('editor.filter.query')}
        value={props.filter.source.queryId}
        onChange={(queryId) =>
          props.onChange({ ...props.filter, source: { kind: 'query', queryId } })
        }
        options={[
          { id: unsetId, label: t('editor.choose') },
          ...(queries.data ?? []).map((query) => ({ id: query.id, label: query.name })),
        ]}
      />
      {columnField(t('editor.filter.valueColumn'), props.filter.valueColumn, 'valueColumn')}
      {columnField(t('editor.filter.labelColumn'), props.filter.labelColumn, 'labelColumn')}
      <CheckboxField
        label={t('editor.filter.multiple')}
        isSelected={props.filter.multiple}
        onChange={(multiple) => props.onChange({ ...props.filter, multiple })}
      />
    </>
  )
}

/** Title, visibility, page filters, URL parameters and MCP availability of a page. */
export function PageSettingsDialog(props: {
  document: PageDocument
  onSave: (document: PageDocument) => void
  onClose: () => void
}) {
  const t = useT()
  const roles = useRoles()
  const [document, setDocument] = useState(props.document)
  const view = document.access.view
  // Only once the roles are known, so a slow load never looks like deleted roles.
  const deleted =
    roles.data === undefined
      ? []
      : unknownPrincipals(
          document,
          roles.data.map((role) => role.id),
        )
  const toggleViewer = (principal: string, selected: boolean) =>
    setDocument(
      setViewers(
        document,
        selected ? [...view, principal] : view.filter((entry) => entry !== principal),
      ),
    )
  const setFilter = (index: number, filter: PageFilter) =>
    setDocument({
      ...document,
      filters: document.filters.map((entry, i) => (i === index ? filter : entry)),
    })
  const addFilter = (kind: PageFilter['kind']) => {
    const id = newId(document, 'f')
    const filter: PageFilter =
      kind === 'date'
        ? { kind, id, label: t('editor.filter.date'), range: false, required: false }
        : kind === 'text'
          ? { kind, id, label: t('editor.filter.text'), required: false }
          : {
              kind,
              id,
              label: t('editor.filter.select'),
              source: { kind: 'query', queryId: unsetId },
              valueColumn: 'id',
              labelColumn: 'label',
              multiple: false,
              required: false,
            }
    setDocument({ ...document, filters: [...document.filters, filter] })
  }
  return (
    <Dialog
      title={t('editor.pageSettings')}
      isOpen
      isWide
      onOpenChange={(open) => !open && props.onClose()}
    >
      <Form onSubmit={() => props.onSave(document)}>
        <div className={styles.dialogGrid}>
          <div className={styles.dialogColumn}>
            <TextField
              label={t('field.title')}
              value={document.title}
              onChange={(title) => setDocument({ ...document, title })}
              isRequired
            />
            <TextAreaField
              label={t('field.description')}
              value={document.description ?? ''}
              onChange={(description) => {
                setDocument(withDescription(document, description))
              }}
              {...(features.mcp && { description: t('editor.descriptionHint') })}
              rows={3}
            />
            <fieldset className={styles.fieldset}>
              <legend>{t('editor.viewers')}</legend>
              <p className={styles.muted}>{t('editor.viewersHint')}</p>
              <CheckboxField
                label={t('editor.everyone')}
                isSelected={view.includes('authenticated')}
                onChange={(selected) => toggleViewer('authenticated', selected)}
              />
              {(roles.data ?? []).map((role) => (
                <CheckboxField
                  key={role.id}
                  label={role.name}
                  isSelected={view.includes(role.id)}
                  onChange={(selected) => toggleViewer(role.id, selected)}
                />
              ))}
              {deleted.length > 0 && (
                <Notice tone="info">
                  <p>{t('editor.deletedRoles', { count: deleted.length })}</p>
                  <Button onPress={() => setDocument(withoutPrincipals(document, deleted))}>
                    {t('editor.removeDeletedRoles')}
                  </Button>
                </Notice>
              )}
            </fieldset>
            {features.mcp && (
              <SwitchField
                label={t('editor.mcp')}
                description={t('editor.mcpHint')}
                isSelected={document.mcp.available}
                onChange={(available) => setDocument({ ...document, mcp: { available } })}
              />
            )}
          </div>
          <div className={styles.dialogColumn}>
            <fieldset className={styles.fieldset}>
              <legend>{t('editor.filters')}</legend>
              {document.filters.map((filter, index) => (
                <div key={filter.id} className={styles.card}>
                  <div className={styles.inline}>
                    <TextField
                      label={t('editor.filter.label')}
                      value={filter.label}
                      onChange={(label) => setFilter(index, { ...filter, label })}
                    />
                    <code className={styles.muted}>{filter.id}</code>
                    <Button
                      variant="ghost"
                      onPress={() =>
                        setDocument({
                          ...document,
                          filters: document.filters.filter((_, i) => i !== index),
                        })
                      }
                    >
                      {t('action.delete')}
                    </Button>
                  </div>
                  {filter.kind === 'date' && (
                    <CheckboxField
                      label={t('editor.filter.range')}
                      isSelected={filter.range}
                      onChange={(range) => setFilter(index, { ...filter, range })}
                    />
                  )}
                  {filter.kind === 'select' && (
                    <SelectFilterFields
                      filter={filter}
                      onChange={(next) => setFilter(index, next)}
                    />
                  )}
                  <CheckboxField
                    label={t('editor.filter.required')}
                    isSelected={filter.required}
                    onChange={(required) => setFilter(index, { ...filter, required })}
                  />
                </div>
              ))}
              {document.filters.length < 20 && (
                <div className={styles.inline}>
                  <Button variant="ghost" onPress={() => addFilter('date')}>
                    {t('editor.filter.addDate')}
                  </Button>
                  <Button variant="ghost" onPress={() => addFilter('select')}>
                    {t('editor.filter.addSelect')}
                  </Button>
                  <Button variant="ghost" onPress={() => addFilter('text')}>
                    {t('editor.filter.addText')}
                  </Button>
                </div>
              )}
            </fieldset>
            <fieldset className={styles.fieldset}>
              <legend>{t('editor.urlParameters')}</legend>
              <p className={styles.muted}>{t('editor.urlParametersHint')}</p>
              {document.parameters.map((parameter, index) => (
                <div key={index} className={styles.inline}>
                  <TextField
                    label={t('field.name')}
                    value={parameter.name}
                    onChange={(name) =>
                      setDocument({
                        ...document,
                        parameters: document.parameters.map((entry, i) =>
                          i === index ? { ...entry, name } : entry,
                        ),
                      })
                    }
                  />
                  <SelectField
                    label={t('variables.column.type')}
                    value={parameter.type}
                    onChange={(type) =>
                      setDocument({
                        ...document,
                        parameters: document.parameters.map((entry, i) =>
                          i === index ? { ...entry, type } : entry,
                        ),
                      })
                    }
                    options={paramTypes.map((id) => ({ id, label: t(typeLabels[id]) }))}
                  />
                  <Button
                    variant="ghost"
                    onPress={() =>
                      setDocument({
                        ...document,
                        parameters: document.parameters.filter((_, i) => i !== index),
                      })
                    }
                  >
                    {t('action.delete')}
                  </Button>
                </div>
              ))}
              {document.parameters.length < 20 && (
                <Button
                  variant="ghost"
                  onPress={() =>
                    setDocument({
                      ...document,
                      parameters: [
                        ...document.parameters,
                        {
                          name: `param_${document.parameters.length + 1}`,
                          type: 'integer',
                          list: false,
                        },
                      ],
                    })
                  }
                >
                  {t('editor.addUrlParameter')}
                </Button>
              )}
            </fieldset>
          </div>
        </div>
        <Actions>
          <Button onPress={props.onClose}>{t('action.cancel')}</Button>
          <Button type="submit" variant="primary">
            {t('editor.applyBlock')}
          </Button>
        </Actions>
      </Form>
    </Dialog>
  )
}
