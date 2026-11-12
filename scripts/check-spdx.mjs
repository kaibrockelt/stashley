// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Every tracked source file must carry the SPDX copyright and license lines near the top.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const sourcePattern = /(\.(ts|tsx|js|mjs|cjs|css|sh|yml|yaml|html|svg)$|(^|\/)Dockerfile$)/
const exempt = new Set(['pnpm-lock.yaml', 'pnpm-workspace.yaml'])
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter((file) => sourcePattern.test(file) && !exempt.has(file))

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
