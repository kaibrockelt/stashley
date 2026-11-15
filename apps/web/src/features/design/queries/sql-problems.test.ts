// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { sqlProblemCodes } from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import { definableParameters, lineAndColumn, sqlProblemTexts } from './sql-problems.ts'

describe('SQL editor helpers', () => {
  it('has a text for every validation rule', () => {
    expect(Object.keys(sqlProblemTexts).sort()).toEqual([...sqlProblemCodes].sort())
  })

  it('turns offsets into lines and columns', () => {
    expect(lineAndColumn('SELECT 1', 0)).toEqual({ line: 1, column: 1 })
    expect(lineAndColumn('SELECT a\nFROM b\nWHERE @x', 22)).toEqual({ line: 3, column: 7 })
  })

  it('leaves server values out of the definable parameters', () => {
    expect(
      definableParameters(['station', 'current_event_id', 'current_user_id'], ['current_event_id']),
    ).toEqual(['station'])
  })
})
