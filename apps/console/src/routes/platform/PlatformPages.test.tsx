// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type {
  AuditChainVerification,
  ComplianceDocument,
  GlobalUser,
  InstanceManagerAssignment,
  PlatformAnnouncement,
  PlatformAuditEvent,
  PlatformOrganization,
  PlatformSettings,
  PlatformStats,
  QueueDeadLetter,
  StatusIncident,
  UsageOverview,
} from '@xid-kit/types'

type QueryState = {
  data: unknown
  error: Error | null
  isError: boolean
  isLoading: boolean
  isFetching?: boolean
  refetch?: () => void
}

type ListState = {
  data: { data: unknown[]; nextCursor: string | null; total: number }
  isLoading: boolean
  isError: boolean
  error: null
  hasNextPage: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => Promise<unknown>
}

const apiMocks = vi.hoisted(() => ({
  fetchNextPage: vi.fn(() => Promise.resolve()),
  lists: new Map<string, ListState>(),
  queries: new Map<string, QueryState>(),
  useApiInfiniteQuery: vi.fn(),
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
    i18n: {
      date: (value: Date, options: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat('en', options).format(value),
    },
  }),
}))

vi.mock('@xid-kit/web-ui/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/web-ui/queries')>()
  return {
    ...actual,
    useApiInfiniteQuery: apiMocks.useApiInfiniteQuery,
    useApiMutation: apiMocks.useApiMutation,
    useApiQuery: apiMocks.useApiQuery,
  }
})

vi.mock('@xid-kit/web-ui/api-error-message', () => ({
  useApiErrorMessage: () => (error: { code: string }) => `error:${error.code}`,
}))

vi.mock('@xid-kit/web-ui/enum-labels', () => ({
  statusToneFor: () => 'neutral',
  useBillingStatusLabel: () => (status: string) => status,
  useGlobalUserStatusLabel: () => (status: string) => status,
  useOrganizationStatusLabel: () => (status: string) => status,
}))

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  useSearchParams: () => [new URLSearchParams('')],
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
import PlatformCompliance from './PlatformCompliance'
import PlatformDeadLetters from './PlatformDeadLetters'
import PlatformInstanceManagers from './PlatformInstanceManagers'
import PlatformOrganizations from './PlatformOrganizations'
import PlatformSettingsPage from './PlatformSettings'
import PlatformStatusIncidents from './PlatformStatusIncidents'
import PlatformUsage from './PlatformUsage'
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
  status: 'active',
  userCount: 25,
  orgCount: 3,
  createdAt: '2026-07-27T00:00:00.000Z',
  canChangeStatus: true,
}

const defaultOrganization: PlatformOrganization = {
  ...organization,
  id: 'org_default',
  slug: 'default',
  name: 'Default Organization',
  canChangeStatus: false,
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
  email: globalUser.email,
  displayName: globalUser.name,
  userStatus: 'active',
  organizationName: organization.name,
  managerRole: 'instance_manager',
  scopeType: 'instance',
  scopeId: null,
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:00:00.000Z',
}

const auditEvent: PlatformAuditEvent = {
  id: 'audit_1',
  seq: 42,
  organizationId: organization.id,
  organizationName: organization.name,
  orgId: organization.id,
  eventType: 'auth.login_succeeded',
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
  truncated: false,
  latest_seq: 42,
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
  status: 'replaying',
  replayable: true,
  attempts: 5,
  sourceEnqueuedAt: '2026-07-27T00:00:00.000Z',
  failedAt: '2026-07-27T00:01:00.000Z',
  replayRequestedAt: '2026-07-27T00:02:00.000Z',
  replayedAt: null,
  replayedBy: null,
  replayCount: 1,
  lastReplayErrorCode: 'queue_send_failed',
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
  tenantId: organization.id,
  organizationName: organization.name,
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

const usageOverview: UsageOverview = {
  organizationId: organization.id,
  organizationName: organization.name,
  mau: 600,
  dau: 120,
  seatUsed: 25,
}

const settings: PlatformSettings = {
  id: 'instance_1',
  name: 'XID',
  primaryDomain: 'xid.example',
  mode: 'multi-tenant',
  defaultLocale: 'en',
  dataResidency: 'us',
  mfaPolicy: 'required',
  passwordPolicy: {},
  sessionPolicy: { idleTimeoutMin: 30, absoluteTimeoutDays: 7 },
  tokenPolicy: {
    accessTokenTtlSec: 3600,
    sessionTokenTtlSec: 60,
    refreshIdleTimeoutDays: 30,
    refreshAbsoluteTimeoutDays: 7,
  },
  status: 'active',
}

function queryState(data: unknown): QueryState {
  return {
    data,
    error: null,
    isError: false,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
  }
}

function listState(rows: unknown[], hasNextPage = false): ListState {
  return {
    data: { data: rows, nextCursor: hasNextPage ? 'next_cursor' : null, total: rows.length },
    isLoading: false,
    isError: false,
    error: null,
    hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage: apiMocks.fetchNextPage,
  }
}

describe('platform pages', () => {
  beforeEach(() => {
    apiMocks.fetchNextPage.mockReset()
    apiMocks.useApiInfiniteQuery.mockReset()
    apiMocks.useApiMutation.mockReset()
    apiMocks.useApiQuery.mockReset()
    apiMocks.queries.clear()
    apiMocks.lists.clear()
    apiMocks.queries.set('/v1/platform/stats', queryState(stats))
    apiMocks.queries.set('/v1/platform/audit/verify', queryState(auditVerification))
    apiMocks.queries.set('/v1/platform/settings', queryState(settings))
    apiMocks.lists.set('/v1/platform/organizations', listState([organization, defaultOrganization]))
    apiMocks.lists.set('/v1/platform/users', listState([globalUser]))
    apiMocks.lists.set('/v1/platform/manager-assignments', listState([instanceManager]))
    apiMocks.lists.set('/v1/platform/audit-events', listState([auditEvent]))
    apiMocks.lists.set('/v1/platform/dead-letters', listState([deadLetter]))
    apiMocks.lists.set('/v1/platform/announcements', listState([announcement], true))
    apiMocks.lists.set('/v1/platform/status-incidents', listState([statusIncident], true))
    apiMocks.lists.set('/v1/platform/compliance-documents', listState([complianceDocument], true))
    apiMocks.lists.set('/v1/platform/usage', listState([usageOverview]))
    apiMocks.useApiQuery.mockImplementation((_queryKey: readonly unknown[], path: string) =>
      apiMocks.queries.get(path),
    )
    apiMocks.useApiInfiniteQuery.mockImplementation((_queryKey: readonly unknown[], path: string) =>
      apiMocks.lists.get(path),
    )
    apiMocks.useApiMutation.mockReturnValue({
      error: null,
      isError: false,
      isPending: false,
      isSuccess: false,
      mutate: vi.fn(),
      reset: vi.fn(),
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

  it('shows no data instead of a perfect login success rate when there are no login events', () => {
    apiMocks.queries.set('/v1/platform/stats', queryState({ ...stats, loginSuccessRate: null }))

    const html = renderToStaticMarkup(<PlatformAdminOverview />)

    expect(html.match(/No data/g)).toHaveLength(2)
    expect(html).not.toContain('97.5%')
  })

  it('renders organizations with visible ids and hides suspend for the default organization', () => {
    const html = renderToStaticMarkup(<PlatformOrganizations />)

    expect(apiMocks.useApiInfiniteQuery).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/platform/organizations',
      { query: { limit: 20, q: undefined } },
    )
    expect(html).toContain('Acme Platform')
    expect(html).toContain(organization.id)
    expect(html).toContain('Suspend Acme Platform')
    expect(html).not.toContain('Suspend Default Organization')
    expect(html).toContain('href="/console/platform/quotas?tenantId=org_1"')
    expect(html).not.toMatch(/plan/i)
    expect(html).not.toContain('href="/console/org/auth-policy')
  })

  it('keeps the global user query disabled until a search is submitted', () => {
    const html = renderToStaticMarkup(<PlatformUsers />)

    expect(apiMocks.useApiInfiniteQuery).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/platform/users',
      { enabled: false, query: { limit: 20, q: '' } },
    )
    expect(html).toContain('Global user search')
    expect(html).toContain('Enter a search query to find users.')
    expect(html).not.toContain(globalUser.email)
  })

  it('renders instance managers by email and prevents self-revocation', () => {
    const html = renderToStaticMarkup(<PlatformInstanceManagers />)

    expect(apiMocks.useApiInfiniteQuery).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/platform/manager-assignments',
      { query: { limit: 50 } },
    )
    expect(html).toContain('Instance managers')
    expect(html).toContain(globalUser.email)
    expect(html).toContain(globalUser.id)
    expect(html).toContain(organization.name)
    expect(html).toContain('Current user')
    expect(html).toContain('aria-disabled="true"')
  })

  it('renders the global audit event stream with an organization picker for verification', () => {
    const html = renderToStaticMarkup(<PlatformAuditEvents />)

    expect(apiMocks.useApiInfiniteQuery).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/platform/audit-events',
      { query: { limit: 30 } },
    )
    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/platform/audit/verify',
      expect.objectContaining({ enabled: false, staleTime: 0 }),
    )
    expect(html).toContain(auditEvent.eventType)
    expect(html).toContain(auditEvent.targetId ?? '')
    expect(html).toContain('Platform (instance-level events)')
    expect(html).toContain('Acme Platform (acme)')
    expect(html).not.toContain('Tenant ID')
  })

  it('reports a broken chain when the range predecessor is missing and no row was read', () => {
    apiMocks.queries.set(
      '/v1/platform/audit/verify',
      queryState({
        ...auditVerification,
        verified_range: { from: 10, to: 42 },
        chain_valid: false,
        broken_at_seq: 10,
        failure_reason: 'audit_seq_gap',
        record_count: 0,
      }),
    )

    const html = renderToStaticMarkup(<PlatformAuditEvents />)

    expect(html).toContain('Chain broken')
    expect(html).toContain('A sequence number is missing from the chain.')
    expect(html).not.toContain('This tenant has no audit records yet')
  })

  it('shows a neutral notice instead of a valid chain for a tenant without audit records', () => {
    apiMocks.queries.set(
      '/v1/platform/audit/verify',
      queryState({
        ...auditVerification,
        verified_range: { from: 1, to: 0 },
        latest_seq: 0,
        record_count: 0,
      }),
    )

    const html = renderToStaticMarkup(<PlatformAuditEvents />)

    expect(html).toContain('This tenant has no audit records yet')
    expect(html).not.toContain('Chain valid')
  })

  it('offers replay for an expired replaying lease and shows failure details', () => {
    const html = renderToStaticMarkup(<PlatformDeadLetters />)

    expect(apiMocks.useApiInfiniteQuery).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/platform/dead-letters',
      { query: { limit: 30 } },
    )
    expect(html).toContain(deadLetter.sourceQueue)
    expect(html).toContain(deadLetter.errorCode)
    expect(html).toContain('queue_send_failed')
    expect(html).toContain('Replay message to xid-webhook')
  })

  it.each([
    {
      name: 'announcements',
      path: '/v1/platform/announcements',
      content: announcement.title,
      component: <PlatformAnnouncements />,
    },
    {
      name: 'status incidents',
      path: '/v1/platform/status-incidents',
      content: statusIncident.title,
      component: <PlatformStatusIncidents />,
    },
    {
      name: 'compliance documents',
      path: '/v1/platform/compliance-documents',
      content: complianceDocument.title,
      component: <PlatformCompliance />,
    },
  ])('appends the next page for $name', async ({ component, content, path }) => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(component)
    })

    expect(container.textContent).toContain(content)
    expect(apiMocks.useApiInfiniteQuery).toHaveBeenCalledWith(expect.anything(), path, {
      query: { limit: 30 },
    })

    const loadMore = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Load more',
    )
    expect(loadMore).toBeDefined()

    await act(async () => {
      loadMore?.click()
    })

    expect(apiMocks.fetchNextPage).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain(content)

    await act(async () => {
      root.unmount()
    })
  })

  it('defaults new incidents to the local wall-clock time', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<PlatformStatusIncidents />)
    })

    const startedAt = container.querySelector<HTMLInputElement>('input[type="datetime-local"]')
    const now = new Date()
    const offset = now.getTimezoneOffset() * 60_000
    const expectedPrefix = new Date(now.getTime() - offset).toISOString().slice(0, 13)
    expect(startedAt?.value.startsWith(expectedPrefix)).toBe(true)
    expect(container.textContent).not.toContain('Resolve incident')

    await act(async () => {
      root.unmount()
    })
  })

  it('renders metered usage without any billing wording while billing is off', () => {
    apiMocks.queries.set(
      '/v1/platform/billing/config',
      queryState({ enabled: false, portal: false, metering: false }),
    )

    const html = renderToStaticMarkup(<PlatformUsage />)

    expect(apiMocks.useApiInfiniteQuery).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/platform/usage',
      { query: { limit: 20 } },
    )
    expect(html).toContain('Usage overview')
    expect(html).toContain(usageOverview.organizationName)
    expect(html).toContain('600')
    expect(html).toContain('25')
    expect(html).not.toMatch(/billing|plan/i)
    expect(html).toContain('href="/console/platform/quotas?tenantId=org_1"')
  })

  it('adds the billing status column when usage billing is enabled', () => {
    apiMocks.queries.set(
      '/v1/platform/billing/config',
      queryState({ enabled: true, portal: false, metering: true }),
    )
    apiMocks.lists.set(
      '/v1/platform/usage',
      listState([{ ...usageOverview, billingStatus: 'overdue' }]),
    )

    const html = renderToStaticMarkup(<PlatformUsage />)

    expect(html).toContain('Usage and billing')
    expect(html).toContain('Billing status')
    expect(html).toContain('overdue')
  })

  it('edits the fallback language from supported locales and keeps data residency read-only', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<PlatformSettingsPage />)
    })

    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(expect.anything(), '/v1/platform/settings')
    expect(container.textContent).toContain('Platform settings')
    const selects = [...container.querySelectorAll<HTMLSelectElement>('select')]
    expect(selects[0]?.value).toBe('en')
    expect([...(selects[0]?.options ?? [])].map((option) => option.value)).toContain('zh-Hans')
    expect(selects[1]?.value).toBe(settings.mfaPolicy)
    const readonlyValues = [...container.querySelectorAll<HTMLInputElement>('input[readonly]')].map(
      (input) => input.value,
    )
    expect(readonlyValues).toEqual([settings.name, settings.dataResidency])

    await act(async () => {
      root.unmount()
    })
  })
})
