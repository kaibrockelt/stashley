// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react'
import { Mascot } from '../brand/logo.tsx'
import styles from './state.module.css'

/** Shared layout for empty, not-found and error states. */
export function StateView(props: { title: string; children?: ReactNode; mascot?: boolean }) {
  return (
    <section className={styles.state}>
      {props.mascot !== false && <Mascot />}
      <h1 className={styles.title}>{props.title}</h1>
      {props.children}
    </section>
  )
}
