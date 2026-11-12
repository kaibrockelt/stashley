// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { errorCodes, isErrorCode, problemType } from './errors.ts'

describe('error codes', () => {
  it('builds problem type URNs', () => {
    expect(problemType('not_found')).toBe('urn:stashley:problem:not_found')
  })

  it('recognizes known codes only', () => {
    expect(isErrorCode('forbidden')).toBe(true)
    expect(isErrorCode('toString')).toBe(false)
    expect(isErrorCode(42)).toBe(false)
  })

  it('uses error statuses only', () => {
    for (const { status } of Object.values(errorCodes)) expect(status).toBeGreaterThanOrEqual(400)
  })
})
