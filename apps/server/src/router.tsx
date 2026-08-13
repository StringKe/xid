// code-based 路由树:避免 file-based 插件与 Cloudflare/lingui/StyleX 链路争用。
// 守卫用 RequireAuth(auth 在 React context,beforeLoad 读不到);/,/console/* 由独立 Worker 接管。

import type { ReactNode } from 'react'
import {
  createLazyRoute,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import * as stylex from '@stylexjs/stylex'
import { AuthAnalytics } from './components/AuthAnalytics'
import { RouteAnalytics } from './components/RouteAnalytics'

import { RoutePageSeo } from './components/RoutePageSeo'

import { Spinner } from './components/ui'
import { RequireAuth } from './components/RequireAuth'

type PageModule = { default: () => ReactNode }
type PageLoader = () => Promise<PageModule>

const styles = stylex.create({
  centerLoader: {
    minHeight: '100dvh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
})

function CenterLoader(): ReactNode {
  return (
    <div {...stylex.props(styles.centerLoader)}>
      <Spinner size={32} />
    </div>
  )
}

function protectedRoute(id: string, path: string, load: PageLoader) {
  return createRoute({ getParentRoute: () => rootRoute, path }).lazy(() =>
    load().then((m) => {
      const Page = m.default
      return createLazyRoute(id)({
        component: () => (
          <RequireAuth>
            <Page />
          </RequireAuth>
        ),
      })
    }),
  )
}

function accountRoute(id: string, path: string, load: PageLoader) {
  return createRoute({ getParentRoute: () => rootRoute, path }).lazy(() =>
    Promise.all([import('./routes/account/AccountLayout'), load()]).then(([layout, m]) => {
      const Page = m.default
      const { AccountLayout } = layout
      return createLazyRoute(id)({
        component: () => (
          <RequireAuth>
            <AccountLayout>
              <Page />
            </AccountLayout>
          </RequireAuth>
        ),
      })
    }),
  )
}

const rootRoute = createRootRoute({
  // 透传任意 query,兼容 useSearchParams().get(key) 读 token/continue 等。
  validateSearch: (search: Record<string, unknown>) => search,
  component: () => (
    <>
      <RoutePageSeo />
      <RouteAnalytics />
      <AuthAnalytics />
      <Outlet />
    </>
  ),
})

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
}).lazy(() => import('./routes/sign-in/SignInPage').then((m) => m.Route))
const signUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-up',
}).lazy(() => import('./routes/sign-up/index').then((m) => m.Route))

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/forgot-password',
}).lazy(() => import('./routes/forgot-password/index').then((m) => m.Route))

// /reset-password#token= 与 forgot-password 共用 reset 步骤。
const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset-password',
}).lazy(() => import('./routes/forgot-password/index').then((m) => m.Route))

const mfaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mfa',
}).lazy(() => import('./routes/mfa/index').then((m) => m.Route))

const verifyEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/verify-email',
}).lazy(() => import('./routes/verify-email/index').then((m) => m.Route))

const magicLinkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/magic-link',
}).lazy(() => import('./routes/magic-link/index').then((m) => m.Route))

const acceptInvitationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accept-invitation',
}).lazy(() => import('./routes/accept-invitation/index').then((m) => m.Route))

const createOrganizationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/create-organization',
}).lazy(() => import('./routes/create-organization/index').then((m) => m.Route))

const selectOrganizationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/select-organization',
}).lazy(() => import('./routes/select-organization/index').then((m) => m.Route))

const consentRoute = protectedRoute('/consent', '/consent', () => import('./routes/consent/index'))
const activateRoute = protectedRoute(
  '/activate',
  '/activate',
  () => import('./routes/activate/index'),
)
const cibaActivationRoute = protectedRoute(
  '/ciba-activation',
  '/ciba-activation',
  () => import('./routes/ciba-activation/index'),
)

const accountProfileRoute = accountRoute(
  '/account',
  '/account',
  () => import('./routes/account/ProfilePage'),
)
const accountSecurityRoute = accountRoute(
  '/account/security',
  '/account/security',
  () => import('./routes/account/SecurityPage'),
)
const accountConnectionsRoute = accountRoute(
  '/account/connections',
  '/account/connections',
  () => import('./routes/account/ConnectionsPage'),
)
const accountSessionsRoute = accountRoute(
  '/account/sessions',
  '/account/sessions',
  () => import('./routes/account/SessionsPage'),
)
const accountDevicesRoute = accountRoute(
  '/account/devices',
  '/account/devices',
  () => import('./routes/account/DevicesPage'),
)

// 未知路径 404,不静默重定向登录(公开 typo 不应被当成未认证)。
const notFoundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '$',
}).lazy(() =>
  import('./routes/not-found/NotFoundPage').then((m) =>
    createLazyRoute('$')({ component: m.default }),
  ),
)

const routeTree = rootRoute.addChildren([
  signInRoute,
  signUpRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  verifyEmailRoute,
  magicLinkRoute,
  acceptInvitationRoute,
  createOrganizationRoute,
  selectOrganizationRoute,
  mfaRoute,
  consentRoute,
  activateRoute,
  cibaActivationRoute,
  accountProfileRoute,
  accountSecurityRoute,
  accountConnectionsRoute,
  accountSessionsRoute,
  accountDevicesRoute,
  notFoundRoute,
])

export const router = createRouter({
  routeTree,
  defaultPendingComponent: CenterLoader,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
