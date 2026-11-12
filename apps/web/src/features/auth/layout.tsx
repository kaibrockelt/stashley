// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { Outlet } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Logo } from '../../brand/logo.tsx'
import styles from './auth.module.css'

export function AuthLayout() {
  return (
    <div className={styles.page}>
      <main className={styles.card}>
        <div className={styles.brand}>
          <Logo />
        </div>
        <Outlet />
      </main>
    </div>
  )
}

export function AuthTitle(props: { children: ReactNode }) {
  return <h1 className={styles.title}>{props.children}</h1>
}

export function AuthText(props: { children: ReactNode }) {
  return <p className={styles.text}>{props.children}</p>
}
