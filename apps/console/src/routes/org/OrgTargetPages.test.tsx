import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { OAuthApplication, OrgBranding as OrgBrandingData } from './types'

const { listResult, mutation, authState } = vi.hoisted(() => {
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
    listResult: (rows: unknown[] = []) => ({
      data: { data: rows, next_cursor: null, has_more: false },
      isLoading: false,
      isError: false,
      error: null,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: () => Promise.resolve(),
    }),
    mutation: () => ({
      error: null,
      isPending: false,
      mutate: () => undefined,
      mutateAsync: () => Promise.resolve(),
    }),
  }
})

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    i18n: { _: (descriptor: { message?: string }) => descriptor.message ?? '' },
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
    user: {
      id: 'user_owner',
      email: 'owner@example.com',
      instanceManager: false,
    },
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
  useSearchParams: () => [new URLSearchParams('orgId=org_query&orgName=Untrusted%20Organization')],
}))

vi.mock('@xid-kit/web-ui/queries', () => ({
  useApiQuery: () => ({
    data: {
      dau: 0,
      mau: 0,
      loginSuccessRate: 1,
      mfaAdoptionRate: 0,
      activeMemberCount: 0,
      pendingInvitationCount: 0,
    },
    isLoading: false,
    isError: false,
  }),
  useApiInfiniteQuery: () => listResult(),
  useApiMutation: () => mutation(),
}))

const APPLICATIONS: OAuthApplication[] = [
  {
    id: 'app_confidential',
    client_id: 'client_confidential',
    client_type: 'confidential',
    token_endpoint_auth_method: 'client_secret_basic',
    redirect_uris: ['https://service.example.com/callback'],
    post_logout_redirect_uris: [],
    allowed_grant_types: ['authorization_code', 'refresh_token'],
    allowed_response_types: ['code'],
    allowed_scopes: ['openid', 'profile', 'email', 'offline_access'],
    require_pkce: true,
    dpop_bound_access_tokens: false,
    status: 'active',
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  },
  {
    id: 'app_public',
    client_id: 'client_public',
    client_type: 'public',
    token_endpoint_auth_method: 'none',
    redirect_uris: ['https://spa.example.com/callback'],
    post_logout_redirect_uris: [],
    allowed_grant_types: ['authorization_code'],
    allowed_response_types: ['code'],
    allowed_scopes: ['openid', 'profile', 'email'],
    require_pkce: true,
    dpop_bound_access_tokens: false,
    status: 'active',
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  },
]

vi.mock('./queries', () => ({
  useOrgMembersQuery: () => listResult(),
  useOrgInvitationsQuery: () => listResult(),
  useCreateOrgInvitation: mutation,
  useRevokeOrgInvitation: mutation,
  useRemoveOrgMember: mutation,
  useProjectsQuery: () => listResult(),
  useProjectRolesQuery: () => listResult(),
  useProjectPermissionsQuery: () => listResult(),
  useRolePermissionsQuery: () => listResult(),
  useProjectGrantsQuery: () => listResult(),
  useManagerAssignmentsQuery: () => listResult(),
  useCreateProject: mutation,
  useUpdateProject: mutation,
  useDeleteProject: mutation,
  useRestoreProject: mutation,
  useCreateProjectGrant: mutation,
  useRevokeProjectGrant: mutation,
  useCreateManagerAssignment: mutation,
  useDeleteManagerAssignment: mutation,
  useCreateProjectRole: mutation,
  useUpdateProjectRole: mutation,
  useDeleteProjectRole: mutation,
  useRestoreProjectRole: mutation,
  useCreateProjectPermission: mutation,
  useUpdateProjectPermission: mutation,
  useDeleteProjectPermission: mutation,
  useRestoreProjectPermission: mutation,
  useCreateRolePermission: mutation,
  useUpdateRolePermission: mutation,
  useDeleteRolePermission: mutation,
  useOrgSsoConnectionsQuery: () => ({ data: [], isLoading: false, isError: false }),
  useCreateSsoConnection: mutation,
  useUpdateSsoConnection: mutation,
  useDeleteSsoConnection: mutation,
  useOrgScimDirectoriesQuery: () => ({ data: [], isLoading: false, isError: false }),
  useCreateScimDirectory: mutation,
  useRotateScimToken: mutation,
  useDeleteScimDirectory: mutation,
  useOrgDomainsQuery: () => listResult(),
  useCreateOrgDomain: mutation,
  useOrgBrandingQuery: () => ({
    data: {
      primaryColor: null,
      backgroundColor: null,
      accentColor: null,
      fontFamily: null,
      borderRadius: null,
      logoUrl: null,
      logoDarkUrl: null,
    } satisfies OrgBrandingData,
    isLoading: false,
    isError: false,
  }),
  useUpdateOrgBranding: mutation,
  useApplicationsQuery: () => listResult(APPLICATIONS),
  useCreateApplication: mutation,
  useUpdateApplication: mutation,
  useDeleteApplication: mutation,
  useRotateClientSecret: mutation,
  useApiKeysQuery: () => listResult(),
  useCreateApiKey: mutation,
  useRevokeApiKey: mutation,
  useWebhooksQuery: () => listResult(),
  useCreateWebhook: mutation,
  useDeleteWebhook: mutation,
  useRotateWebhookSecret: mutation,
  useOrgScimTargetsQuery: () => ({ data: [], isLoading: false, isError: false }),
  useCreateScimTarget: mutation,
  useUpdateScimTarget: mutation,
  useDeleteScimTarget: mutation,
  useSyncScimTarget: mutation,
  useOrgOutboundSamlAppsQuery: () => ({ data: [], isLoading: false, isError: false }),
  useCreateOutboundSamlApp: mutation,
  useUpdateOutboundSamlApp: mutation,
  useDeleteOutboundSamlApp: mutation,
}))

import OrgApiKeys from './OrgApiKeys'
import OrgBranding from './OrgBranding'
import OrgDomains from './OrgDomains'
import OrgOverview from './OrgOverview'
import OrgRoles from './OrgRoles'
import OrgScim from './OrgScim'
import OrgOutboundSso, { parseCertificates } from './OrgOutboundSso'
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
    const html = renderToStaticMarkup(page)

    expect(html).not.toContain('No organization selected')
  })

  it('leads the overview with quick actions into the create flows', () => {
    const html = renderToStaticMarkup(<OrgOverview />)

    expect(html).toContain('Create application')
    expect(html).toContain('Invite member')
    expect(html).toContain('Create API key')
    expect(html).toContain('href="/console/org/applications?orgId=org_active"')
    expect(html).toContain('href="/console/org/members?orgId=org_active"')
    expect(html).toContain('href="/console/org/api-keys?orgId=org_active"')
  })

  it('hides tenant-wide quick actions and pages for a child organization', () => {
    authState.activeOrg.parentOrgId = 'org_parent'

    const overview = renderToStaticMarkup(<OrgOverview />)
    const apiKeys = renderToStaticMarkup(<OrgApiKeys />)
    authState.activeOrg.parentOrgId = null

    expect(overview).toContain('Invite member')
    expect(overview).not.toContain('Create API key')
    expect(apiKeys).toContain('Switch to the top-level')
  })

  it('shows webhook subscriptions from the emitted event catalog', () => {
    const html = renderToStaticMarkup(<OrgWebhooks />)

    expect(html).toContain('organizationInvitation.revoked')
    expect(html).not.toContain('session.revoked')
  })

  it('warns that a custom hostname requires passkey re-registration', () => {
    const html = renderToStaticMarkup(<OrgDomains />)

    expect(html).toContain('A custom hostname changes the WebAuthn RP ID')
    expect(html).toContain('Existing passkeys will not work on the new hostname')
    expect(html).toContain('users must register passkeys again')
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
