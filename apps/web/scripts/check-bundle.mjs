// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Fails when the initial load (entry chunk, its static imports and their CSS) exceeds
// the gzip budget.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const budget = 300 * 1024
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
const manifest = JSON.parse(readFileSync(path.join(dist, '.vite/manifest.json'), 'utf8'))

const files = new Set()
function visit(key) {
  const chunk = manifest[key]
  if (chunk === undefined || files.has(chunk.file)) return
  files.add(chunk.file)
  for (const css of chunk.css ?? []) files.add(css)
  for (const imported of chunk.imports ?? []) visit(imported)
}
for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry) visit(key)

let total = 0
for (const file of files) {
  const size = gzipSync(readFileSync(path.join(dist, file))).length
  total += size
  console.log(`${(size / 1024).toFixed(1).padStart(8)} KB  ${file}`)
}
console.log(
  `${(total / 1024).toFixed(1).padStart(8)} KB  initial load (budget ${budget / 1024} KB)`,
)
if (total > budget) process.exit(1)
