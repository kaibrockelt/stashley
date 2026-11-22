// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import styles from './logo.module.css'

/**
 * The provisional app icon (2026-11-15). It is served as a static file, not inlined, so it
 * stays out of the JavaScript bundle and its inline styles out of the page's CSP.
 */
const icon = '/brand/stashley-icon.svg'

export function Logo() {
  return (
    <span className={styles.logo}>
      <img className={styles.mark} src={icon} alt="" width={28} height={28} />
      <span className={styles.wordmark}>Stashley</span>
    </span>
  )
}

/** The mascot for empty, not-found and error states, used sparingly. */
export function Mascot({ className }: { className?: string }) {
  return (
    <img
      className={[styles.mascot, className].filter(Boolean).join(' ')}
      src={icon}
      alt=""
      width={64}
      height={64}
    />
  )
}
