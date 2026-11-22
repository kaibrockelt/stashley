// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Prints the demo data as SQL. Used by `scripts/seed-demo.sh`:
//   node packages/demo/src/cli.ts data      INSERT statements
//   node packages/demo/src/cli.ts verify    the verification query
// `--now <ISO instant>` fixes the time the event day is set around (default: now).
import { generateDemo } from './generate.ts'
import { verificationQuery } from './verify.ts'

const args = process.argv.slice(2)
const nowIndex = args.indexOf('--now')
const now = nowIndex === -1 ? new Date() : new Date(args[nowIndex + 1] ?? '')
if (Number.isNaN(now.getTime())) {
  process.stderr.write('--now needs an ISO 8601 instant\n')
  process.exit(2)
}
const demo = generateDemo({ now })
if (args[0] === 'verify') {
  process.stdout.write(`${verificationQuery(demo.facts)};\n`)
} else if (args[0] === 'data') {
  process.stdout.write('SET FOREIGN_KEY_CHECKS = 1;\nSTART TRANSACTION;\n')
  for (const statement of demo.statements) process.stdout.write(`${statement};\n`)
  process.stdout.write('COMMIT;\n')
} else {
  process.stderr.write('Usage: cli.ts data|verify [--now <instant>]\n')
  process.exit(2)
}
