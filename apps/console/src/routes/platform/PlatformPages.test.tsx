// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type {
  AuditEvent,
  BillingOverview,
  FeatureFlag,
  GlobalUser,
  Page,
  PlatformOrganization,
  PlatformSettings,
} from './types'
import type { PlatformStats } from './PlatformOverviewMetrics'

type QueryState = {
  data: unknown
  error: Error | null
  isError: boolean
  isLoading: boolean
}

const apiMocks = vi.hoisted(() => ({
  queries: new Map<string, QueryState>(),
  useApiMutation: vi.fn(),
  useApiQuery: vi.fn(),
}))

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce(
        (message, part, index) => `${message}${String(values[index - 1] ?? '')}${part}`,
      ),
  }),
}))

vi.mock('@xid-kit/web-ui/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/web-ui/queries')>()
  return {
    ...actual,
    useApiMutation: apiMocks.useApiMutation,
    useApiQuery: apiMocks.useApiQuery,
  }
})

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}))

import PlatformAdminOverview from './PlatformAdminOverview'
import PlatformAuditEvents from './PlatformAuditEvents'
import PlatformBilling from './PlatformBilling'
import PlatformFeatureFlags from './PlatformFeatureFlags'
import PlatformOrganizations from './PlatformOrganizations'
import PlatformSettingsPage from './PlatformSettings'
import PlatformUsers from './PlatformUsers'

const stats: PlatformStats = {
  organizationCount: 12,
  totalUsers: 1234,
  dau: 120,
  mau: 600,
  loginSuccessRate: 0.975,
  activeOrgCount: 10,
}

const organization: PlatformOrganization = {
  id: 'org_1',
  slug: 'acme',
  name: 'Acme Platform',
  plan: 'enterprise',
  status: 'active',
  userCount: 25,
  orgCount: 3,
  createdAt: '2026-07-27T00:00:00.000Z',
}

const globalUser: GlobalUser = {
  id: 'user_1',
  email: 'admin@example.com',
  name: 'Platform Admin',
  organizationId: organization.id,
  organizationName: organization.name,
  status: 'active',
  createdAt: '2026-07-27T00:00:00.000Z',
}

const auditEvent: AuditEvent = {
  id: 'audit_1',
  seq: 42,
  organizationId: organization.id,
  organizationName: organization.name,
  orgId: organization.id,
  eventType: 'login.succeeded',
  actorId: globalUser.id,
  actorIp: '192.0.2.1',
  targetType: 'session',
  targetId: 'session_1',
  occurredAt: '2026-07-27T00:00:00.000Z',
}

const featureFlag: FeatureFlag = {
  key: 'beta_access',
  label: 'Beta access',
  description: 'Enables beta access.',
  globalDefault: true,
  organizationOverrides: 2,
}

const billingOverview: BillingOverview = {
  organizationId: organization.id,
  organizationName: organization.name,
  plan: organization.plan,
  mau: 600,
  dau: 120,
  seatUsed: 25,
  seatLimit: 50,
  status: 'overdue',
}

const settings: PlatformSettings = {
  id: 'instance_1',
  name: 'XID',
  primaryDomain: 'xid.example',
  mode: 'multi-tenant',
  defaultLocale: 'en',
  dataResidency: 'global',
  mfaPolicy: 'required',
  passwordPolicy: {},
  sessionPolicy: {},
  status: 'active',
}

function queryState(data: unknown): QueryState {
  return {
    data,
    error: null,
    isError: false,
    isLoading: false,
  }
}

describe('platform pages', () => {
  beforeEach(() => {
    apiMocks.useApiMutation.mockReset()
    apiMocks.useApiQuery.mockReset()
    apiMocks.queries.clear()
    apiMocks.queries.set('/v1/platform/stats', queryState(stats))
    apiMocks.queries.set(
      '/v1/platform/organizations',
      queryState({
        data: [organization],
        nextCursor: null,
        total: 1,
      } satisfies Page<PlatformOrganization>),
    )
    apiMocks.queries.set(
      '/v1/platform/users',
      queryState({
        data: [globalUser],
        nextCursor: null,
        total: 1,
      } satisfies Page<GlobalUser>),
    )
    apiMocks.queries.set(
      '/v1/platform/audit-events',
      queryState({
        data: [auditEvent],
        nextCursor: null,
        total: 1,
      } satisfies Page<AuditEvent>),
    )
    apiMocks.queries.set('/v1/platform/feature-flags', queryState([featureFlag]))
    apiMocks.queries.set(
      '/v1/platform/billing',
      queryState({
        data: [billingOverview],
        nextCursor: null,
        total: 1,
      } satisfies Page<BillingOverview>),
    )
    apiMocks.queries.set('/v1/platform/settings', queryState(settings))
    apiMocks.useApiQuery.mockImplementation((_queryKey: readonly unknown[], path: string) =>
      apiMocks.queries.get(path),
    )
    apiMocks.useApiMutation.mockReturnValue({
      error: null,
      isError: false,
      isPending: false,
      isSuccess: false,
      mutate: vi.fn(),
      variables: undefined,
    })
  })

  it('requests and renders the platform overview stats', () => {
    const html = renderToStaticMarkup(<PlatformAdminOverview />)

    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(['platform', 'stats'], '/v1/platform/stats')
    expect(html).toContain('Platform overview')
    expect(html).toContain('Global metrics')
    expect(html).toContain('1,234')
    expect(html).toContain('97.5%')
  })

  it('requests and renders organizations with scoped management links', () => {
    const html = renderToStaticMarkup(<PlatformOrganizations />)

    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/platform/organizations',
      { query: { cursor: undefined, limit: 20, q: '' } },
    )
    expect(html).toContain('Acme Platform')
    expect(html).toContain('href="/console/org/auth-policy?orgId=org_1&amp;orgName=Acme+Platform"')
    expect(html).toContain(
      'href="/console/org/social-providers?orgId=org_1&amp;orgName=Acme+Platform"',
    )
  })

  it('keeps the global user query disabled until a search is submitted', () => {
    const html = renderToStaticMarkup(<PlatformUsers />)

    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(expect.anything(), '/v1/platform/users', {
      enabled: false,
      query: { limit: 20, q: '' },
    })
    expect(html).toContain('Global user search')
    expect(html).toContain('Enter a search query to find users.')
    expect(html).not.toContain(globalUser.email)
  })

  it('requests and renders the global audit event stream', () => {
    const html = renderToStaticMarkup(<PlatformAuditEvents />)

    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/platform/audit-events',
      { query: { cursor: undefined, limit: 30 } },
    )
    expect(html).toContain(auditEvent.eventType)
    expect(html).toContain(auditEvent.actorId ?? '')
    expect(html).toContain(auditEvent.targetId ?? '')
  })

  it('requests and renders feature flag defaults', () => {
    const html = renderToStaticMarkup(<PlatformFeatureFlags />)

    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/platform/feature-flags',
    )
    expect(html).toContain(featureFlag.key)
    expect(html).toContain(featureFlag.label)
    expect(html).toContain('2 organization overrides')
    expect(html).toContain('Disable')
  })

  it('requests and renders the billing overview', () => {
    const html = renderToStaticMarkup(<PlatformBilling />)

    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(expect.anything(), '/v1/platform/billing', {
      query: { cursor: undefined, limit: 20 },
    })
    expect(html).toContain(billingOverview.organizationName)
    expect(html).toContain('25')
    expect(html).toContain('50')
    expect(html).toContain(billingOverview.status)
  })

  it('requests and renders instance-wide platform settings', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<PlatformSettingsPage />)
    })

    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(expect.anything(), '/v1/platform/settings')
    expect(container.textContent).toContain('Platform settings')
    expect(container.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe(settings.name)
    expect(container.querySelector<HTMLSelectElement>('select')?.value).toBe(settings.mfaPolicy)

    await act(async () => {
      root.unmount()
    })
  })
})
