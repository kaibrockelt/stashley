// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Fails when a production dependency uses a license that is not known to be compatible
// with AGPL-3.0-only.
import { execFileSync } from 'node:child_process'

const allowed = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Python-2.0',
  'Unlicense',
  'Zlib',
  'AGPL-3.0-only',
])

function compatible(expression) {
  const cleaned = expression.replace(/[()]/g, ' ').trim()
  if (cleaned.includes(' OR ')) return cleaned.split(' OR ').some((part) => compatible(part))
  if (cleaned.includes(' AND ')) return cleaned.split(' AND ').every((part) => compatible(part))
  return allowed.has(cleaned)
}

const report = JSON.parse(
  execFileSync('pnpm', ['licenses', 'list', '--prod', '--json', '--recursive'], {
    encoding: 'utf8',
  }),
)
const problems = []
let count = 0
for (const [license, packages] of Object.entries(report)) {
  for (const pkg of packages) {
    count += 1
    if (!compatible(license)) problems.push(`${pkg.name}@${pkg.versions.join(',')}: ${license}`)
  }
}

if (problems.length > 0) {
  console.error(`Incompatible or unknown licenses:\n${problems.map((p) => `  ${p}`).join('\n')}`)
  process.exit(1)
}
console.log(`Licenses: ${count} production packages ok`)
