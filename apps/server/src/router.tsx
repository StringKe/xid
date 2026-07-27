// 路由树(@tanstack/react-router,code-based)。
// 选 code-based 而非 file-based:契合现有显式 routes 结构,避免 router-plugin 代码生成与
// Cloudflare/lingui/StyleX 的 Vite 链路争用,路由表一处可读。
//
// 路径与 Hosted UI / console 设计对齐(01/02/05/06 章):
//   /sign-in /sign-up /forgot-password /reset-password /verify-email /mfa  Hosted UI(公开)
//   /consent     OIDC 同意页(须登录)
//   /activate    OAuth Device Flow 用户端授权页(须登录)
//   /account/*   account portal(须登录,AccountLayout)
//   / 和公开文档路径由独立 apps/site Nimbus Worker 接管
//   /console/*   由独立 apps/console SPA 与 Worker 接管,Core 路由树不挂载管理页面
//
// 守卫策略:沿用 React 组件守卫(RequireAuth),因 auth 态在 AuthProvider context,
// beforeLoad 跑在 React 之外读不到该 context。如需 loader 级守卫,把 auth 注入 router
// context(createRootRouteWithContext)后改用 beforeLoad + redirect,结构已为此预留。
//
// 代码分割:页面经 createRoute(...).lazy() 动态 import。
// search:root validateSearch passthrough 透传任意 query(continue/redirect_to/prompt_id/token/method/step_up),
// 兼容现有 useSearchParams().get(key) 读取(见 lib/router compat)。

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

// 默认导出页面模块的最小形状。
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

// ---- 加载骨架 ----

function CenterLoader(): ReactNode {
  return (
    <div {...stylex.props(styles.centerLoader)}>
      <Spinner size={32} />
    </div>
  )
}

// ---- 路由工厂:每个工厂把"动态 import 的页面"包成 createLazyRoute,套上对应守卫/壳 ----

// 须登录页:RequireAuth 包裹。
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

// account portal 页:RequireAuth + AccountLayout(并行加载布局与页面)。
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

// ---- 根路由 ----

const rootRoute = createRootRoute({
  // 透传任意 query,使现有 useSearchParams().get(key) 仍可读到(token/continue/redirect_to 等)。
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

// ---- 公开 ----

// sign-in / sign-up / forgot-password / mfa / verify-email 已导出 TanStack 原生 Route,直接挂 .lazy。
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

// /reset-password?token= 复用 forgot-password 的 reset 步骤。
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

// ---- 须登录:consent ----

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

// ---- 须登录:account portal ----

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

// ---- 兜底:未知路径 404(不静默重定向登录,避免公开 typo 被当成未认证) ----

const notFoundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '$',
}).lazy(() =>
  import('./routes/not-found/NotFoundPage').then((m) =>
    createLazyRoute('$')({ component: m.default }),
  ),
)

// ---- 组装路由树 ----

const routeTree = rootRoute.addChildren([
  signInRoute,
  signUpRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  verifyEmailRoute,
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

// 全局类型注册:Link/navigate 的路由感知。
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
