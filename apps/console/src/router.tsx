import { Trans } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import {
  createLazyRoute,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Alert, Spinner } from '@xid-kit/web-ui/ui'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { ConsoleWebMcpTools } from './components/ConsoleWebMcpTools'
import { ConsoleLayout } from './components/layout/ConsoleLayout'
import { CONSOLE_NAV, ORG_NAV, PLATFORM_NAV } from './nav'
import { RequireAuth } from './components/RequireAuth'
import { RouteMetadata } from './components/RouteMetadata'
import {
  ConsoleOrganizationsEntry,
  ConsoleSettingsEntry,
  ConsoleUsersEntry,
} from './routes/console/ConsoleEntryRoutes'
import { RequireActiveOrganization } from './routes/console/RequireActiveOrganization'
import { RequirePlatformAdmin } from './routes/platform/RequirePlatformAdmin'

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

const rootRoute = createRootRoute({
  validateSearch: (search: Record<string, unknown>) => search,
  component: () => (
    <>
      <RouteMetadata />
      <ConsoleWebMcpTools />
      <Outlet />
    </>
  ),
})

function consoleRoute(id: string, path: string, load: PageLoader) {
  return createRoute({ getParentRoute: () => rootRoute, path }).lazy(() =>
    load().then((module) => {
      const Page = module.default
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

function orgRoute(id: string, path: string, load: PageLoader) {
  return createRoute({ getParentRoute: () => rootRoute, path }).lazy(() =>
    load().then((module) => {
      const Page = module.default
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

function platformRoute(id: string, path: string, load: PageLoader) {
  return createRoute({ getParentRoute: () => rootRoute, path }).lazy(() =>
    load().then((module) => {
      const Page = module.default
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

const consoleOverviewRoute = consoleRoute(
  '/console',
  '/console',
  () => import('./routes/console/ConsoleOverview'),
)
const consoleManagedProjectsRoute = consoleRoute(
  '/console/managed-projects',
  '/console/managed-projects',
  () => import('./routes/console/ManagedProjects'),
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
const consoleOrganizationsRoute = createRoute({
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

const orgRoutes = [
  orgRoute('/console/org', '/console/org', () => import('./routes/org/OrgOverview')),
  orgRoute('/console/org/members', '/console/org/members', () => import('./routes/org/OrgMembers')),
  orgRoute(
    '/console/org/projects',
    '/console/org/projects',
    () => import('./routes/org/OrgProjects'),
  ),
  orgRoute('/console/org/roles', '/console/org/roles', () => import('./routes/org/OrgRoles')),
  orgRoute(
    '/console/org/auth-policy',
    '/console/org/auth-policy',
    () => import('./routes/org/OrgAuthPolicy'),
  ),
  orgRoute(
    '/console/org/delivery-channels',
    '/console/org/delivery-channels',
    () => import('./routes/org/OrgDeliveryChannels'),
  ),
  orgRoute(
    '/console/org/social-providers',
    '/console/org/social-providers',
    () => import('./routes/org/OrgSocialProviders'),
  ),
  orgRoute('/console/org/sso', '/console/org/sso', () => import('./routes/org/OrgSso')),
  orgRoute(
    '/console/org/outbound-sso',
    '/console/org/outbound-sso',
    () => import('./routes/org/OrgOutboundSso'),
  ),
  orgRoute('/console/org/scim', '/console/org/scim', () => import('./routes/org/OrgScim')),
  orgRoute(
    '/console/org/scim-targets',
    '/console/org/scim-targets',
    () => import('./routes/org/OrgScimTargets'),
  ),
  orgRoute('/console/org/domains', '/console/org/domains', () => import('./routes/org/OrgDomains')),
  orgRoute(
    '/console/org/branding',
    '/console/org/branding',
    () => import('./routes/org/OrgBranding'),
  ),
  orgRoute(
    '/console/org/applications',
    '/console/org/applications',
    () => import('./routes/org/OrgApplications'),
  ),
  orgRoute(
    '/console/org/webhooks',
    '/console/org/webhooks',
    () => import('./routes/org/OrgWebhooks'),
  ),
  orgRoute(
    '/console/org/api-keys',
    '/console/org/api-keys',
    () => import('./routes/org/OrgApiKeys'),
  ),
  orgRoute(
    '/console/org/audit-events',
    '/console/org/audit-events',
    () => import('./routes/org/OrgAuditEvents'),
  ),
  orgRoute(
    '/console/org/compliance',
    '/console/org/compliance',
    () => import('./routes/org/OrgCompliance'),
  ),
]

const platformRoutes = [
  platformRoute(
    '/console/platform',
    '/console/platform',
    () => import('./routes/platform/PlatformAdminOverview'),
  ),
  platformRoute(
    '/console/platform/organizations',
    '/console/platform/organizations',
    () => import('./routes/platform/PlatformOrganizations'),
  ),
  platformRoute(
    '/console/platform/users',
    '/console/platform/users',
    () => import('./routes/platform/PlatformUsers'),
  ),
  platformRoute(
    '/console/platform/managers',
    '/console/platform/managers',
    () => import('./routes/platform/PlatformInstanceManagers'),
  ),
  platformRoute(
    '/console/platform/events',
    '/console/platform/events',
    () => import('./routes/platform/PlatformAuditEvents'),
  ),
  platformRoute(
    '/console/platform/flags',
    '/console/platform/flags',
    () => import('./routes/platform/PlatformFeatureFlags'),
  ),
  platformRoute(
    '/console/platform/billing',
    '/console/platform/billing',
    () => import('./routes/platform/PlatformBilling'),
  ),
  platformRoute(
    '/console/platform/plans',
    '/console/platform/plans',
    () => import('./routes/platform/PlatformPlans'),
  ),
  platformRoute(
    '/console/platform/announcements',
    '/console/platform/announcements',
    () => import('./routes/platform/PlatformAnnouncements'),
  ),
  platformRoute(
    '/console/platform/status',
    '/console/platform/status',
    () => import('./routes/platform/PlatformStatusIncidents'),
  ),
  platformRoute(
    '/console/platform/compliance',
    '/console/platform/compliance',
    () => import('./routes/platform/PlatformCompliance'),
  ),
  platformRoute(
    '/console/platform/dead-letters',
    '/console/platform/dead-letters',
    () => import('./routes/platform/PlatformDeadLetters'),
  ),
  platformRoute(
    '/console/platform/settings',
    '/console/platform/settings',
    () => import('./routes/platform/PlatformSettings'),
  ),
]

export const CONSOLE_SPA_ROUTE_PATHS = [
  '/console',
  '/console/managed-projects',
  '/console/users',
  '/console/organizations',
  '/console/settings',
  '/console/org',
  '/console/org/members',
  '/console/org/projects',
  '/console/org/roles',
  '/console/org/auth-policy',
  '/console/org/delivery-channels',
  '/console/org/social-providers',
  '/console/org/sso',
  '/console/org/outbound-sso',
  '/console/org/scim',
  '/console/org/scim-targets',
  '/console/org/domains',
  '/console/org/branding',
  '/console/org/applications',
  '/console/org/webhooks',
  '/console/org/api-keys',
  '/console/org/audit-events',
  '/console/org/compliance',
  '/console/platform',
  '/console/platform/organizations',
  '/console/platform/users',
  '/console/platform/managers',
  '/console/platform/events',
  '/console/platform/flags',
  '/console/platform/billing',
  '/console/platform/plans',
  '/console/platform/announcements',
  '/console/platform/status',
  '/console/platform/compliance',
  '/console/platform/dead-letters',
  '/console/platform/settings',
] as const

const notFoundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '$',
  component: () => (
    <RequireAuth>
      <ConsoleLayout navItems={CONSOLE_NAV}>
        <div {...stylex.props(page.root)}>
          <Alert tone="error">
            <Trans>Page not found</Trans>
          </Alert>
        </div>
      </ConsoleLayout>
    </RequireAuth>
  ),
})

const routeTree = rootRoute.addChildren([
  consoleOverviewRoute,
  consoleManagedProjectsRoute,
  consoleUsersRoute,
  consoleOrganizationsRoute,
  consoleSettingsRoute,
  ...orgRoutes,
  ...platformRoutes,
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
