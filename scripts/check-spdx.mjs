// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Every tracked source file must carry the SPDX copyright and license lines near the top.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const sourcePattern = /(\.(ts|tsx|js|mjs|cjs|css|sh|yml|yaml|html|svg)$|(^|\/)Dockerfile$)/
const exempt = new Set(['pnpm-lock.yaml', 'pnpm-workspace.yaml'])
const skipped = new Set(['node_modules', 'dist', 'coverage', '.git'])

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (skipped.has(entry.name)) return []
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}

/** Tracked and untracked (not ignored) files; falls back to a directory walk without git. */
function listFiles() {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n')
  } catch {
    return walk('.').map((file) => path.relative('.', file))
  }
}

const files = listFiles().filter(
  (file) => file !== '' && sourcePattern.test(file) && !exempt.has(path.basename(file)),
)

const missing = files.filter((file) => {
  const head = readFileSync(file, 'utf8').split('\n').slice(0, 6).join('\n')
  return !(
    head.includes('SPDX-FileCopyrightText: 2026 Stashley contributors') &&
    head.includes('SPDX-License-Identifier: AGPL-3.0-only')
  )
})

if (missing.length > 0) {
  console.error(`Missing SPDX header:\n${missing.map((file) => `  ${file}`).join('\n')}`)
  process.exit(1)
}
console.log(`SPDX: ${files.length} files ok`)
