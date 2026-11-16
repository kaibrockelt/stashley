// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { FieldOption, FieldOptions, RenderField } from '@stashley/shared'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import {
  ComboBox,
  FieldError,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Text,
  TextField as AriaTextField,
} from 'react-aria-components'
import { api } from '../../../api/client.ts'
import { useT } from '../../../i18n/use-t.ts'
import { CheckboxField, SelectField, SwitchField, TextAreaField } from '../../../ui/controls.tsx'
import controls from '../../../ui/controls.module.css'
import { useDebounced } from '../../../ui/use-debounced.ts'
import { modeFields, usePageContext } from '../page-context.tsx'
import styles from './form.module.css'
import type { InputValue } from './values.ts'

/** A key or value as text; options carry numbers or strings. */
function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  return JSON.stringify(value)
}

export interface FieldProps {
  field: RenderField
  value: InputValue
  onChange: (value: InputValue) => void
  error: string | undefined
  /** The label, with the field's own label or its column name. */
  label: string
  /** The component whose option lists the field uses. */
  componentId: string
  isReadOnly?: boolean
  autoFocus?: boolean
}

/** A text input of a given HTML type, with label, hint and error (§ Formulare). */
function TypedInput(props: FieldProps & { type: string; inputMode?: 'decimal' | 'numeric' }) {
  return (
    <AriaTextField
      className={controls.field}
      value={typeof props.value === 'string' ? props.value : ''}
      onChange={props.onChange}
      isInvalid={props.error !== undefined}
      isRequired={props.field.required}
      isReadOnly={props.isReadOnly ?? false}
      autoFocus={props.autoFocus ?? false}
    >
      <Label className={controls.label}>{props.label}</Label>
      <Input
        className={controls.input}
        type={props.type}
        {...(props.inputMode !== undefined && { inputMode: props.inputMode })}
        {...(props.field.maxLength !== null &&
          props.type === 'text' && { maxLength: props.field.maxLength })}
      />
      {props.field.help !== null && (
        <Text slot="description" className={controls.description}>
          {props.field.help}
        </Text>
      )}
      <FieldError className={controls.error}>{props.error}</FieldError>
    </AriaTextField>
  )
}

/**
 * A searchable selection of a foreign key (§ Auswahllisten): the display value shows, the key
 * is stored. Search runs on the server from one character, 50 hits per page. An exact hit,
 * such as a start number, is taken at once; Enter takes the highlighted option.
 */
function ReferenceInput(props: FieldProps) {
  const t = useT()
  const context = usePageContext()
  const field = props.field
  const url = `/internal/pages/${context.page.id}/components/${props.componentId}/fields/${field.id}/options`
  // What the user types; null while the input shows the chosen option's label.
  const [typed, setTyped] = useState<string | null>(null)
  const [picked, setPicked] = useState<FieldOption | null>(null)
  const search = useDebounced((typed ?? '').trim(), 200)
  const selected = typeof props.value === 'string' && props.value !== '' ? props.value : null
  const request = { ...modeFields(context), filters: context.filters, params: context.params }

  // The label of a value set from outside (edit mode, a default, a page filter).
  const own = picked !== null && text(picked.value) === selected
  const label = useQuery({
    queryKey: [
      'workspace',
      'options',
      context.page.id,
      props.componentId,
      field.id,
      'value',
      selected,
      request,
    ],
    queryFn: () => api<FieldOptions>('POST', url, { ...request, values: [selected] }),
    enabled: selected !== null && !own,
    retry: false,
  })
  const chosen: FieldOption | null =
    selected === null ? null : own ? picked : (label.data?.options[0] ?? null)
  const typing = typed !== null && search !== ''
  const options = useQuery({
    queryKey: [
      'workspace',
      'options',
      context.page.id,
      props.componentId,
      field.id,
      search,
      request,
    ],
    queryFn: () => api<FieldOptions>('POST', url, { ...request, search }),
    enabled: typing,
    retry: false,
  })
  const take = (option: FieldOption | undefined) => {
    if (option === undefined) return
    setPicked(option)
    setTyped(null)
    props.onChange(text(option.value))
  }
  // A start number typed in full is taken without another step.
  const exact = options.data?.exact
  const lastExact = useRef<unknown>(undefined)
  useEffect(() => {
    if (exact === undefined || exact === lastExact.current || !typing) return
    lastExact.current = exact
    take(options.data?.options.find((option) => option.value === exact))
  })

  const items = typing ? (options.data?.options ?? []) : chosen === null ? [] : [chosen]
  return (
    <div className={styles.reference}>
      <ComboBox
        className={controls.field}
        inputValue={typed ?? chosen?.label ?? ''}
        onInputChange={(value) => {
          setTyped(value)
          if (value === '') {
            setPicked(null)
            props.onChange(null)
          }
        }}
        selectedKey={selected}
        onSelectionChange={(key) => {
          if (key === null) return
          take(items.find((option) => text(option.value) === text(key)))
        }}
        items={items.map((option) => ({ id: text(option.value), option }))}
        isInvalid={props.error !== undefined}
        isRequired={field.required}
        isReadOnly={props.isReadOnly ?? false}
        allowsEmptyCollection
        menuTrigger="input"
        autoFocus={props.autoFocus ?? false}
      >
        <Label className={controls.label}>{props.label}</Label>
        <Input className={controls.input} placeholder={t('form.reference.placeholder')} />
        {field.help !== null && (
          <Text slot="description" className={controls.description}>
            {field.help}
          </Text>
        )}
        <FieldError className={controls.error}>{props.error}</FieldError>
        <Popover className={controls.popover}>
          <ListBox
            className={controls.listbox}
            renderEmptyState={() => (
              <div className={styles.empty}>
                {options.isFetching ? t('form.reference.searching') : t('form.reference.none')}
              </div>
            )}
          >
            {(item: { id: string; option: FieldOption }) => (
              <ListBoxItem id={item.id} className={controls.option} textValue={item.option.label}>
                {item.option.label}
              </ListBoxItem>
            )}
          </ListBox>
        </Popover>
      </ComboBox>
      {chosen?.extras !== undefined && field.reference !== undefined && (
        <dl className={styles.extras}>
          {field.reference.extras.map((extra) => (
            <div key={extra.id}>
              <dt>{extra.label}</dt>
              <dd>{text(chosen.extras?.[extra.id]) || '–'}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

function SetInput(props: FieldProps) {
  const chosen = Array.isArray(props.value) ? props.value : []
  return (
    <fieldset className={styles.set}>
      <legend className={controls.label}>{props.label}</legend>
      {(props.field.enumValues ?? []).map((option) => (
        <CheckboxField
          key={option}
          label={option}
          isSelected={chosen.includes(option)}
          isDisabled={props.isReadOnly ?? false}
          onChange={(selected) =>
            props.onChange(
              (props.field.enumValues ?? []).filter((entry) =>
                entry === option ? selected : chosen.includes(entry),
              ),
            )
          }
        />
      ))}
      {props.error !== undefined && <p className={controls.error}>{props.error}</p>}
    </fieldset>
  )
}

/** The input of one field, by its widget (§ Formulare: Feldtypen). */
export function FieldInput(props: FieldProps) {
  const t = useT()
  const field = props.field
  switch (field.widget) {
    case 'reference':
      return <ReferenceInput {...props} />
    case 'switch':
      return (
        <SwitchField
          label={props.label}
          isSelected={props.value === true}
          onChange={props.onChange}
          error={props.error}
          {...(field.help !== null && { description: field.help })}
        />
      )
    case 'textarea':
      return (
        <TextAreaField
          label={props.label}
          value={typeof props.value === 'string' ? props.value : ''}
          onChange={props.onChange}
          error={props.error}
          rows={3}
          {...(field.help !== null && { description: field.help })}
        />
      )
    case 'select':
      return (
        <SelectField
          label={props.label}
          value={typeof props.value === 'string' ? props.value : ''}
          onChange={(value) => props.onChange(value === '' ? null : value)}
          error={props.error}
          {...(field.help !== null && { description: field.help })}
          options={[
            ...(field.required ? [] : [{ id: '', label: t('form.select.none') }]),
            ...(field.enumValues ?? []).map((value) => ({ id: value, label: value })),
          ]}
        />
      )
    case 'multiselect':
      return <SetInput {...props} />
    case 'number':
    case 'year':
      return (
        <TypedInput
          {...props}
          type="text"
          inputMode={field.kind === 'decimal' || field.kind === 'float' ? 'decimal' : 'numeric'}
        />
      )
    case 'date':
      return <TypedInput {...props} type="date" />
    case 'datetime':
      return <TypedInput {...props} type="datetime-local" />
    case 'time':
      return <TypedInput {...props} type="time" />
    default:
      return <TypedInput {...props} type="text" />
  }
}
