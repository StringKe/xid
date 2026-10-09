// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import type { PlatformAnnouncement, UsageOverview } from '@xid-kit/types'
import { ToastProvider } from '@xid-kit/web-ui/ui'
import type {
  AuditChainVerificationReport,
  PlatformAuditEventDetail,
  PlatformComplianceDocument,
  PlatformDeadLetter,
  PlatformDeadLetterPage,
  PlatformOverviewStats,
  PlatformStatusIncident,
} from './ops-queries'
import type {
  PlatformManagerAssignment,
  PlatformOrganizationListItem,
  PlatformOrganizationsPage,
  PlatformUserListItem,
} from './orgs-users-queries'
import type { InstanceSettings, PlatformSigningKey } from './settings-queries'

type QueryState = {
  data: unknown
  error: Error | null
  isError: boolean
  isLoading: boolean
  isFetching?: boolean
  isPlaceholderData?: boolean
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
  Plural: ({ value, other }: { value: number; other: ReactNode }) => (
    <>{typeof other === 'string' ? other.replace('#', String(value)) : other}</>
  ),
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce(
        (message, part, index) => `${message}${String(values[index - 1] ?? '')}${part}`,
      ),
    i18n: {
      _: (descriptor: { message?: string }) => descriptor.message ?? '',
      date: (value: Date, options: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat('en', options).format(value),
      number: (value: number, options?: Intl.NumberFormatOptions) =>
        new Intl.NumberFormat('en', options).format(value),
    },
  }),
}))

vi.mock('@lingui/core/macro', () => ({
  msg: (strings: TemplateStringsArray) => ({ message: strings[0] }),
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
  useManagementErrorMessage: () => (error: { code: string } | null) => `error:${error?.code}`,
}))

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  useSearchParams: () => [new URLSearchParams(''), () => undefined],
  useLocation: () => ({ pathname: '/console/platform', search: '', hash: '' }),
  useNavigate: () => () => undefined,
}))

vi.mock('@xid-kit/web-ui/session', () => ({
  useAuth: () => ({
    user: { id: 'user_1', email: 'admin@example.com', instanceManager: true },
    api: { post: vi.fn(), get: vi.fn() },
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

const NOW = '2026-07-27T00:00:00.000Z'

const stats: PlatformOverviewStats = {
  organizationCount: 12,
  totalUsers: 1234,
  dau: 120,
  mau: 600,
  loginSuccessRate: 0.975,
  activeOrgCount: 10,
  attention: [
    {
      kind: 'dead_letters',
      facts: { count: 3, byQueue: [{ queue: 'xid-webhook', count: 3 }], oldestFailedAt: NOW },
    },
  ],
  activity: [
    { key: 'dau', now: 120, previous: 100 },
    { key: 'mau', now: 600, previous: 550 },
    { key: 'login_success_rate', now: 0.975, previous: 0.96 },
    { key: 'organizations', now: 12, previous: 11 },
    { key: 'users', now: 1234, previous: 1200 },
  ],
  recentPlatformActivity: [
    {
      id: 'audit_platform_1',
      eventType: 'platform.organization.created',
      actorId: 'user_1',
      actorName: 'Platform Admin',
      targetType: 'organization',
      targetId: 'org_1',
      occurredAt: NOW,
    },
  ],
}

const organization: PlatformOrganizationListItem = {
  id: 'org_1',
  slug: 'acme',
  name: 'Acme Platform',
  status: 'active',
  userCount: 25,
  orgCount: 3,
  createdAt: NOW,
  canChangeStatus: true,
  primaryHost: 'acme.xid.example',
  mauThisMonth: 90,
  mauQuota: 100,
  statusChangedAt: null,
}

const defaultOrganization: PlatformOrganizationListItem = {
  ...organization,
  id: 'org_default',
  slug: 'default',
  name: 'Default Organization',
  canChangeStatus: false,
  mauQuota: null,
}

const organizationsPage: PlatformOrganizationsPage = {
  data: [organization, defaultOrganization],
  nextCursor: null,
  total: 2,
  counts: { total: 2, suspended: 0, deleted: 0 },
}

const globalUser: PlatformUserListItem = {
  id: 'user_1',
  email: 'admin@example.com',
  name: 'Platform Admin',
  organizations: [{ id: organization.id, slug: organization.slug, name: organization.name }],
  status: 'active',
  createdAt: NOW,
  lastSignInAt: NOW,
  tenantId: organization.id,
  organizationName: organization.name,
  organizationStatus: 'active',
}

const instanceManager: PlatformManagerAssignment = {
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
  createdAt: NOW,
  updatedAt: NOW,
  grantedBy: null,
  lastActiveAt: NOW,
}

const auditEvent: PlatformAuditEventDetail = {
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
  occurredAt: NOW,
  actorName: globalUser.name,
  details: {},
}

const auditVerification: AuditChainVerificationReport = {
  tenant_id: organization.id,
  verified_range: { from: 1, to: 42 },
  truncated: false,
  latest_seq: 42,
  chain_valid: true,
  broken_at_seq: null,
  failure_reason: null,
  record_count: 42,
  computed_at: NOW,
  mismatch: null,
  batch_count: 1,
  duration_ms: 12,
}

const deadLetter: PlatformDeadLetter = {
  id: 'dlq_1',
  sourceQueue: 'xid-webhook',
  deadLetterQueue: 'xid-webhook-dlq',
  messageId: 'message_1',
  tenantId: organization.id,
  orgId: organization.id,
  eventType: 'user.updated',
  errorCode: 'consumer_retries_exhausted',
  status: 'pending',
  replayable: true,
  attempts: 5,
  sourceEnqueuedAt: NOW,
  failedAt: NOW,
  replayRequestedAt: null,
  replayedAt: null,
  replayedBy: null,
  replayCount: 0,
  lastReplayErrorCode: null,
  organizationName: organization.name,
}

const deadLetterPage: PlatformDeadLetterPage = {
  data: [deadLetter],
  nextCursor: null,
  total: 1,
  countsByQueue: [{ queue: 'xid-webhook', count: 1 }],
}

const announcement: PlatformAnnouncement = {
  id: 'announcement_1',
  scopeType: 'global',
  scopeValue: null,
  title: 'Scheduled maintenance',
  body: 'The control plane will remain available.',
  severity: 'info',
  status: 'published',
  startsAt: NOW,
  endsAt: null,
  createdBy: globalUser.id,
  updatedBy: globalUser.id,
  createdAt: NOW,
  updatedAt: NOW,
}

const statusIncident: PlatformStatusIncident = {
  id: 'incident_1',
  title: 'Delayed webhooks',
  status: 'monitoring',
  impact: 'minor',
  summary: 'Webhook latency is returning to normal.',
  startedAt: NOW,
  resolvedAt: null,
  createdBy: globalUser.id,
  updatedBy: globalUser.id,
  createdAt: NOW,
  updatedAt: NOW,
  updates: [],
  components: ['webhooks'],
  lastUpdateAt: null,
}

const complianceDocument: PlatformComplianceDocument = {
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
  createdAt: NOW,
  updatedAt: NOW,
  artifactUrl: '/v1/platform/compliance-documents/compliance_1/artifact',
  sizeBytes: 2048,
  lastCheckedAt: null,
  lastCheckResult: null,
  registeredBy: globalUser.name,
}

const usageOverview: UsageOverview = {
  organizationId: organization.id,
  organizationName: organization.name,
  mau: 600,
  dau: 120,
  seatUsed: 25,
}

const settings: InstanceSettings = {
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
  turnstile: { status: 'misconfigured', siteKey: '0x4AAA' },
  emailSending: {
    provider: 'cloudflare_email_service',
    fromAddress: 'no-reply@xid.example',
    fromName: 'XID',
  },
  customDomains: { status: 'not_configured', cnameTarget: null },
  billingAdapter: { kind: 'off', status: 'not_configured' },
  orgsFollowingDefaults: { following: 2, total: 3 },
}

const nextKeyReadyAt = Date.parse(NOW) + 3_600_000

const signingKeys: { data: PlatformSigningKey[] } = {
  data: [
    {
      kid: 'kid_active',
      alg: 'ES256',
      status: 'active',
      createdAt: Date.parse(NOW) - 86_400_000,
      activatedAt: Date.parse(NOW) - 86_400_000,
      retireAfter: null,
      activatableAt: null,
    },
    {
      kid: 'kid_next',
      alg: 'ES256',
      status: 'next',
      createdAt: Date.parse(NOW),
      activatedAt: null,
      retireAfter: null,
      activatableAt: nextKeyReadyAt,
    },
  ],
}

function queryState(data: unknown): QueryState {
  return {
    data,
    error: null,
    isError: false,
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
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

function withProviders(page: ReactElement): ReactElement {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>{page}</ToastProvider>
    </QueryClientProvider>
  )
}

function render(page: ReactElement): string {
  return renderToStaticMarkup(withProviders(page))
}

async function mount(
  page: ReactElement,
): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => {
    root.render(withProviders(page))
  })
  return {
    container,
    unmount: () =>
      act(async () => {
        root.unmount()
      }),
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
    apiMocks.queries.set('/v1/platform/signing-keys', queryState(signingKeys))
    apiMocks.queries.set('/v1/platform/organizations', queryState(organizationsPage))
    apiMocks.queries.set(
      '/v1/platform/users',
      queryState({ data: [globalUser], nextCursor: null, total: 1 }),
    )
    apiMocks.queries.set(
      '/v1/platform/manager-assignments',
      queryState({ data: [instanceManager], nextCursor: null, total: 1 }),
    )
    apiMocks.queries.set('/v1/platform/dead-letters', queryState(deadLetterPage))
    apiMocks.lists.set('/v1/platform/organizations', listState([organization, defaultOrganization]))
    apiMocks.lists.set('/v1/platform/manager-assignments', listState([instanceManager]))
    apiMocks.lists.set('/v1/platform/audit-events', listState([auditEvent]))
    apiMocks.lists.set('/v1/platform/announcements', listState([announcement], true))
    apiMocks.lists.set('/v1/platform/status-incidents', listState([statusIncident], true))
    apiMocks.lists.set('/v1/platform/compliance-documents', listState([complianceDocument], true))
    apiMocks.lists.set('/v1/platform/usage', listState([usageOverview]))
    apiMocks.useApiQuery.mockImplementation(
      (_queryKey: readonly unknown[], path: string) =>
        apiMocks.queries.get(path) ?? {
          data: undefined,
          error: null,
          isError: false,
          isLoading: true,
          refetch: vi.fn(),
        },
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
      mutateAsync: vi.fn(() => Promise.resolve()),
      reset: vi.fn(),
      variables: undefined,
    })
  })

  it('leads the platform overview with what needs an instance manager', async () => {
    const { container, unmount } = await mount(<PlatformAdminOverview />)

    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(['platform', 'stats'], '/v1/platform/stats')
    expect(container.textContent).toContain('3 messages are waiting in dead letter queues.')
    expect(container.querySelector('a[href^="/console/platform/dead-letters"]')).not.toBeNull()
    expect(container.textContent).toContain('1,234')
    expect(container.textContent).toContain('97.5%')
    await unmount()
  })

  it('lists organizations by MAU against their observe-only quota', () => {
    const html = render(<PlatformOrganizations />)

    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/platform/organizations',
      expect.objectContaining({ query: expect.objectContaining({ sort: 'mau_desc' }) }),
    )
    expect(html).toContain('Acme Platform')
    expect(html).toContain('90% of 100')
    expect(html).toContain('Quotas never block sign-in.')
    expect(html).not.toMatch(/\bplan\b/i)
  })

  it('browses every user without requiring a search', () => {
    const html = render(<PlatformUsers />)

    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/platform/users',
      expect.objectContaining({ query: expect.objectContaining({ q: undefined }) }),
    )
    expect(html).toContain(globalUser.email)
    expect(html).toContain('Impersonation is read-only and lasts 15 minutes')
  })

  it('grants instance managers by organization and exact email', () => {
    const html = render(<PlatformInstanceManagers />)

    expect(html).toContain(globalUser.email)
    expect(html).toContain('Acme Platform (acme)')
    expect(html).toContain('Default organization (default)')
    expect(html).not.toContain('[object Object]')
    expect(html).toContain('It must match exactly')
  })

  it('reports an intact audit chain with the verified range', () => {
    const html = render(<PlatformAuditEvents />)

    expect(html).toContain('Intact')
    expect(html).toContain('Seq 1 to 42 verified.')
    expect(html).toContain(auditEvent.eventType)
  })

  it('reports a hash break with the expected and stored hashes', () => {
    apiMocks.queries.set(
      '/v1/platform/audit/verify',
      queryState({
        ...auditVerification,
        chain_valid: false,
        broken_at_seq: 17,
        failure_reason: 'audit_chain_broken',
        mismatch: { field: 'prev_hash', expected: 'expected_hash', stored: 'stored_hash' },
      }),
    )

    const html = render(<PlatformAuditEvents />)

    expect(html).toContain('Hash break')
    expect(html).toContain('expected_hash')
    expect(html).toContain('stored_hash')
    expect(html).not.toContain('Intact')
  })

  it('groups dead letters by source queue', () => {
    const html = render(<PlatformDeadLetters />)

    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/platform/dead-letters',
      expect.objectContaining({ query: expect.objectContaining({ status: 'open' }) }),
    )
    expect(html).toContain(deadLetter.sourceQueue)
    expect(html).toContain('Acme Platform')
    expect(html).toContain('Replay uses a 5-minute claim')
  })

  it.each([
    {
      name: 'announcements',
      path: '/v1/platform/announcements',
      content: announcement.title,
      button: 'Load more announcements',
      component: <PlatformAnnouncements />,
    },
    {
      name: 'status incidents',
      path: '/v1/platform/status-incidents',
      content: statusIncident.title,
      button: 'Load more incidents',
      component: <PlatformStatusIncidents />,
    },
    {
      name: 'compliance documents',
      path: '/v1/platform/compliance-documents',
      content: complianceDocument.title,
      button: 'Load more evidence',
      component: <PlatformCompliance />,
    },
  ])('appends the next page for $name', async ({ component, content, path, button }) => {
    const { container, unmount } = await mount(component)

    expect(container.textContent).toContain(content)
    expect(apiMocks.useApiInfiniteQuery).toHaveBeenCalledWith(expect.anything(), path, {
      query: { limit: 30 },
    })
    const loadMore = [...container.querySelectorAll('button')].find(
      (element) => element.textContent === button,
    )
    expect(loadMore).toBeDefined()

    await act(async () => {
      loadMore?.click()
    })

    expect(apiMocks.fetchNextPage).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('shows affected components and impact on the incident list', () => {
    const html = render(<PlatformStatusIncidents />)

    expect(html).toContain('Webhooks')
    expect(html).toContain('Degraded')
  })

  it('records the last download check for compliance evidence', () => {
    apiMocks.lists.set(
      '/v1/platform/compliance-documents',
      listState([{ ...complianceDocument, lastCheckedAt: NOW, lastCheckResult: 'mismatch' }]),
    )

    const html = render(<PlatformCompliance />)

    expect(html).toContain('2 KiB')
    expect(html).not.toContain('Not downloaded yet')
  })

  it('keeps signing key activation an explicit action and shows deployment state without secrets', () => {
    const html = render(<PlatformSettingsPage />)

    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(expect.anything(), '/v1/platform/settings')
    expect(apiMocks.useApiQuery).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/platform/signing-keys',
    )
    expect(html).toContain('kid_next')
    expect(html).toContain('Make active…')
    expect(html).toContain('Only one of the site key and secret is set')
    expect(html).toContain('2 of 3 follow these defaults.')
    expect(html).not.toMatch(/secret_key|whsec_|sk_live_/)
  })

  it('renders metered usage without any billing wording while billing is off', () => {
    apiMocks.queries.set(
      '/v1/platform/billing/config',
      queryState({ enabled: false, portal: false, metering: false }),
    )

    const html = render(<PlatformUsage />)

    expect(apiMocks.useApiInfiniteQuery).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/platform/usage',
      { query: { limit: 20 } },
    )
    expect(html).toContain('Usage overview')
    expect(html).toContain(usageOverview.organizationName)
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

    const html = render(<PlatformUsage />)

    expect(html).toContain('Usage and billing')
    expect(html).toContain('Billing status')
    expect(html).toContain('Overdue')
  })
})
