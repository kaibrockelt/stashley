// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AccessWarning,
  CredentialPurpose,
  GrantReport,
  GrantWarning,
  ImpactItem,
  RelationKind,
  SchemaDiff,
  TableOp,
  TlsMode,
} from '@stashley/shared'
import type { MessageId } from '../../../i18n/locale.ts'
import { useT } from '../../../i18n/use-t.ts'
import { Badge } from '../../../ui/controls.tsx'
import styles from './connections.module.css'

export const connectionsKey = ['admin', 'connections'] as const

export const purposeLabels: Record<CredentialPurpose, MessageId> = {
  read: 'connections.user.read',
  write: 'connections.user.write',
  schema: 'connections.user.schema',
}

export const purposeHints: Record<CredentialPurpose, MessageId> = {
  read: 'connections.user.read.hint',
  write: 'connections.user.write.hint',
  schema: 'connections.user.schema.hint',
}

export const tlsLabels: Record<TlsMode, MessageId> = {
  disabled: 'connections.tls.disabled',
  required: 'connections.tls.required',
  'verify-ca': 'connections.tls.verifyCa',
  'verify-full': 'connections.tls.verifyFull',
}

export const opLabels: Record<TableOp, MessageId> = {
  read: 'access.op.read',
  create: 'access.op.create',
  update: 'access.op.update',
  delete: 'access.op.delete',
}

export const relationKindLabels: Record<RelationKind, MessageId> = {
  many_to_one: 'relations.kind.manyToOne',
  one_to_one: 'relations.kind.oneToOne',
}

const warningLabels: Record<GrantWarning['code'], MessageId> = {
  global_privilege: 'grants.warning.global',
  other_schema: 'grants.warning.otherSchema',
  excess_privilege: 'grants.warning.excess',
  grant_option: 'grants.warning.grantOption',
  routine_privilege: 'grants.warning.routine',
  proxy: 'grants.warning.proxy',
  unparsed: 'grants.warning.unparsed',
  inactive_role: 'grants.warning.inactiveRole',
  role_unreadable: 'grants.warning.roleUnreadable',
}

const accessWarningLabels: Record<AccessWarning['code'], MessageId> = {
  ops_without_grant: 'access.warning.opsWithoutGrant',
  no_write_user: 'access.warning.noWriteUser',
  view_without_key: 'access.warning.viewWithoutKey',
  not_in_schema: 'access.warning.notInSchema',
  template_invalid: 'access.warning.templateInvalid',
  key_mismatch: 'access.warning.keyMismatch',
}

const impactLabels: Record<ImpactItem['kind'], MessageId> = {
  table_access: 'drift.impact.tableAccess',
  column_exclusion: 'drift.impact.exclusion',
  display_template: 'drift.impact.template',
  relation: 'drift.impact.relation',
}

const reasonLabels: Record<ImpactItem['reason'], MessageId> = {
  object_removed: 'drift.reason.objectRemoved',
  column_removed: 'drift.reason.columnRemoved',
  column_changed: 'drift.reason.columnChanged',
  key_changed: 'drift.reason.keyChanged',
  type_changed: 'drift.reason.typeChanged',
}

export function GrantSummary(props: { report: GrantReport | null }) {
  const t = useT()
  const report = props.report
  if (report === null) return <p className={styles.muted}>{t('grants.unchecked')}</p>
  return (
    <div className={styles.grants}>
      {report.missing.length > 0 && (
        <p className={styles.danger}>
          {t('grants.missing', { privileges: report.missing.join(', ') })}
        </p>
      )}
      {report.warnings.length > 0 ? (
        <ul className={styles.warnings}>
          {report.warnings.map((warning) => (
            <li key={`${warning.code}|${warning.privilege ?? ''}|${warning.scope}`}>
              {t(warningLabels[warning.code], {
                privilege: warning.privilege ?? '',
                scope: warning.scope,
              })}
            </li>
          ))}
        </ul>
      ) : (
        report.missing.length === 0 && <p className={styles.ok}>{t('grants.ok')}</p>
      )}
      {report.roles.length > 0 && (
        <p className={styles.muted}>{t('grants.roles', { roles: report.roles.join(', ') })}</p>
      )}
    </div>
  )
}

/** Badge with the number of grant problems of a connection's users. */
export function GrantBadge(props: { reports: (GrantReport | null)[] }) {
  const t = useT()
  const missing = props.reports.some((report) => (report?.missing.length ?? 0) > 0)
  const warnings = props.reports.reduce((sum, report) => sum + (report?.warnings.length ?? 0), 0)
  if (missing) return <Badge tone="danger">{t('grants.badge.missing')}</Badge>
  if (warnings > 0)
    return <Badge tone="warning">{t('grants.badge.warnings', { count: warnings })}</Badge>
  return <Badge tone="success">{t('grants.badge.ok')}</Badge>
}

export function AccessWarnings(props: { warnings: AccessWarning[] }) {
  const t = useT()
  if (props.warnings.length === 0) return null
  return (
    <ul className={styles.warnings}>
      {props.warnings.map((warning) => (
        <li key={warning.code}>
          {t(accessWarningLabels[warning.code], {
            ops: (warning.ops ?? []).map((op) => t(opLabels[op])).join(', '),
          })}
        </li>
      ))}
    </ul>
  )
}

export function DiffSummary(props: { diff: SchemaDiff }) {
  const t = useT()
  const { diff } = props
  return (
    <ul className={styles.diff}>
      {diff.addedObjects.length > 0 && (
        <li>{t('drift.added', { objects: diff.addedObjects.join(', ') })}</li>
      )}
      {diff.removedObjects.length > 0 && (
        <li className={styles.danger}>
          {t('drift.removed', { objects: diff.removedObjects.join(', ') })}
        </li>
      )}
      {diff.changedObjects.map((change) => (
        <li key={change.object}>
          <span className={styles.mono}>{change.object}</span>
          {change.addedColumns.length > 0 &&
            ` · ${t('drift.columnsAdded', { columns: change.addedColumns.join(', ') })}`}
          {change.removedColumns.length > 0 &&
            ` · ${t('drift.columnsRemoved', { columns: change.removedColumns.join(', ') })}`}
          {change.changedColumns.length > 0 &&
            ` · ${t('drift.columnsChanged', {
              columns: change.changedColumns.map((entry) => entry.column).join(', '),
            })}`}
          {change.keysChanged && ` · ${t('drift.keysChanged')}`}
        </li>
      ))}
    </ul>
  )
}

export function ImpactList(props: { impact: ImpactItem[] }) {
  const t = useT()
  if (props.impact.length === 0) return <p className={styles.muted}>{t('drift.noImpact')}</p>
  return (
    <ul className={styles.warnings}>
      {props.impact.map((item, index) => (
        <li key={`${item.kind}-${item.id}-${String(index)}`}>
          {t(impactLabels[item.kind], { label: item.label })}: {t(reasonLabels[item.reason])}
        </li>
      ))}
    </ul>
  )
}
