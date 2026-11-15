// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { PageIssue } from '@stashley/shared'
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

export function IssueList(props: { issues: readonly PageIssue[] }) {
  const t = useT()
  const text = useIssueText()
  if (props.issues.length === 0) return null
  const errors = props.issues.filter((issue) => issue.severity === 'error')
  return (
    <Notice tone={errors.length > 0 ? 'error' : 'info'}>
      <ul className={styles.issues}>
        {props.issues.map((issue, index) => (
          <li key={`${issue.path}:${issue.code}:${index}`}>
            <strong>{issue.severity === 'error' ? t('issue.error') : t('issue.warning')}:</strong>{' '}
            {text(issue)}
          </li>
        ))}
      </ul>
    </Notice>
  )
}
