// code-based 路由树:避免 file-based 插件与 Cloudflare/lingui/StyleX 链路争用。
// 守卫用 RequireAuth(auth 在 React context,beforeLoad 读不到);apex 的 / 与 /console/* 由独立 Worker 接管。

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
import { HostedBranding } from './components/HostedBranding'
import { RouteAnalytics } from './components/RouteAnalytics'

import { RoutePageSeo } from './components/RoutePageSeo'
import { ErrorPage } from './routes/not-found/ErrorPage'

import { Spinner } from './components/ui'
import { RequireAuth } from '@xid-kit/web-ui/RequireAuth'
import { Navigate } from '@xid-kit/web-ui/tanstack-router'
import { ACCOUNT_EXACT_PATH } from '@xid-kit/types'
import type { PendingMfaAuthStatus } from './lib/auth-context'

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

function protectedRoute(
  id: string,
  path: string,
  load: PageLoader,
  options: { completesPendingMfa?: PendingMfaAuthStatus } = {},
) {
  return createRoute({ getParentRoute: () => rootRoute, path }).lazy(() =>
    load().then((m) => {
      const Page = m.default
      return createLazyRoute(id)({
        component: () => (
          <RequireAuth completesPendingMfa={options.completesPendingMfa}>
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
      <HostedBranding />
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

const mfaSetupRoute = protectedRoute(
  '/mfa/setup',
  '/mfa/setup',
  () => import('./routes/mfa-setup/index'),
  { completesPendingMfa: 'pending_mfa_setup' },
)
const createPasskeyRoute = protectedRoute(
  '/create-passkey',
  '/create-passkey',
  () => import('./routes/create-passkey/index'),
)
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

// 账户门户默认落在 Security;旧的 /account/connections 与 /account/sessions 地址保留为跳转。
function accountRedirectRoute(path: string, to: string) {
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => <Navigate to={`${to}${globalThis.location?.search ?? ''}`} replace />,
  })
}

const accountIndexRoute = accountRedirectRoute(ACCOUNT_EXACT_PATH, '/account/security')
const accountProfileRoute = accountRoute(
  '/account/profile',
  '/account/profile',
  () => import('./routes/account/ProfilePage'),
)
const accountSecurityRoute = accountRoute(
  '/account/security',
  '/account/security',
  () => import('./routes/account/SecurityPage'),
)
const accountDevicesRoute = accountRoute(
  '/account/devices',
  '/account/devices',
  () => import('./routes/account/DevicesPage'),
)
const accountOrganizationsRoute = accountRoute(
  '/account/organizations',
  '/account/organizations',
  () => import('./routes/account/OrganizationsPage'),
)
const accountPrivacyRoute = accountRoute(
  '/account/privacy',
  '/account/privacy',
  () => import('./routes/account/PrivacyPage'),
)
const accountDeleteRoute = accountRoute(
  '/account/privacy/delete',
  '/account/privacy/delete',
  () => import('./routes/account/DeleteAccountPage'),
)
const accountConnectionsRoute = accountRedirectRoute('/account/connections', '/account/security')
const accountSessionsRoute = accountRedirectRoute('/account/sessions', '/account/devices')

// 租户子域与自定义域名的 / 由 Core 承载:落账户门户,未登录由 RequireAuth 送去 /sign-in。
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => <Navigate to={ACCOUNT_EXACT_PATH} replace />,
})

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
  indexRoute,
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
  mfaSetupRoute,
  createPasskeyRoute,
  consentRoute,
  activateRoute,
  cibaActivationRoute,
  accountIndexRoute,
  accountProfileRoute,
  accountSecurityRoute,
  accountDevicesRoute,
  accountOrganizationsRoute,
  accountPrivacyRoute,
  accountDeleteRoute,
  accountConnectionsRoute,
  accountSessionsRoute,
  notFoundRoute,
])

export const router = createRouter({
  routeTree,
  defaultPendingComponent: CenterLoader,
  defaultErrorComponent: ({ error }) => <ErrorPage error={error} />,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
