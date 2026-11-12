// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { FieldError } from '@stashley/shared'
import type { z } from 'zod'
import { AppError } from './problem.ts'

function fieldCode(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'too_small':
      return issue.origin === 'string' ? 'too_short' : 'too_small'
    case 'too_big':
      return issue.origin === 'string' ? 'too_long' : 'too_big'
    case 'invalid_type':
      return issue.input === undefined ? 'required' : 'invalid'
    case 'unrecognized_keys':
      return 'not_allowed'
    default:
      return 'invalid'
  }
}

/** Validates input against a schema; failures become `validation_failed` with field errors. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const errors: FieldError[] = result.error.issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({ field: key, code: 'not_allowed' }))
    }
    return [{ field: issue.path.join('.') || '_', code: fieldCode(issue) }]
  })
  throw new AppError('validation_failed', { errors })
}

export function fieldError(field: string, code: string): AppError {
  return new AppError('validation_failed', { errors: [{ field, code }] })
}
