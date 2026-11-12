// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only
import type { SessionState } from '@stashley/shared'
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Link,
  Outlet,
  redirect,
  type ErrorComponentProps,
} from '@tanstack/react-router'
import { fetchSession } from '../api/client.ts'
import { sessionKey } from '../api/session.ts'
import { AuthLayout } from '../features/auth/layout.tsx'
import {
  InvitationPage,
  PasswordResetComplete,
  PasswordResetRequest,
} from '../features/auth/links.tsx'
import { MfaChallenge, MfaRequiredSetup, Pending } from '../features/auth/mfa.tsx'
import { SignIn } from '../features/auth/sign-in.tsx'
import { Home } from '../features/workspace/home.tsx'
import { useT } from '../i18n/use-t.ts'
import { StateView } from '../ui/state.tsx'
import styles from '../ui/state.module.css'
import { queryClient } from './providers.tsx'
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

/** Token of the invitation and password reset routes; these pages remount on navigation. */
function lastPathSegment(): string {
  return decodeURIComponent(window.location.pathname.split('/').at(-1) ?? '')
}

const session = () => queryClient.ensureQueryData({ queryKey: sessionKey, queryFn: fetchSession })

/** Where each session state belongs. */
const homes: Record<SessionState, string> = {
  anonymous: '/sign-in',
  mfa_required: '/sign-in/two-factor',
  mfa_enrollment_required: '/two-factor-setup',
  pending: '/pending',
  active: '/',
}

/** Sends the visitor to the page of their session state unless it is one of `allowed`. */
function requireState(allowed: SessionState[]) {
  return async () => {
    const { state } = await session()
    // TanStack Router redirects by throwing.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (!allowed.includes(state)) throw redirect({ to: homes[state] })
  }
}

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFound,
  errorComponent: ErrorState,
})

const authLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: 'auth',
  component: AuthLayout,
})
const anonymous = requireState(['anonymous', 'pending', 'mfa_required', 'mfa_enrollment_required'])

const authRoutes = [
  createRoute({
    getParentRoute: () => authLayout,
    path: '/sign-in',
    component: SignIn,
    beforeLoad: requireState(['anonymous']),
  }),
  createRoute({
    getParentRoute: () => authLayout,
    path: '/sign-in/two-factor',
    component: MfaChallenge,
    beforeLoad: requireState(['mfa_required']),
  }),
  createRoute({
    getParentRoute: () => authLayout,
    path: '/two-factor-setup',
    component: MfaRequiredSetup,
    beforeLoad: requireState(['mfa_enrollment_required']),
  }),
  createRoute({
    getParentRoute: () => authLayout,
    path: '/pending',
    component: Pending,
    beforeLoad: requireState(['pending']),
  }),
  createRoute({
    getParentRoute: () => authLayout,
    path: '/invitation/$token',
    component: function InvitationRoute() {
      const token = lastPathSegment()
      return <InvitationPage token={token} />
    },
    beforeLoad: anonymous,
  }),
  createRoute({
    getParentRoute: () => authLayout,
    path: '/password-reset',
    component: PasswordResetRequest,
    beforeLoad: anonymous,
  }),
  createRoute({
    getParentRoute: () => authLayout,
    path: '/password-reset/$token',
    component: function PasswordResetRoute() {
      const token = lastPathSegment()
      return <PasswordResetComplete token={token} />
    },
    beforeLoad: anonymous,
  }),
]

const appLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: Shell,
  beforeLoad: requireState(['active']),
})

const adminLayout = createRoute({
  getParentRoute: () => appLayout,
  path: '/admin',
  component: Outlet,
  beforeLoad: async () => {
    const { user } = await session()
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (user?.systemRole !== 'admin') throw redirect({ to: '/' })
  },
})

const appRoutes = [
  createRoute({ getParentRoute: () => appLayout, path: '/', component: Home }),
  createRoute({
    getParentRoute: () => appLayout,
    path: '/profile',
    component: lazyRouteComponent(() => import('../features/profile/profile.tsx'), 'ProfilePage'),
  }),
  adminLayout.addChildren([
    createRoute({
      getParentRoute: () => adminLayout,
      path: '/users',
      component: lazyRouteComponent(() => import('../features/admin/users.tsx'), 'UsersPage'),
    }),
    createRoute({
      getParentRoute: () => adminLayout,
      path: '/identity-providers',
      component: lazyRouteComponent(
        () => import('../features/admin/identity-providers.tsx'),
        'IdentityProvidersPage',
      ),
    }),
    createRoute({
      getParentRoute: () => adminLayout,
      path: '/settings',
      component: lazyRouteComponent(() => import('../features/admin/settings.tsx'), 'SettingsPage'),
    }),
    createRoute({
      getParentRoute: () => adminLayout,
      path: '/audit',
      component: lazyRouteComponent(() => import('../features/admin/audit.tsx'), 'AuditPage'),
    }),
  ]),
]

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    authLayout.addChildren(authRoutes),
    appLayout.addChildren(appRoutes),
  ]),
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
