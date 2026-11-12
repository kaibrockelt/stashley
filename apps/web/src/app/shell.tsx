// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { Outlet } from '@tanstack/react-router'
import { ToggleButton, ToggleButtonGroup, type Key } from 'react-aria-components'
import { Logo } from '../brand/logo.tsx'
import type { MessageId } from '../i18n/locale.ts'
import { useT } from '../i18n/use-t.ts'
import { themes, type Theme } from '../ui/theme.ts'
import { useTheme } from './providers.tsx'
import styles from './shell.module.css'

const themeLabels: Record<Theme, MessageId> = {
  light: 'theme.light',
  dark: 'theme.dark',
  system: 'theme.system',
}

function ThemeSwitch() {
  const t = useT()
  const { theme, setTheme } = useTheme()
  return (
    <ToggleButtonGroup
      aria-label={t('theme.label')}
      className={styles.segmented}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[theme]}
      onSelectionChange={(keys: Set<Key>) => {
        const [next] = [...keys]
        if (next !== undefined) setTheme(next as Theme)
      }}
    >
      {themes.map((value) => (
        <ToggleButton key={value} id={value} className={styles.segment}>
          {t(themeLabels[value])}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  )
}

export function Shell() {
  const t = useT()
  return (
    <div className={styles.shell}>
      <a href="#main" className={styles.skip}>
        {t('app.skipToContent')}
      </a>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <Logo />
        </div>
        <nav aria-label={t('nav.label')} className={styles.nav}>
          <p className={styles.navEmpty}>{t('nav.empty')}</p>
        </nav>
      </aside>
      <div className={styles.content}>
        <header className={styles.header}>
          <ThemeSwitch />
        </header>
        <main id="main" className={styles.main} tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
