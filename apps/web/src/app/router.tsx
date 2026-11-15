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
  useFragmentToken,
} from '../features/auth/links.tsx'
import { MfaChallenge, MfaRequiredSetup, Pending } from '../features/auth/mfa.tsx'
import { SignIn } from '../features/auth/sign-in.tsx'
import { Home } from '../features/workspace/home.tsx'
import type { PageSearch } from '../features/workspace/page-view.tsx'
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
    path: '/invitation',
    component: function InvitationRoute() {
      return <InvitationPage token={useFragmentToken()} />
    },
    beforeLoad: anonymous,
  }),
  createRoute({
    getParentRoute: () => authLayout,
    path: '/password-reset',
    // With a token in the fragment the page sets the new password, otherwise it requests a link.
    component: function PasswordResetRoute() {
      const token = useFragmentToken()
      return token === '' ? <PasswordResetRequest /> : <PasswordResetComplete token={token} />
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

const designLayout = createRoute({
  getParentRoute: () => appLayout,
  path: '/design',
  component: Outlet,
  beforeLoad: async () => {
    const { user } = await session()
    const role = user?.systemRole
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (role !== 'admin' && role !== 'manager') throw redirect({ to: '/' })
  },
})

const appRoutes = [
  createRoute({ getParentRoute: () => appLayout, path: '/', component: Home }),
  createRoute({
    getParentRoute: () => appLayout,
    path: '/pages/$slug',
    // Filter values and URL parameters are validated by the server against the page (§13.6).
    validateSearch: (search: Record<string, unknown>): PageSearch => search,
    component: lazyRouteComponent(
      () => import('../features/workspace/page-route.tsx'),
      'PageRoute',
    ),
  }),
  createRoute({
    getParentRoute: () => appLayout,
    path: '/profile',
    component: lazyRouteComponent(() => import('../features/profile/profile.tsx'), 'ProfilePage'),
  }),
  designLayout.addChildren([
    createRoute({
      getParentRoute: () => designLayout,
      path: '/roles',
      component: lazyRouteComponent(() => import('../features/design/roles.tsx'), 'RolesPage'),
    }),
    createRoute({
      getParentRoute: () => designLayout,
      path: '/variables',
      component: lazyRouteComponent(
        () => import('../features/design/variables.tsx'),
        'VariablesPage',
      ),
    }),
  ]),
  adminLayout.addChildren([
    createRoute({
      getParentRoute: () => adminLayout,
      path: '/users',
      component: lazyRouteComponent(() => import('../features/admin/users.tsx'), 'UsersPage'),
    }),
    createRoute({
      getParentRoute: () => adminLayout,
      path: '/connections',
      component: lazyRouteComponent(
        () => import('../features/admin/connections/connections-page.tsx'),
        'ConnectionsPage',
      ),
    }),
    createRoute({
      getParentRoute: () => adminLayout,
      path: '/connections/$connectionId',
      component: lazyRouteComponent(
        () => import('../features/admin/connections/connection-page.tsx'),
        'ConnectionPage',
      ),
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
