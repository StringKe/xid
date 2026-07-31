// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type {
  AuditChainVerification,
  AuditEvent,
  BillingOverview,
  ComplianceDocument,
  FeatureFlag,
  GlobalUser,
  InstanceManagerAssignment,
  Page,
  PlatformAnnouncement,
  PlatformOrganization,
  PlatformSettings,
  QueueDeadLetter,
  StatusIncident,
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

vi.mock('@xid-kit/web-ui/enum-labels', () => ({
  statusToneFor: () => 'neutral',
  useBillingStatusLabel: () => (status: string) => status,
  useGlobalUserStatusLabel: () => (status: string) => status,
  useOrganizationStatusLabel: () => (status: string) => status,
}))

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}))

vi.mock('@xid-kit/web-ui/session', () => ({
  useAuth: () => ({
    user: {
      id: 'user_1',
      email: 'admin@example.com',
    },
    api: {
      post: vi.fn(),
    },
  }),
}))

import PlatformAdminOverview from './PlatformAdminOverview'
import PlatformAnnouncements from './PlatformAnnouncements'
import PlatformAuditEvents from './PlatformAuditEvents'
import PlatformBilling from './PlatformBilling'
import PlatformCompliance from './PlatformCompliance'
import PlatformDeadLetters from './PlatformDeadLetters'
import PlatformFeatureFlags from './PlatformFeatureFlags'
import PlatformInstanceManagers from './PlatformInstanceManagers'
import PlatformOrganizations from './PlatformOrganizations'
import PlatformSettingsPage from './PlatformSettings'
import PlatformStatusIncidents from './PlatformStatusIncidents'
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
  organizations: [{ id: organization.id, slug: organization.slug, name: organization.name }],
  status: 'active',
  createdAt: '2026-07-27T00:00:00.000Z',
}

const instanceManager: InstanceManagerAssignment = {
  id: 'manager_assignment_1',
  tenantId: organization.id,
  userId: globalUser.id,
  managerRole: 'instance_manager',
  scopeType: 'instance',
  scopeId: null,
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:00:00.000Z',
}

const auditEvent: AuditEvent = {
  id: 'audit_1',
  seq: 42,
  organizationId: organization.id,
  organizationName: organization.name,
  orgId: organization.id,
  eventType: 'login.succeeded',
  actorId: globalUser.id,
  actorDisplay: globalUser.id,
  actorIp: '192.0.2.1',
  targetType: 'session',
  targetId: 'session_1',
  occurredAt: '2026-07-27T00:00:00.000Z',
}

const auditVerification: AuditChainVerification = {
  tenant_id: organization.id,
  verified_range: { from: 1, to: 42 },
  chain_valid: true,
  broken_at_seq: null,
  failure_reason: null,
  record_count: 42,
  computed_at: '2026-07-27T00:00:00.000Z',
}

const deadLetter: QueueDeadLetter = {
  id: 'dlq_1',
  sourceQueue: 'xid-webhook',
  deadLetterQueue: 'xid-webhook-dlq',
  messageId: 'message_1',
  tenantId: organization.id,
  orgId: organization.id,
  eventType: 'user.updated',
  errorCode: 'consumer_retries_exhausted',
  status: 'pending',
  attempts: 1,
  sourceEnqueuedAt: '2026-07-27T00:00:00.000Z',
  failedAt: '2026-07-27T00:01:00.000Z',
  replayRequestedAt: null,
  replayedAt: null,
  replayedBy: null,
  replayCount: 0,
  lastReplayErrorCode: null,
}

const featureFlag: FeatureFlag = {
  key: 'beta_access',
  label: 'Beta access',
  description: 'Enables beta access.',
  globalDefault: true,
  organizationOverrides: 2,
}

const announcement: PlatformAnnouncement = {
  id: 'announcement_1',
  scopeType: 'global',
  scopeValue: null,
  title: 'Scheduled maintenance',
  body: 'The control plane will remain available.',
  severity: 'info',
  status: 'published',
  startsAt: '2026-07-27T00:00:00.000Z',
  endsAt: null,
  createdBy: globalUser.id,
  updatedBy: globalUser.id,
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:00:00.000Z',
}

const statusIncident: StatusIncident = {
  id: 'incident_1',
  title: 'Delayed webhooks',
  status: 'monitoring',
  impact: 'minor',
  summary: 'Webhook latency is returning to normal.',
  startedAt: '2026-07-27T00:00:00.000Z',
  resolvedAt: null,
  createdBy: globalUser.id,
  updatedBy: globalUser.id,
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:00:00.000Z',
  updates: [],
}

const complianceDocument: ComplianceDocument = {
  id: 'compliance_1',
  tenantId: null,
  documentType: 'dpa',
  title: 'Data processing addendum',
  status: 'available',
  storageKey: 'compliance/dpa/2026-07.pdf',
  checksum: 'sha256:test',
  version: '2026-07',
  acceptedBy: null,
  acceptedAt: null,
  generatedBy: globalUser.id,
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:00:00.000Z',
  artifactUrl: '/v1/platform/compliance-documents/compliance_1/artifact',
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
      '/v1/platform/manager-assignments',
      queryState({
        data: [instanceManager],
        nextCursor: null,
        total: 1,
      } satisfies Page<InstanceManagerAssignment>),
    )
    apiMocks.queries.set(
      '/v1/platform/audit-events',
      queryState({
        data: [auditEvent],
        nextCursor: null,
        total: 1,
      } satisfies Page<AuditEvent>),
    )
    apiMocks.queries.set('/v1/platform/audit/verify', queryState(auditVerification))
    apiMocks.queries.set(
      '/v1/platform/dead-letters',
      queryState({
        data: [deadLetter],
        nextCursor: null,
        total: 1,
      } satisfies Page<QueueDeadLetter>),
    )
    apiMocks.queries.set('/v1/platform/feature-flags', queryState([featureFlag]))
    apiMocks.queries.set(
      '/v1/platform/announcements',
      queryState({
        data: [announcement],
        nextCursor: 'announcement_cursor_2',
        total: 31,
      } satisfies Page<PlatformAnnouncement>),
    )
    apiMocks.queries.set(
      '/v1/platform/status-incidents',
      queryState({
        data: [statusIncident],
        nextCursor: 'incident_cursor_2',
        total: 31,
      } satisfies Page<StatusIncident>),
    )
    apiMocks.queries.set(
      '/v1/platform/compliance-documents',
      queryState({
        data: [complianceDocument],
        nextCursor: 'compliance_cursor_2',
        total: 31,
      } satisfies Page<ComplianceDocument>),
    )
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
    expect(html).toContain('Suspend')
    expect(html).toContain('href="/console/platform/plans?tenantId=org_1"')
    expect(html).not.toContain('href="/console/org/auth-policy')
  })

  it('keeps the global user query disabled until a search is submitted', () => {
    const html = renderToStaticMarkup(<PlatformUsers />)

    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(expect.anything(), '/v1/platform/users', {
      enabled: false,
      query: { cursor: undefined, limit: 20, q: '' },
    })
    expect(html).toContain('Global user search')
    expect(html).toContain('Enter a search query to find users.')
    expect(html).not.toContain(globalUser.email)
  })

  it('renders instance managers and prevents self-revocation', () => {
    const html = renderToStaticMarkup(<PlatformInstanceManagers />)

    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/platform/manager-assignments',
      { query: { cursor: undefined, limit: 50 } },
    )
    expect(html).toContain('Instance managers')
    expect(html).toContain(globalUser.id)
    expect(html).toContain('Current user')
    expect(html).toContain('disabled=""')
  })

  it('requests and renders the global audit event stream', () => {
    const html = renderToStaticMarkup(<PlatformAuditEvents />)

    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/platform/audit-events',
      { query: { cursor: undefined, limit: 30 } },
    )
    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/platform/audit/verify',
      {
        enabled: false,
        query: {
          tenant_id: undefined,
          from_seq: undefined,
          to_seq: undefined,
        },
      },
    )
    expect(html).toContain(auditEvent.eventType)
    expect(html).toContain(auditEvent.actorId ?? '')
    expect(html).toContain(auditEvent.targetId ?? '')
  })

  it('requests and renders dead letters as a standalone page', () => {
    const html = renderToStaticMarkup(<PlatformDeadLetters />)

    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/platform/dead-letters',
      { query: { cursor: undefined, limit: 30 } },
    )
    expect(html).toContain(deadLetter.sourceQueue)
    expect(html).toContain(deadLetter.eventType)
    expect(html).toContain('Replay')
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

  it.each([
    {
      name: 'announcements',
      path: '/v1/platform/announcements',
      cursor: 'announcement_cursor_2',
      content: announcement.title,
      component: <PlatformAnnouncements />,
    },
    {
      name: 'status incidents',
      path: '/v1/platform/status-incidents',
      cursor: 'incident_cursor_2',
      content: statusIncident.title,
      component: <PlatformStatusIncidents />,
    },
    {
      name: 'compliance documents',
      path: '/v1/platform/compliance-documents',
      cursor: 'compliance_cursor_2',
      content: complianceDocument.title,
      component: <PlatformCompliance />,
    },
  ])('follows the server cursor for $name', async ({ component, content, cursor, path }) => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(component)
    })

    expect(container.textContent).toContain(content)
    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(expect.anything(), path, {
      query: { cursor: undefined, limit: 30 },
    })

    const loadMore = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Load more',
    )
    expect(loadMore).toBeDefined()

    await act(async () => {
      loadMore?.click()
    })

    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(expect.anything(), path, {
      query: { cursor, limit: 30 },
    })

    await act(async () => {
      root.unmount()
    })
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
