// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  isReservedWord,
  isValidNewName,
  matchKey,
  maxIdentifierLength,
  normalizeName,
  uniqueNames,
} from './names.ts'

describe('names', () => {
  it('become snake_case, transliterated and safe', () => {
    expect(normalizeName('Nachname')).toBe('nachname')
    expect(normalizeName('E-Mail Adresse')).toBe('e_mail_adresse')
    expect(normalizeName('Straße & Hausnr.')).toBe('strasse_hausnr')
    expect(normalizeName('Größe (cm)')).toBe('groesse_cm')
    expect(normalizeName('Café Crème')).toBe('cafe_creme')
    expect(normalizeName('startNummer')).toBe('start_nummer')
    expect(normalizeName('personID')).toBe('person_id')
    expect(normalizeName('2. Vorname')).toBe('c_2_vorname')
    expect(normalizeName('order')).toBe('order_')
    expect(normalizeName('Key')).toBe('key_')
    expect(normalizeName('---')).toBe('unnamed')
    expect(normalizeName('', 'imported')).toBe('imported')
    expect(normalizeName('x'.repeat(100))).toHaveLength(maxIdentifierLength)
  })

  it('are always valid and normalizing twice changes nothing', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (text) => {
        const name = normalizeName(text)
        expect(isValidNewName(name)).toBe(true)
        expect(name.length).toBeLessThanOrEqual(maxIdentifierLength)
        expect(isReservedWord(name)).toBe(false)
        expect(/^[a-z][a-z0-9_]*$/.test(name)).toBe(true)
        expect(normalizeName(name)).toBe(name)
      }),
      { numRuns: 1000 },
    )
  })

  it('are made unique without exceeding the length', () => {
    expect(uniqueNames(['name', 'Name', 'name', 'name_2'])).toEqual([
      'name',
      'Name_2',
      'name_3',
      'name_2_2',
    ])
    expect(uniqueNames(['id'], ['ID'])).toEqual(['id_2'])
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b', 'x'.repeat(64)), { maxLength: 30 }),
        (list) => {
          const names = uniqueNames(list)
          expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(names.length)
          for (const name of names) expect(name.length).toBeLessThanOrEqual(maxIdentifierLength)
        },
      ),
    )
  })

  it('match regardless of case, separators and accents', () => {
    expect(matchKey('E-Mail')).toBe(matchKey('email'))
    expect(matchKey('Start Nummer')).toBe(matchKey('startnummer'))
    expect(matchKey('Straße')).toBe(matchKey('strasse'))
    expect(matchKey('lastName')).toBe(matchKey('last_name'))
    expect(matchKey('name')).not.toBe(matchKey('nachname'))
  })
})
