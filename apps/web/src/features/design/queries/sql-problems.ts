// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { SqlProblemCode } from '@stashley/shared'
import type { MessageId } from '../../../i18n/locale.ts'

/** A localized message per rule of the SQL validation (§10.2). */
export const sqlProblemTexts: Record<SqlProblemCode, MessageId> = {
  empty: 'sql.problem.empty',
  too_long: 'sql.problem.too_long',
  executable_comment: 'sql.problem.executable_comment',
  optimizer_hint: 'sql.problem.optimizer_hint',
  ambiguous_comment: 'sql.problem.ambiguous_comment',
  unterminated: 'sql.problem.unterminated',
  positional_placeholder: 'sql.problem.positional_placeholder',
  variable_not_allowed: 'sql.problem.variable_not_allowed',
  assignment_not_allowed: 'sql.problem.assignment_not_allowed',
  invalid_parameter_name: 'sql.problem.invalid_parameter_name',
  multiple_statements: 'sql.problem.multiple_statements',
  into_not_allowed: 'sql.problem.into_not_allowed',
  locking_clause: 'sql.problem.locking_clause',
  ambiguous_identifier: 'sql.problem.ambiguous_identifier',
  unexpected_character: 'sql.problem.unexpected_character',
  parse_error: 'sql.problem.parse_error',
  not_select: 'sql.problem.not_select',
  system_schema: 'sql.problem.system_schema',
  other_schema: 'sql.problem.other_schema',
  object_not_exposed: 'sql.problem.object_not_exposed',
  object_not_readable: 'sql.problem.object_not_readable',
  unknown_column: 'sql.problem.unknown_column',
  ambiguous_column: 'sql.problem.ambiguous_column',
  excluded_column: 'sql.problem.excluded_column',
  star_on_excluded: 'sql.problem.star_on_excluded',
  unknown_alias: 'sql.problem.unknown_alias',
  function_denied: 'sql.problem.function_denied',
  function_not_allowed: 'sql.problem.function_not_allowed',
  unsupported_syntax: 'sql.problem.unsupported_syntax',
}

/** Line and column (1-based) of an offset in the text. */
export function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, offset))
  const lines = before.split('\n')
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 }
}

/** Named parameters the manager defines: not instance variables, not the user context. */
export function definableParameters(
  names: readonly string[],
  variables: readonly string[],
): string[] {
  return names.filter((name) => !variables.includes(name) && !name.startsWith('current_user_'))
}
