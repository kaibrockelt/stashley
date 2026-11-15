// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { FieldError, PageDocument, PageIssue } from '@stashley/shared'
import { componentsOf } from '@stashley/shared'
import type { MessageId } from '../../i18n/locale.ts'
import { useT } from '../../i18n/use-t.ts'
import { Notice } from '../../ui/controls.tsx'
import styles from './editor.module.css'

/** Texts of the configuration checks (§8.6); unknown codes fall back to a generic text. */
const issueTexts: Record<string, MessageId> = {
  version_missing: 'issue.version_missing',
  query_missing: 'issue.query_missing',
  query_not_readable: 'issue.query_not_readable',
  grant_missing: 'issue.grant_missing',
  parameter_not_bindable: 'issue.parameter_not_bindable',
  unknown_input: 'issue.unknown_input',
  object_not_exposed: 'issue.object_not_exposed',
  object_not_readable: 'issue.object_not_readable',
  unknown_role: 'issue.unknown_role',
  duplicate: 'issue.duplicate',
  reserved: 'issue.reserved',
  view_read_only: 'issue.view_read_only',
  restriction_widens: 'issue.restriction_widens',
  unknown_source: 'issue.unknown_source',
  exceeds_ceiling: 'issue.exceeds_ceiling',
  settings_missing: 'issue.settings_missing',
  settings_invalid: 'issue.settings_invalid',
  mapping_broken: 'issue.mapping_broken',
  mapping_unsuitable: 'issue.mapping_unsuitable',
  columns_unknown: 'issue.columns_unknown',
  required_field_missing: 'issue.required_field_missing',
  excluded_column: 'issue.excluded_column',
  unknown_column: 'issue.unknown_column',
  unknown_relation: 'issue.unknown_relation',
  relation_ambiguous: 'issue.relation_ambiguous',
  field_not_writable: 'issue.field_not_writable',
  auto_increment: 'issue.auto_increment',
  key_not_writable: 'issue.key_not_writable',
  widget_unsuitable: 'issue.widget_unsuitable',
  generator_unsuitable: 'issue.generator_unsuitable',
  default_unsuitable: 'issue.default_unsuitable',
  invalid: 'issue.invalid',
  too_long: 'issue.too_long',
  too_many_decimals: 'issue.too_many_decimals',
  out_of_range: 'issue.out_of_range',
  not_allowed: 'issue.not_allowed',
  upsert_key_missing: 'issue.upsert_key_missing',
  upsert_key_invalid: 'issue.upsert_key_invalid',
  upsert_key_not_in_form: 'issue.upsert_key_not_in_form',
  record_missing: 'issue.record_missing',
  inline_without_update: 'issue.inline_without_update',
  invalid_expression: 'issue.invalid_expression',
}

export function useIssueText(): (issue: Pick<PageIssue, 'code' | 'params'>) => string {
  const t = useT()
  return (issue) => {
    const id = issueTexts[issue.code]
    const params = { column: '', role: '', field: '', ...issue.params }
    return id === undefined ? t('issue.other', { code: issue.code }) : t(id, params)
  }
}

/** Issues whose path lies inside `prefix`, e.g. `rows.0.blocks.1`. */
export function issuesAt(issues: readonly PageIssue[], prefix: string): PageIssue[] {
  return issues.filter((issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`))
}

/** Field errors of a rejected save or publish, as issues (§8.6). */
export function issuesOf(errors: readonly FieldError[]): PageIssue[] {
  return errors.map((error) => ({
    path: error.field,
    code: error.code,
    severity: 'error',
    ...(error.params !== undefined && { params: error.params }),
  }))
}

/** The title of the block an issue lies in, or undefined for page-wide issues. */
export function blockOf(document: PageDocument, path: string): string | undefined {
  const entry = componentsOf(document).find(
    (candidate) => path === candidate.path || path.startsWith(`${candidate.path}.`),
  )
  return entry === undefined ? undefined : entry.component.title || entry.component.id
}

export function IssueList(props: {
  issues: readonly PageIssue[]
  /** Names the block of each issue, for lists that cover the whole page. */
  document?: PageDocument
}) {
  const t = useT()
  const text = useIssueText()
  if (props.issues.length === 0) return null
  const where = (issue: PageIssue) => {
    if (props.document === undefined) return ''
    const block = blockOf(props.document, issue.path)
    return block === undefined ? '' : `${t('issue.inBlock', { title: block })} `
  }
  const errors = props.issues.filter((issue) => issue.severity === 'error')
  return (
    <Notice tone={errors.length > 0 ? 'error' : 'info'}>
      <ul className={styles.issues}>
        {props.issues.map((issue, index) => (
          <li key={`${issue.path}:${issue.code}:${index}`}>
            <strong>{issue.severity === 'error' ? t('issue.error') : t('issue.warning')}:</strong>{' '}
            {where(issue)}
            {text(issue)}
          </li>
        ))}
      </ul>
    </Notice>
  )
}
