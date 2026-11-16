// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { FieldError } from '@stashley/shared'
import { ApiError } from '../../../api/client.ts'
import type { MessageId } from '../../../i18n/locale.ts'
import { useT } from '../../../i18n/use-t.ts'

/** Field errors of writes (§11 step 7), from the row schema or the database. */
const fieldTexts: Record<string, MessageId> = {
  required: 'write.field.required',
  invalid: 'write.field.invalid',
  too_long: 'write.field.tooLong',
  too_many_decimals: 'write.field.tooManyDecimals',
  out_of_range: 'write.field.outOfRange',
  not_allowed: 'write.field.notAllowed',
  field_not_writable: 'write.field.notWritable',
  value_not_allowed: 'write.field.valueNotAllowed',
  unique_violation: 'write.field.unique',
  foreign_key_violation: 'write.field.foreignKey',
  variable_missing: 'write.field.variableMissing',
  default_invalid: 'write.field.defaultInvalid',
}

/** Messages of refused writes that concern the whole record. */
const problemTexts: Record<string, MessageId> = {
  version_conflict: 'write.error.versionConflict',
  base_filter_violation: 'write.error.baseFilter',
  row_locked: 'write.error.rowLocked',
  unique_violation: 'write.error.unique',
  foreign_key_violation: 'write.error.foreignKey',
  still_referenced: 'write.error.stillReferenced',
  value_not_allowed: 'write.error.valueNotAllowed',
  not_null_violation: 'write.error.notNull',
  value_too_long: 'write.error.tooLong',
  value_out_of_range: 'write.error.outOfRange',
  invalid_value: 'write.error.invalidValue',
  check_violation: 'write.error.check',
  write_failed: 'write.error.failed',
  not_found: 'write.error.notFound',
  forbidden: 'write.error.forbidden',
  rate_limited: 'error.rateLimited',
  target_unavailable: 'write.error.unavailable',
  target_permission_denied: 'write.error.permission',
  query_timeout: 'write.error.timeout',
  export_too_large: 'write.error.exportTooLarge',
  export_disabled: 'write.error.exportDisabled',
}

export function useWriteErrors() {
  const t = useT()
  return {
    field(error: FieldError): string {
      const id = fieldTexts[error.code] ?? 'write.field.invalid'
      return t(id, { min: '', max: '', ...error.params })
    },
    /** The message of the whole write; validation errors are shown at their fields only. */
    message(error: unknown): string | undefined {
      if (!(error instanceof ApiError)) return t('error.title')
      if (error.code === 'validation_failed') return undefined
      const id = problemTexts[error.code]
      return id === undefined
        ? t('error.title')
        : t(id, { max: String(error.errors[0]?.params?.max ?? '') })
    },
  }
}
