// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react'
import {
  Button as AriaButton,
  Checkbox,
  Dialog as AriaDialog,
  FieldError,
  Heading,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Modal,
  ModalOverlay,
  Popover,
  Select,
  SelectValue,
  Switch,
  Text,
  TextArea,
  TextField as AriaTextField,
  type ButtonProps as AriaButtonProps,
} from 'react-aria-components'
import { useT } from '../i18n/use-t.ts'
import styles from './controls.module.css'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'

/** Button styling for links that navigate (e.g. to an external sign-in page). */
export function buttonClass(variant: Variant = 'secondary'): string {
  return [styles.button, styles[variant]].join(' ')
}

export function Button({
  variant = 'secondary',
  className,
  ...props
}: AriaButtonProps & { variant?: Variant; className?: string }) {
  return (
    <AriaButton
      {...props}
      className={[styles.button, styles[variant], className].filter(Boolean).join(' ')}
    />
  )
}

export function TextField(props: {
  label: string
  name?: string
  type?: 'text' | 'email' | 'password' | 'url' | 'number' | 'date'
  value: string
  onChange: (value: string) => void
  error?: string | undefined
  description?: string
  autoComplete?: string
  autoFocus?: boolean
  isRequired?: boolean
  isReadOnly?: boolean
  inputMode?: 'numeric' | 'text'
  /** The label is read by screen readers only, e.g. in a table row. */
  isLabelHidden?: boolean
}) {
  return (
    <AriaTextField
      className={styles.field}
      value={props.value}
      onChange={props.onChange}
      isInvalid={props.error !== undefined}
      isRequired={props.isRequired ?? false}
      isReadOnly={props.isReadOnly ?? false}
      type={props.type ?? 'text'}
      autoFocus={props.autoFocus ?? false}
      {...(props.name !== undefined && { name: props.name })}
      {...(props.autoComplete !== undefined && { autoComplete: props.autoComplete })}
      {...(props.inputMode !== undefined && { inputMode: props.inputMode })}
    >
      <Label className={props.isLabelHidden === true ? styles.visuallyHidden : styles.label}>
        {props.label}
      </Label>
      <Input className={styles.input} />
      {props.description !== undefined && (
        <Text slot="description" className={styles.description}>
          {props.description}
        </Text>
      )}
      <FieldError className={styles.error}>{props.error}</FieldError>
    </AriaTextField>
  )
}

export function TextAreaField(props: {
  label: string
  value: string
  onChange: (value: string) => void
  error?: string | undefined
  description?: string
  rows?: number
  isMono?: boolean
}) {
  return (
    <AriaTextField
      className={styles.field}
      value={props.value}
      onChange={props.onChange}
      isInvalid={props.error !== undefined}
    >
      <Label className={styles.label}>{props.label}</Label>
      <TextArea
        className={[styles.input, styles.textarea, props.isMono === true && styles.mono]
          .filter(Boolean)
          .join(' ')}
        rows={props.rows ?? 4}
        spellCheck={false}
      />
      {props.description !== undefined && (
        <Text slot="description" className={styles.description}>
          {props.description}
        </Text>
      )}
      <FieldError className={styles.error}>{props.error}</FieldError>
    </AriaTextField>
  )
}

export function CheckboxField(props: {
  label: string
  isSelected: boolean
  onChange: (value: boolean) => void
  isDisabled?: boolean
}) {
  return (
    <Checkbox
      className={styles.checkbox}
      isSelected={props.isSelected}
      onChange={props.onChange}
      isDisabled={props.isDisabled ?? false}
    >
      <span className={styles.box} aria-hidden="true">
        <svg viewBox="0 0 16 16" className={styles.check}>
          <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
        </svg>
      </span>
      {props.label}
    </Checkbox>
  )
}

export function SelectField<K extends string>(props: {
  label: string
  value: K
  onChange: (value: K) => void
  options: { id: K; label: string }[]
  error?: string | undefined
  description?: string | undefined
  /** The label is read by screen readers only, e.g. in a table row. */
  isLabelHidden?: boolean
}) {
  return (
    <Select
      className={styles.field}
      selectedKey={props.value}
      onSelectionChange={(key) => {
        if (key !== null) props.onChange(key as K)
      }}
      isInvalid={props.error !== undefined}
    >
      <Label className={props.isLabelHidden === true ? styles.visuallyHidden : styles.label}>
        {props.label}
      </Label>
      <AriaButton className={styles.select}>
        <SelectValue />
        <span aria-hidden="true" className={styles.chevron}>
          ▾
        </span>
      </AriaButton>
      {props.description !== undefined && (
        <Text slot="description" className={styles.description}>
          {props.description}
        </Text>
      )}
      <FieldError className={styles.error}>{props.error}</FieldError>
      <Popover className={styles.popover}>
        <ListBox className={styles.listbox}>
          {props.options.map((option) => (
            <ListBoxItem key={option.id} id={option.id} className={styles.option}>
              {option.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  )
}

export function SwitchField(props: {
  label: string
  isSelected: boolean
  onChange: (value: boolean) => void
  description?: string
  error?: string | undefined
}) {
  return (
    <div className={styles.switchField}>
      <Switch className={styles.switch} isSelected={props.isSelected} onChange={props.onChange}>
        <span className={styles.track} aria-hidden="true">
          <span className={styles.thumb} />
        </span>
        {props.label}
      </Switch>
      {props.description !== undefined && <p className={styles.description}>{props.description}</p>}
      {props.error !== undefined && <p className={styles.error}>{props.error}</p>}
    </div>
  )
}

export function Notice(props: { tone: 'error' | 'success' | 'info'; children: ReactNode }) {
  return (
    <div
      className={[styles.notice, styles[props.tone]].join(' ')}
      role={props.tone === 'error' ? 'alert' : 'status'}
    >
      {props.children}
    </div>
  )
}

export function Badge(props: {
  tone?: 'neutral' | 'accent' | 'warning' | 'danger' | 'success'
  children: ReactNode
}) {
  return (
    <span className={[styles.badge, styles[`badge_${props.tone ?? 'neutral'}`]].join(' ')}>
      {props.children}
    </span>
  )
}

export function Dialog(props: {
  title: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  isWide?: boolean
}) {
  return (
    <ModalOverlay
      className={styles.overlay}
      isOpen={props.isOpen}
      onOpenChange={props.onOpenChange}
      isDismissable
    >
      <Modal
        className={[styles.modal, props.isWide === true && styles.wide].filter(Boolean).join(' ')}
      >
        <AriaDialog className={styles.dialog}>
          <Heading slot="title" className={styles.dialogTitle}>
            {props.title}
          </Heading>
          {props.children}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  )
}

export function CopyField(props: { label: string; value: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  return (
    <div className={styles.copy}>
      <TextField label={props.label} value={props.value} onChange={() => undefined} isReadOnly />
      <Button
        onPress={() => {
          void navigator.clipboard.writeText(props.value).then(() => setCopied(true))
        }}
      >
        {copied ? t('action.copied') : t('action.copy')}
      </Button>
    </div>
  )
}

export function Form(props: { onSubmit: () => void; children: ReactNode; className?: string }) {
  return (
    <form
      className={[styles.form, props.className].filter(Boolean).join(' ')}
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        props.onSubmit()
      }}
    >
      {props.children}
    </form>
  )
}

export function Actions(props: { children: ReactNode }) {
  return <div className={styles.actions}>{props.children}</div>
}

export function PageHeader(props: { title: string; actions?: ReactNode }) {
  return (
    <header className={styles.pageHeader}>
      <h1 className={styles.pageTitle}>{props.title}</h1>
      {props.actions}
    </header>
  )
}

export function Section(props: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{props.title}</h2>
        {props.aside}
      </div>
      {props.children}
    </section>
  )
}
