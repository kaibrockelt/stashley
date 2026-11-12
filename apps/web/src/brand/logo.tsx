// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import styles from './logo.module.css'
import mark from './mark.svg?raw'

/** Placeholder mark and wordmark until the final brand artwork is delivered. */
export function Logo() {
  return (
    <span className={styles.logo}>
      <span className={styles.mark} aria-hidden="true" dangerouslySetInnerHTML={{ __html: mark }} />
      <span className={styles.wordmark}>Stashley</span>
    </span>
  )
}

export function Mascot({ className }: { className?: string }) {
  return (
    <span
      className={[styles.mascot, className].filter(Boolean).join(' ')}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: mark }}
    />
  )
}
