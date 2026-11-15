// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { Link, Outlet } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useUser } from '../api/session.ts'
import { Logo } from '../brand/logo.tsx'
import { useSignOut } from '../features/auth/mfa.tsx'
import { useNavigation } from '../features/workspace/api.ts'
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

function PageLink(props: { slug: string; title: string }) {
  return (
    <Link
      to="/pages/$slug"
      params={{ slug: props.slug }}
      className={styles.navLink}
      activeProps={{ 'aria-current': 'page' }}
    >
      {props.title}
    </Link>
  )
}

/** Sections and pages the user may see; sections without visible pages are hidden (§13.5). */
function WorkspaceNavigation() {
  const t = useT()
  const navigation = useNavigation()
  const data = navigation.data
  if (data === undefined) return null
  if (data.sections.length === 0 && data.pages.length === 0) {
    return <p className={styles.navEmpty}>{t('nav.empty')}</p>
  }
  return (
    <>
      {data.sections.map((section) => (
        <div key={section.id} className={styles.navGroup}>
          <p className={styles.navHeading}>{section.name}</p>
          {section.pages.map((page) => (
            <PageLink key={page.id} slug={page.slug} title={page.title} />
          ))}
        </div>
      ))}
      {data.pages.length > 0 && (
        <div className={styles.navGroup}>
          {data.pages.map((page) => (
            <PageLink key={page.id} slug={page.slug} title={page.title} />
          ))}
        </div>
      )}
    </>
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
          <WorkspaceNavigation />
          {(user.systemRole === 'admin' || user.systemRole === 'manager') && (
            <div className={styles.navGroup}>
              <p className={styles.navHeading}>{t('nav.design')}</p>
              <NavLink to="/design/pages">{t('pages.title')}</NavLink>
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
