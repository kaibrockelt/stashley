// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Checks that all message catalogs have the same keys, parse as ICU messages, use the
// same placeholders, and that every key is referenced in the source.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, TYPE } from '@formatjs/icu-messageformat-parser'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const catalogDir = path.join(root, 'src/i18n/messages')
const catalogs = Object.fromEntries(
  readdirSync(catalogDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => [
      file.replace('.json', ''),
      JSON.parse(readFileSync(path.join(catalogDir, file), 'utf8')),
    ]),
)

const problems = []
const reference = catalogs.en
if (reference === undefined) throw new Error('Missing en catalog')
const keys = Object.keys(reference).sort()

function placeholders(elements, found = new Set()) {
  for (const element of elements) {
    if (element.type === TYPE.literal || element.type === TYPE.pound) continue
    if ('value' in element && typeof element.value === 'string') found.add(element.value)
    if ('options' in element) {
      for (const option of Object.values(element.options)) placeholders(option.value, found)
    }
    if ('children' in element) placeholders(element.children, found)
  }
  return found
}

for (const [locale, catalog] of Object.entries(catalogs)) {
  const own = Object.keys(catalog).sort()
  for (const key of keys) if (!own.includes(key)) problems.push(`${locale}: missing ${key}`)
  for (const key of own) if (!keys.includes(key)) problems.push(`${locale}: unexpected ${key}`)
  for (const key of own) {
    try {
      const ast = parse(catalog[key])
      if (locale !== 'en' && reference[key] !== undefined) {
        const expected = [...placeholders(parse(reference[key]))].sort().join()
        const actual = [...placeholders(ast)].sort().join()
        if (expected !== actual)
          problems.push(`${locale}: ${key} uses {${actual}}, expected {${expected}}`)
      }
    } catch (error) {
      problems.push(`${locale}: ${key} is not a valid ICU message (${error.message})`)
    }
  }
}

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'i18n' ? [] : sources(full)
    return /\.(ts|tsx)$/.test(entry.name) ? [readFileSync(full, 'utf8')] : []
  })
}

const code = sources(path.join(root, 'src')).join('\n')
for (const key of keys) {
  if (!code.includes(`'${key}'`) && !code.includes(`"${key}"`)) problems.push(`unused key ${key}`)
}

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`i18n: ${keys.length} keys in ${Object.keys(catalogs).join(', ')}`)
