// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { Button as AriaButton, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components'
import { useSession, useUser } from '../api/session.ts'
import { Logo, Mascot } from '../brand/logo.tsx'
import { useSignOut } from '../features/auth/mfa.tsx'
import { useNavigation } from '../features/workspace/api.ts'
import { useT } from '../i18n/use-t.ts'
import { Button, Dialog } from '../ui/controls.tsx'
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

/** Name, version, license and the source code, which the AGPL offers to every user. */
function About(props: { onClose: () => void }) {
  const t = useT()
  const { instance } = useSession()
  return (
    <Dialog title={t('about.title')} isOpen onOpenChange={(open) => !open && props.onClose()}>
      <div className={styles.about}>
        <Mascot />
        <p>{t('about.version', { version: instance.version ?? '' })}</p>
        <p>{t('about.license')}</p>
        <p>
          <a href="https://github.com/kaibrockelt/stashley" target="_blank" rel="noreferrer">
            {t('about.source')}
          </a>
        </p>
      </div>
      <div className={styles.aboutActions}>
        <Button onPress={props.onClose}>{t('action.done')}</Button>
      </div>
    </Dialog>
  )
}

/**
 * The sticky account footer: the user's name opens a menu with the profile, the about dialog
 * (with the AGPL source link) and sign-out. React Aria supplies the menu-button pattern.
 */
function AccountMenu(props: { onAbout: () => void }) {
  const t = useT()
  const user = useUser()
  const signOut = useSignOut()
  const navigate = useNavigate()
  const act = (key: string | number) => {
    if (key === 'profile') void navigate({ to: '/profile' })
    else if (key === 'about') props.onAbout()
    else if (key === 'sign-out') signOut()
  }
  return (
    <MenuTrigger>
      <AriaButton className={styles.accountButton}>
        <span className={styles.accountName}>{user.displayName}</span>
        <span aria-hidden="true" className={styles.accountChevron}>
          ▴
        </span>
      </AriaButton>
      <Popover placement="top start" offset={6} className={styles.accountPopover}>
        <Menu className={styles.accountMenu} aria-label={user.displayName} onAction={act}>
          <MenuItem id="profile" className={styles.accountItem}>
            {t('profile.title')}
          </MenuItem>
          <MenuItem id="about" className={styles.accountItem}>
            {t('about.action')}
          </MenuItem>
          <MenuItem id="sign-out" className={styles.accountItem}>
            {t('action.signOut')}
          </MenuItem>
        </Menu>
      </Popover>
    </MenuTrigger>
  )
}

export function Shell() {
  const t = useT()
  const user = useUser()
  const [about, setAbout] = useState(false)
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
              <NavLink to="/design/queries">{t('queries.title')}</NavLink>
              <NavLink to="/design/imports">{t('imports.title')}</NavLink>
              <NavLink to="/design/roles">{t('roles.title')}</NavLink>
              <NavLink to="/design/variables">{t('variables.title')}</NavLink>
            </div>
          )}
          {user.systemRole === 'admin' && (
            <div className={styles.navGroup}>
              <p className={styles.navHeading}>{t('nav.administration')}</p>
              <NavLink to="/admin/connections">{t('connections.title')}</NavLink>
              <NavLink to="/admin/api">{t('api.title')}</NavLink>
              <NavLink to="/admin/users">{t('users.title')}</NavLink>
              <NavLink to="/admin/permissions">{t('permissions.title')}</NavLink>
              <NavLink to="/admin/identity-providers">{t('providers.title')}</NavLink>
              <NavLink to="/admin/settings">{t('settings.title')}</NavLink>
              <NavLink to="/admin/configuration">{t('config.title')}</NavLink>
              <NavLink to="/admin/audit">{t('audit.title')}</NavLink>
            </div>
          )}
        </nav>
        <div className={styles.account}>
          <AccountMenu onAbout={() => setAbout(true)} />
        </div>
        {about && <About onClose={() => setAbout(false)} />}
      </aside>
      <main id="main" className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  )
}
