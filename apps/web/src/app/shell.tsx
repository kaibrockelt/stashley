// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { Link, Outlet } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useUser } from '../api/session.ts'
import { Logo } from '../brand/logo.tsx'
import { useSignOut } from '../features/auth/mfa.tsx'
import { useT } from '../i18n/use-t.ts'
import { Button } from '../ui/controls.tsx'
import styles from './shell.module.css'

function NavLink(props: { to: string; children: ReactNode }) {
  return (
    <Link to={props.to} className={styles.navLink} activeProps={{ 'aria-current': 'page' }}>
      {props.children}
    </Link>
  )
}

export function Shell() {
  const t = useT()
  const user = useUser()
  const signOut = useSignOut()
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
          {(user.systemRole === 'admin' || user.systemRole === 'manager') && (
            <div className={styles.navGroup}>
              <p className={styles.navHeading}>{t('nav.design')}</p>
              <NavLink to="/design/roles">{t('roles.title')}</NavLink>
              <NavLink to="/design/variables">{t('variables.title')}</NavLink>
            </div>
          )}
          {user.systemRole === 'admin' && (
            <div className={styles.navGroup}>
              <p className={styles.navHeading}>{t('nav.administration')}</p>
              <NavLink to="/admin/connections">{t('connections.title')}</NavLink>
              <NavLink to="/admin/users">{t('users.title')}</NavLink>
              <NavLink to="/admin/identity-providers">{t('providers.title')}</NavLink>
              <NavLink to="/admin/settings">{t('settings.title')}</NavLink>
              <NavLink to="/admin/audit">{t('audit.title')}</NavLink>
            </div>
          )}
        </nav>
        <div className={styles.account}>
          <NavLink to="/profile">{user.displayName}</NavLink>
          <Button variant="ghost" onPress={signOut}>
            {t('action.signOut')}
          </Button>
        </div>
      </aside>
      <main id="main" className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  )
}
