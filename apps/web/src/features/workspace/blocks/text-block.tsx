// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { RenderComponent } from '@stashley/shared'
import { micromark } from 'micromark'
import { useMemo } from 'react'
import { BlockFrame } from './block-frame.tsx'
import styles from './blocks.module.css'

/**
 * Markdown without HTML (§ Blöcke: Text, E1). micromark escapes HTML unless told otherwise
 * and drops dangerous link protocols such as `javascript:`, so its output is safe to insert.
 */
export function renderMarkdown(markdown: string): string {
  return micromark(markdown, { allowDangerousHtml: false, allowDangerousProtocol: false })
}

export function TextBlock(props: { component: RenderComponent }) {
  const html = useMemo(
    () => renderMarkdown(props.component.markdown ?? ''),
    [props.component.markdown],
  )
  return (
    <BlockFrame component={props.component}>
      <div className={styles.markdown} dangerouslySetInnerHTML={{ __html: html }} />
    </BlockFrame>
  )
}
