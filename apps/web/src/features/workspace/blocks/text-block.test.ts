// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './text-block.tsx'

describe('renderMarkdown', () => {
  it('renders Markdown', () => {
    expect(renderMarkdown('## Kasse\n\n**Offene** Posten')).toBe(
      '<h2>Kasse</h2>\n<p><strong>Offene</strong> Posten</p>',
    )
  })

  it('escapes HTML and drops dangerous links', () => {
    expect(renderMarkdown('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    )
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).not.toContain('<img')
    expect(renderMarkdown('[x](javascript:alert(1))')).toBe('<p><a href="">x</a></p>')
  })
})
