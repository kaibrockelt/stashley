// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { configFile } from '@stashley/shared'
import { describe, expect, it } from 'vitest'
import { demoConfig, demoId } from './scenario.ts'

describe('demoConfig', () => {
  it('is a valid configuration file', () => {
    const result = configFile.safeParse(demoConfig())
    expect(result.success, JSON.stringify(result.error?.issues.slice(0, 3))).toBe(true)
  })

  it('has every page of the scenario', () => {
    expect(demoConfig().pages.map((page) => page.slug)).toEqual([
      'uebersicht',
      'anmeldungen',
      'teilnehmer',
      'kasse',
      'hotels',
      'check-in',
      'station',
      'streckenlage',
      'ehrung',
      'gaeste-lindenhof',
      'gaeste-adler',
    ])
  })

  it('derives stable version 4 UUIDs', () => {
    expect(demoId('role:orga')).toBe(demoId('role:orga'))
    expect(demoId('role:orga')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })
})
