import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import type { CustomHostname } from './brand-queries'
import type { OrgAttention, SetupProgress, SignInActivity } from './overview-queries'

const { listResult, mutation, authState, apiData } = vi.hoisted(() => {
  const activeOrg = {
    id: 'org_active',
    slug: 'active',
    name: 'Active Organization',
    role: 'owner',
    permissions: [],
    parentOrgId: null as string | null,
    allowOrgSelfService: true,
    canManageOwners: true,
  }
  return {
    authState: { activeOrg },
    apiData: new Map<string, unknown>(),
    listResult: (rows: unknown[] = []) => ({
      data: { data: rows, next_cursor: null, has_more: false },
      isLoading: false,
      isError: false,
      error: null,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: () => Promise.resolve(),
      refetch: () => Promise.resolve(),
    }),
    mutation: () => ({
      error: null,
      isPending: false,
      mutate: () => undefined,
      mutateAsync: () => Promise.resolve(),
      reset: () => undefined,
    }),
  }
})

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value, other }: { value: number; other: string }) => (
    <>{other.replace('#', String(value))}</>
  ),
  useLingui: () => ({
    i18n: {
      _: (descriptor: { message?: string }) => descriptor.message ?? '',
      date: (value: Date) => value.toISOString(),
      number: (value: number) => String(value),
    },
    t: (strings: TemplateStringsArray) => strings[0],
  }),
}))

vi.mock('@lingui/core/macro', () => ({
  msg: (strings: TemplateStringsArray) => ({ message: strings[0] }),
}))

vi.mock('@xid-kit/web-ui/api-error-message', () => ({
  useManagementErrorMessage: () => (error: { code: string } | null | undefined) => error?.code,
  useApiErrorMessage: () => () => 'error',
  errorTargetsField: () => false,
}))

vi.mock('@xid-kit/web-ui/session', () => ({
  useAuth: () => ({
    user: { id: 'user_owner', email: 'owner@example.com', instanceManager: false },
    organizations: [authState.activeOrg],
    activeOrg: authState.activeOrg,
    managerAssignments: [],
  }),
}))

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useSearchParams: () => [
    new URLSearchParams('orgId=org_query&orgName=Untrusted%20Organization'),
    () => undefined,
  ],
  useLocation: () => ({ pathname: '/console/org', search: '', hash: '' }),
  useNavigate: () => () => undefined,
}))

vi.mock('@xid-kit/web-ui/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/web-ui/queries')>()
  return {
    ...actual,
    useApiQuery: (_key: unknown, path: string) => {
      const suffix = [...apiData.keys()].find((key) => path.endsWith(key))
      return suffix === undefined
        ? { data: undefined, isLoading: true, isError: false, refetch: () => Promise.resolve() }
        : {
            data: apiData.get(suffix),
            isLoading: false,
            isError: false,
            refetch: () => Promise.resolve(),
          }
    },
    useApiInfiniteQuery: () => listResult(),
    useApiMutation: () => mutation(),
  }
})

const ATTENTION: OrgAttention = {
  items: [
    {
      kind: 'domain_unverified',
      severity: 'warning',
      targetId: 'dom_1',
      facts: {
        domain: 'northwind.example',
        addedAt: '2026-01-02T00:00:00.000Z',
        lastCheckedAt: null,
        ssoConnectionName: null,
      },
    },
  ],
  checkedAt: '2026-01-10T00:00:00.000Z',
  nextCertificateExpiry: null,
}

const ACTIVE_SIGN_INS: SignInActivity = {
  period: { from: '2026-01-04', to: '2026-01-10' },
  previous: { from: '2025-12-04', to: '2025-12-10' },
  metrics: [
    { key: 'mau', value: 12, previousValue: 10, series: [8, 9, 10, 11, 12, 12, 12] },
    { key: 'sign_in_succeeded', value: 40, previousValue: 30, series: [5, 6, 5, 6, 6, 6, 6] },
    { key: 'sign_in_failed', value: 2, previousValue: 1, series: [0, 0, 1, 0, 1, 0, 0] },
  ],
}

const SETUP_DONE: SetupProgress = {
  domainVerified: true,
  signInDecided: true,
  membersInvited: true,
  pendingDomain: null,
}

const PENDING_HOSTNAME: CustomHostname = {
  id: 'ch_1',
  organization_id: 'org_active',
  hostname: 'auth.active.example',
  status: 'pending',
  hostname_status: 'pending',
  ssl_status: 'pending_validation',
  ownership_expires_at: null,
  activated_at: null,
  last_polled_at: null,
  requires_passkey_reregistration: true,
  affected_passkey_user_count: 3,
  dns_checks: { txt: 'pending', cname: 'pending' },
  dns_records: {
    ownership: null,
    dcv_delegation: [],
    certificate_validation: [],
    traffic: { type: 'CNAME', name: 'auth.active.example', value: 'active.xid.example' },
  },
  verification_errors: [],
}

function seedOverview(activity: SignInActivity, setup: SetupProgress): void {
  apiData.clear()
  apiData.set('/attention', ATTENTION)
  apiData.set('/sign-in-activity', activity)
  apiData.set('/setup-progress', setup)
}

function render(page: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{page}</QueryClientProvider>,
  )
}

import OrgApiKeys from './OrgApiKeys'
import OrgBranding from './OrgBranding'
import { OrgCustomHostnames } from './OrgCustomHostnames'
import OrgDomains from './OrgDomains'
import OrgOverview from './OrgOverview'
import OrgRoles from './OrgRoles'
import OrgScim from './OrgScim'
import OrgOutboundSso from './OrgOutboundSso'
import { parseCertificates } from './OutboundSamlAppForms'
import OrgScimTargets from './OrgScimTargets'
import OrgSso from './OrgSso'
import OrgWebhooks from './OrgWebhooks'

describe('org target pages', () => {
  it.each([
    ['overview', <OrgOverview />],
    ['roles', <OrgRoles />],
    ['domains', <OrgDomains />],
    ['branding', <OrgBranding />],
    ['scim', <OrgScim />],
    ['scim-targets', <OrgScimTargets />],
    ['outbound-sso', <OrgOutboundSso />],
    ['sso', <OrgSso />],
    ['api-keys', <OrgApiKeys />],
    ['webhooks', <OrgWebhooks />],
  ])('renders %s from activeOrg when query organization data differs', (_name, page) => {
    seedOverview(ACTIVE_SIGN_INS, SETUP_DONE)

    const html = render(page)

    expect(html).not.toContain('No organization selected')
    expect(html).not.toContain('org_query')
  })

  it('leads the overview with attention items linking to the page that fixes them', () => {
    seedOverview(ACTIVE_SIGN_INS, SETUP_DONE)

    const html = render(<OrgOverview />)

    expect(html).toContain('northwind.example')
    expect(html).toContain('href="/console/org/domains?orgId=org_active"')
  })

  it('shows the setup checklist for a new organization without sign-ins', () => {
    seedOverview(
      {
        ...ACTIVE_SIGN_INS,
        metrics: ACTIVE_SIGN_INS.metrics.map((metric) => ({
          ...metric,
          value: 0,
          previousValue: 0,
          series: metric.series.map(() => 0),
        })),
      },
      { ...SETUP_DONE, domainVerified: false },
    )

    const html = render(<OrgOverview />)

    expect(html).toContain('Set up ')
    expect(html).toContain('href="/console/org/domains?orgId=org_active"')
  })

  it('gates tenant-wide pages for a child organization', () => {
    seedOverview(ACTIVE_SIGN_INS, SETUP_DONE)
    authState.activeOrg.parentOrgId = 'org_parent'

    const apiKeys = render(<OrgApiKeys />)
    const webhooks = render(<OrgWebhooks />)
    authState.activeOrg.parentOrgId = null

    expect(apiKeys).toContain('Switch to the top-level')
    expect(webhooks).toContain('Switch to the top-level')
  })

  it('warns that moving sign-in to a custom hostname requires passkey re-registration', () => {
    apiData.clear()
    apiData.set('/branding', { signInHost: 'active.xid.example' })
    apiData.set('/custom-hostnames', { data: [PENDING_HOSTNAME], next_cursor: null })

    const html = render(<OrgCustomHostnames orgId="org_active" />)

    expect(html).toContain('Passkeys won&#x27;t carry over to auth.active.example')
    expect(html).toContain('3 people with passkeys for active.xid.example')
  })

  it('warns about passkeys before a sign-in domain is added', () => {
    apiData.clear()
    apiData.set('/custom-hostnames', { data: [], next_cursor: null })

    const html = render(<OrgCustomHostnames orgId="org_active" />)

    expect(html).toContain('People with passkeys will create')
  })

  it('suggests emitted webhook events on the first-run page', () => {
    seedOverview(ACTIVE_SIGN_INS, SETUP_DONE)

    const html = render(<OrgWebhooks />)

    expect(html).toContain('organizationMembership.created')
    expect(html).not.toContain('session.revoked')
  })

  it('normalizes PEM and blank-line-delimited base64 SAML certificates', () => {
    expect(
      parseCertificates(
        '-----BEGIN CERTIFICATE-----\nAAA BBB\n-----END CERTIFICATE-----\n' +
          '-----BEGIN CERTIFICATE-----\nCCC\nDDD\n-----END CERTIFICATE-----',
      ),
    ).toEqual(['AAABBB', 'CCCDDD'])
    expect(parseCertificates('AAA\nBBB\n\nCCC\nDDD')).toEqual(['AAABBB', 'CCCDDD'])
    expect(
      parseCertificates(
        '-----BEGIN CERTIFICATE-----\nAAA BBB\n-----END CERTIFICATE-----\n\nCCC\nDDD',
      ),
    ).toEqual(['AAABBB', 'CCCDDD'])
  })
})
