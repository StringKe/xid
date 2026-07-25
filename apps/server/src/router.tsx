// 路由树(@tanstack/react-router,code-based)。
// 选 code-based 而非 file-based:契合现有显式 routes 结构,避免 router-plugin 代码生成与
// Cloudflare/lingui/StyleX 的 Vite 链路争用,路由表一处可读。
//
// 路径与 Hosted UI / console 设计对齐(01/02/05/06 章):
//   /            landing(brand,公开)
//   /sign-in /sign-up /forgot-password /reset-password /verify-email /mfa  Hosted UI(公开)
//   /consent     OIDC 同意页(须登录)
//   /activate    OAuth Device Flow 用户端授权页(须登录)
//   /account/*   account portal(须登录,AccountLayout)
//   /console/*   统一 console(须登录,ConsoleLayout)
//   /console/platform/*  平台运营视图(须登录 + instance_manager 守卫)
//
// 守卫策略:沿用 React 组件守卫(RequireAuth / RequirePlatformAdmin),因 auth 态在 AuthProvider
// context,beforeLoad 跑在 React 之外读不到该 context。如需 loader 级守卫,把 auth 注入 router
// context(createRootRouteWithContext)后改用 beforeLoad + redirect,结构已为此预留。
//
// 代码分割:页面经 createRoute(...).lazy() 动态 import;landing chunk 由构建注入 modulepreload。
// search:root validateSearch passthrough 透传任意 query(continue/redirect_to/prompt_id/token/method/step_up),
// 兼容现有 useSearchParams().get(key) 读取(见 lib/router compat)。

import { Trans } from '@lingui/react/macro'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import {
  createLazyRoute,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import * as stylex from '@stylexjs/stylex'
import { useLocation } from './lib/router'
import { AuthAnalytics } from './components/AuthAnalytics'
import { RouteAnalytics } from './components/RouteAnalytics'

import { RoutePageSeo } from './components/RoutePageSeo'
import { WebMcpTools } from './components/WebMcpTools'

import { ConsoleLayout } from './components/layout'
import type { ConsoleNavItem } from './components/layout'
import { Spinner } from './components/ui'
import { RequireAuth } from './components/RequireAuth'
import { isPublicLandingPath, useAuth } from './lib/auth-context'
import { RequireActiveOrganization } from './routes/console/RequireActiveOrganization'
import { RequirePlatformAdmin } from './routes/platform/RequirePlatformAdmin'
import {
  ConsoleOrganizationsEntry,
  ConsoleSettingsEntry,
  ConsoleUsersEntry,
} from './routes/console/ConsoleEntryRoutes'

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

// ---- 侧栏导航 ----

const CONSOLE_NAV: readonly ConsoleNavItem[] = [
  { to: '/console', label: <Trans>Overview</Trans>, end: true },
  { to: '/console/users', label: <Trans>Users</Trans> },
  { to: '/console/organizations', label: <Trans>Organizations</Trans> },
  { to: '/console/sessions', label: <Trans>Sessions</Trans> },
  { to: '/console/security', label: <Trans>Security</Trans> },
  { to: '/console/settings', label: <Trans>Settings</Trans> },
]

const ORG_NAV: readonly ConsoleNavItem[] = [
  { to: '/console/org', label: <Trans>Overview</Trans>, end: true },
  {
    to: '/console/org/auth-policy',
    label: <Trans>Auth policy</Trans>,
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/social-providers',
    label: <Trans>Social providers</Trans>,
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/sso',
    label: <Trans>Inbound SSO</Trans>,
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/outbound-sso',
    label: <Trans>Outbound SSO</Trans>,
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/scim',
    label: <Trans>Directory sync</Trans>,
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/scim-targets',
    label: <Trans>SCIM targets</Trans>,
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/delivery-channels',
    label: <Trans>Delivery channels</Trans>,
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/applications',
    label: <Trans>Applications</Trans>,
    groupKey: 'resources',
    groupLabel: <Trans>Resources</Trans>,
  },
  {
    to: '/console/org/api-keys',
    label: <Trans>API keys</Trans>,
    groupKey: 'resources',
    groupLabel: <Trans>Resources</Trans>,
  },
  {
    to: '/console/org/webhooks',
    label: <Trans>Webhooks</Trans>,
    groupKey: 'resources',
    groupLabel: <Trans>Resources</Trans>,
  },
  {
    to: '/console/org/domains',
    label: <Trans>Domains</Trans>,
    groupKey: 'resources',
    groupLabel: <Trans>Resources</Trans>,
  },
  {
    to: '/console/org/branding',
    label: <Trans>Branding</Trans>,
    groupKey: 'resources',
    groupLabel: <Trans>Resources</Trans>,
  },
  {
    to: '/console/org/members',
    label: <Trans>Members</Trans>,
    groupKey: 'people',
    groupLabel: <Trans>People</Trans>,
  },
  {
    to: '/console/org/roles',
    label: <Trans>Roles</Trans>,
    groupKey: 'people',
    groupLabel: <Trans>People</Trans>,
  },
  {
    to: '/console/org/audit-events',
    label: <Trans>Audit events</Trans>,
    groupKey: 'activity',
    groupLabel: <Trans>Activity</Trans>,
  },
]

const PLATFORM_NAV: readonly ConsoleNavItem[] = [
  { to: '/console/platform', label: <Trans>Overview</Trans>, end: true },
  { to: '/console/platform/organizations', label: <Trans>Organizations</Trans> },
  { to: '/console/platform/users', label: <Trans>Users</Trans> },
  { to: '/console/platform/events', label: <Trans>Event stream</Trans> },
  { to: '/console/platform/flags', label: <Trans>Feature flags</Trans> },
  { to: '/console/platform/billing', label: <Trans>Billing</Trans> },
  { to: '/console/platform/settings', label: <Trans>Settings</Trans> },
]

// ---- 路由工厂:每个工厂把"动态 import 的页面"包成 createLazyRoute,套上对应守卫/壳 ----

// 公开页:无守卫,直接渲染页面默认导出。
function publicRoute(id: string, path: string, load: PageLoader) {
  return createRoute({ getParentRoute: () => rootRoute, path }).lazy(() =>
    load().then((m) => {
      const Page = m.default
      return createLazyRoute(id)({ component: Page })
    }),
  )
}

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

// org console 页:RequireAuth + ConsoleLayout(ORG_NAV)。
function orgRoute(id: string, path: string, load: PageLoader) {
  return createRoute({ getParentRoute: () => rootRoute, path }).lazy(() =>
    load().then((m) => {
      const Page = m.default
      return createLazyRoute(id)({
        component: () => (
          <RequireAuth>
            <RequireActiveOrganization>
              <ConsoleLayout navItems={ORG_NAV}>
                <Page />
              </ConsoleLayout>
            </RequireActiveOrganization>
          </RequireAuth>
        ),
      })
    }),
  )
}

// 平台视图页:RequireAuth + RequirePlatformAdmin + ConsoleLayout(PLATFORM_NAV)。
function platformRoute(id: string, path: string, load: PageLoader) {
  return createRoute({ getParentRoute: () => rootRoute, path }).lazy(() =>
    load().then((m) => {
      const Page = m.default
      return createLazyRoute(id)({
        component: () => (
          <RequireAuth>
            <RequirePlatformAdmin>
              <ConsoleLayout navItems={PLATFORM_NAV}>
                <Page />
              </ConsoleLayout>
            </RequirePlatformAdmin>
          </RequireAuth>
        ),
      })
    }),
  )
}

// 离开 landing/docs 或直开受保护路由时探活 /v1/me(landing 首屏故意延后,见 auth-context)。
function SessionRefreshOnRoute(): null {
  const { pathname } = useLocation()
  const { refresh } = useAuth()

  useEffect(() => {
    if (isPublicLandingPath(pathname)) return
    void refresh()
  }, [pathname, refresh])

  return null
}

// ---- 根路由 ----

const rootRoute = createRootRoute({
  // 透传任意 query,使现有 useSearchParams().get(key) 仍可读到(token/continue/redirect_to 等)。
  validateSearch: (search: Record<string, unknown>) => search,
  component: () => (
    <>
      <SessionRefreshOnRoute />
      <RoutePageSeo />
      <RouteAnalytics />
      <WebMcpTools />
      <AuthAnalytics />
      <Outlet />
    </>
  ),
})

// ---- 公开 ----

const homeRoute = publicRoute('/', '/', () => import('./routes/home/HomePage'))
const docsIndexRoute = publicRoute('/docs', '/docs', () => import('./routes/docs/index'))
const docsCatchRoute = publicRoute('/docs/$', '/docs/$', () => import('./routes/docs/index'))
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

// ---- 须登录:console ----

function consoleRoute(id: string, path: string, load: PageLoader) {
  return createRoute({ getParentRoute: () => rootRoute, path }).lazy(() =>
    load().then((m) => {
      const Page = m.default
      return createLazyRoute(id)({
        component: () => (
          <RequireAuth>
            <ConsoleLayout navItems={CONSOLE_NAV}>
              <Page />
            </ConsoleLayout>
          </RequireAuth>
        ),
      })
    }),
  )
}

const consoleOverviewRoute = consoleRoute(
  '/console',
  '/console',
  () => import('./routes/console/ConsoleOverview'),
)
const consoleUsersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/console/users',
  component: () => (
    <RequireAuth>
      <ConsoleLayout navItems={CONSOLE_NAV}>
        <ConsoleUsersEntry />
      </ConsoleLayout>
    </RequireAuth>
  ),
})
const consoleOrgsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/console/organizations',
  component: () => (
    <RequireAuth>
      <ConsoleLayout navItems={CONSOLE_NAV}>
        <ConsoleOrganizationsEntry />
      </ConsoleLayout>
    </RequireAuth>
  ),
})
const consoleSessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/console/sessions',
}).lazy(() =>
  import('./routes/account/SessionsPage').then((m) => {
    const Page = m.default
    return createLazyRoute('/console/sessions')({
      component: () => (
        <RequireAuth>
          <ConsoleLayout navItems={CONSOLE_NAV}>
            <Page />
          </ConsoleLayout>
        </RequireAuth>
      ),
    })
  }),
)
const consoleSecurityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/console/security',
}).lazy(() =>
  import('./routes/account/SecurityPage').then((m) => {
    const Page = m.default
    return createLazyRoute('/console/security')({
      component: () => (
        <RequireAuth>
          <ConsoleLayout navItems={CONSOLE_NAV}>
            <Page />
          </ConsoleLayout>
        </RequireAuth>
      ),
    })
  }),
)
const consoleSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/console/settings',
  component: () => (
    <RequireAuth>
      <ConsoleLayout navItems={CONSOLE_NAV}>
        <ConsoleSettingsEntry />
      </ConsoleLayout>
    </RequireAuth>
  ),
})

// ---- 须登录:org 管理 console ----

const orgOverviewRoute = orgRoute(
  '/console/org',
  '/console/org',
  () => import('./routes/org/OrgOverview'),
)
const orgMembersRoute = orgRoute(
  '/console/org/members',
  '/console/org/members',
  () => import('./routes/org/OrgMembers'),
)
const orgRolesRoute = orgRoute(
  '/console/org/roles',
  '/console/org/roles',
  () => import('./routes/org/OrgRoles'),
)
const orgAuthPolicyRoute = orgRoute(
  '/console/org/auth-policy',
  '/console/org/auth-policy',
  () => import('./routes/org/OrgAuthPolicy'),
)
const orgDeliveryChannelsRoute = orgRoute(
  '/console/org/delivery-channels',
  '/console/org/delivery-channels',
  () => import('./routes/org/OrgDeliveryChannels'),
)
const orgSocialProvidersRoute = orgRoute(
  '/console/org/social-providers',
  '/console/org/social-providers',
  () => import('./routes/org/OrgSocialProviders'),
)
const orgSsoRoute = orgRoute(
  '/console/org/sso',
  '/console/org/sso',
  () => import('./routes/org/OrgSso'),
)
const orgOutboundSsoRoute = orgRoute(
  '/console/org/outbound-sso',
  '/console/org/outbound-sso',
  () => import('./routes/org/OrgOutboundSso'),
)
const orgScimRoute = orgRoute(
  '/console/org/scim',
  '/console/org/scim',
  () => import('./routes/org/OrgScim'),
)
const orgScimTargetsRoute = orgRoute(
  '/console/org/scim-targets',
  '/console/org/scim-targets',
  () => import('./routes/org/OrgScimTargets'),
)
const orgDomainsRoute = orgRoute(
  '/console/org/domains',
  '/console/org/domains',
  () => import('./routes/org/OrgDomains'),
)
const orgBrandingRoute = orgRoute(
  '/console/org/branding',
  '/console/org/branding',
  () => import('./routes/org/OrgBranding'),
)
const orgApplicationsRoute = orgRoute(
  '/console/org/applications',
  '/console/org/applications',
  () => import('./routes/org/OrgApplications'),
)
const orgWebhooksRoute = orgRoute(
  '/console/org/webhooks',
  '/console/org/webhooks',
  () => import('./routes/org/OrgWebhooks'),
)
const orgApiKeysRoute = orgRoute(
  '/console/org/api-keys',
  '/console/org/api-keys',
  () => import('./routes/org/OrgApiKeys'),
)
const orgAuditEventsRoute = orgRoute(
  '/console/org/audit-events',
  '/console/org/audit-events',
  () => import('./routes/org/OrgAuditEvents'),
)

// ---- 须登录 + instance_manager 守卫:统一 console 平台视图 ----

const platformOverviewRoute = platformRoute(
  '/console/platform',
  '/console/platform',
  () => import('./routes/platform/PlatformAdminOverview'),
)
const platformOrganizationsRoute = platformRoute(
  '/console/platform/organizations',
  '/console/platform/organizations',
  () => import('./routes/platform/PlatformOrganizations'),
)
const platformUsersRoute = platformRoute(
  '/console/platform/users',
  '/console/platform/users',
  () => import('./routes/platform/PlatformUsers'),
)
const platformEventsRoute = platformRoute(
  '/console/platform/events',
  '/console/platform/events',
  () => import('./routes/platform/PlatformAuditEvents'),
)
const platformFlagsRoute = platformRoute(
  '/console/platform/flags',
  '/console/platform/flags',
  () => import('./routes/platform/PlatformFeatureFlags'),
)
const platformBillingRoute = platformRoute(
  '/console/platform/billing',
  '/console/platform/billing',
  () => import('./routes/platform/PlatformBilling'),
)
const platformSettingsRoute = platformRoute(
  '/console/platform/settings',
  '/console/platform/settings',
  () => import('./routes/platform/PlatformSettings'),
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
  homeRoute,
  docsIndexRoute,
  docsCatchRoute,
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
  consoleOverviewRoute,
  consoleUsersRoute,
  consoleOrgsRoute,
  consoleSessionsRoute,
  consoleSecurityRoute,
  consoleSettingsRoute,
  orgOverviewRoute,
  orgMembersRoute,
  orgRolesRoute,
  orgAuthPolicyRoute,
  orgDeliveryChannelsRoute,
  orgSocialProvidersRoute,
  orgSsoRoute,
  orgOutboundSsoRoute,
  orgScimRoute,
  orgScimTargetsRoute,
  orgDomainsRoute,
  orgBrandingRoute,
  orgApplicationsRoute,
  orgWebhooksRoute,
  orgApiKeysRoute,
  orgAuditEventsRoute,
  platformOverviewRoute,
  platformOrganizationsRoute,
  platformUsersRoute,
  platformEventsRoute,
  platformFlagsRoute,
  platformBillingRoute,
  platformSettingsRoute,
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
