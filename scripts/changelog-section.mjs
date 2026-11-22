// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Prints the section of docs/CHANGELOG.md for one version, for the GitHub release notes:
//   node scripts/changelog-section.mjs 0.1.0
import { readFileSync } from 'node:fs'

const version = (process.argv[2] ?? '').replace(/^v/, '')
if (version === '') {
  process.stderr.write('Usage: changelog-section.mjs <version>\n')
  process.exit(2)
}
const lines = readFileSync(new URL('../docs/CHANGELOG.md', import.meta.url), 'utf8').split('\n')
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`))
if (start === -1) {
  process.stderr.write(`docs/CHANGELOG.md has no section for ${version}\n`)
  process.exit(1)
}
const end = lines.findIndex((line, index) => index > start && line.startsWith('## ['))
process.stdout.write(
  `${lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim()}\n`,
)
