// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Docker HEALTHCHECK probe. The image ships no curl, so Node calls /healthz directly.
const port = process.env.PORT ?? '8080'

try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(3000),
  })
  process.exit(response.ok ? 0 : 1)
} catch {
  process.exit(1)
}
