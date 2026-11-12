// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  type ErrorComponentProps,
} from '@tanstack/react-router'
import { Home } from '../features/workspace/home.tsx'
import { useT } from '../i18n/use-t.ts'
import { StateView } from '../ui/state.tsx'
import styles from '../ui/state.module.css'
import { Shell } from './shell.tsx'

function NotFound() {
  const t = useT()
  return (
    <StateView title={t('notFound.title')}>
      <Link to="/" className={styles.action}>
        {t('notFound.action')}
      </Link>
    </StateView>
  )
}

function ErrorState(props: ErrorComponentProps) {
  const t = useT()
  const errorId =
    typeof props.error === 'object' && props.error !== null && 'errorId' in props.error
      ? String(props.error.errorId)
      : undefined
  return (
    <StateView title={t('error.title')}>
      {errorId !== undefined && <p className={styles.meta}>{t('error.reference', { errorId })}</p>}
      <button type="button" className={styles.action} onClick={() => window.location.reload()}>
        {t('error.reload')}
      </button>
    </StateView>
  )
}

const rootRoute = createRootRoute({
  component: Shell,
  notFoundComponent: NotFound,
  errorComponent: ErrorState,
})

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Home })

export const router = createRouter({
  routeTree: rootRoute.addChildren([homeRoute]),
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
