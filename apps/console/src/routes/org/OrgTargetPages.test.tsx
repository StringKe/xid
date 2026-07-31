import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type {
  CreatedScimDirectory,
  OrgBranding as OrgBrandingData,
  OrgDomain,
  OrgInvitation,
  OrgMember,
  OrgRole,
  RotateScimTokenResult,
  ScimDirectory,
  SsoConnection,
} from './types'

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

vi.mock('@xid-kit/web-ui/session', () => ({
  useAuth: () => ({
    user: {
      id: 'user_owner',
      email: 'owner@example.com',
    },
    organizations: [
      {
        id: 'org_active',
        slug: 'active',
        name: 'Active Organization',
        role: 'owner',
        permissions: [],
      },
    ],
    activeOrg: {
      id: 'org_active',
      slug: 'active',
      name: 'Active Organization',
      role: 'owner',
      permissions: [],
    },
  }),
}))

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
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
  useApiMutation: () => ({
    error: null,
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}))

vi.mock('./queries', () => ({
  useOrgMembersQuery: () => ({
    data: { data: [] as OrgMember[], nextCursor: null },
    isLoading: false,
    isError: false,
  }),
  useOrgInvitationsQuery: () => ({
    data: { data: [] as OrgInvitation[], nextCursor: null },
    isLoading: false,
    isError: false,
  }),
  useCreateOrgInvitation: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useRevokeOrgInvitation: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useRemoveOrgMember: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useOrgRolesQuery: () => ({
    data: [] as OrgRole[],
    isLoading: false,
    isError: false,
  }),
  useProjectsQuery: () => ({
    data: { data: [], next_cursor: null, has_more: false },
    isLoading: false,
    isError: false,
  }),
  useProjectRolesQuery: () => ({
    data: { data: [], next_cursor: null, has_more: false },
    isLoading: false,
    isError: false,
  }),
  useProjectPermissionsQuery: () => ({
    data: { data: [], next_cursor: null, has_more: false },
    isLoading: false,
    isError: false,
  }),
  useRolePermissionsQuery: () => ({
    data: { data: [], next_cursor: null, has_more: false },
    isLoading: false,
    isError: false,
  }),
  useProjectGrantsQuery: () => ({
    data: { data: [], next_cursor: null, has_more: false },
    isLoading: false,
    isError: false,
  }),
  useManagerAssignmentsQuery: () => ({
    data: { data: [], next_cursor: null, has_more: false },
    isLoading: false,
    isError: false,
  }),
  useCreateProject: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useUpdateProject: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useDeleteProject: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useRestoreProject: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useCreateProjectGrant: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useRevokeProjectGrant: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useCreateManagerAssignment: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useDeleteManagerAssignment: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useCreateProjectRole: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useUpdateProjectRole: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useDeleteProjectRole: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useRestoreProjectRole: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useCreateProjectPermission: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useUpdateProjectPermission: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useDeleteProjectPermission: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useRestoreProjectPermission: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useCreateRolePermission: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useUpdateRolePermission: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useDeleteRolePermission: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useOrgSsoConnectionsQuery: () => ({
    data: [] as SsoConnection[],
    isLoading: false,
    isError: false,
  }),
  useCreateSsoConnection: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useUpdateSsoConnection: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useDeleteSsoConnection: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useOrgScimDirectoriesQuery: () => ({
    data: [] as ScimDirectory[],
    isLoading: false,
    isError: false,
  }),
  useCreateScimDirectory: () => ({
    error: null,
    isPending: false,
    mutateAsync: vi.fn<() => Promise<CreatedScimDirectory>>(),
  }),
  useRotateScimToken: () => ({
    error: null,
    isPending: false,
    mutateAsync: vi.fn<() => Promise<RotateScimTokenResult>>(),
  }),
  useOrgDomainsQuery: () => ({
    data: [] as OrgDomain[],
    isLoading: false,
    isError: false,
  }),
  useOrgBrandingQuery: () => ({
    data: {
      primaryColor: null,
      backgroundColor: null,
      accentColor: null,
      fontFamily: null,
      borderRadius: null,
      logoUrl: null,
      logoDarkUrl: null,
    } satisfies Partial<OrgBrandingData>,
    isLoading: false,
    isError: false,
  }),
  useUpdateOrgBranding: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useApplicationsQuery: () => ({
    data: {
      data: [
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
      ],
      next_cursor: null,
      has_more: false,
    },
    isLoading: false,
    isError: false,
  }),
  useCreateApplication: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useDeleteApplication: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useRotateClientSecret: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useApiKeysQuery: () => ({
    data: { data: [], next_cursor: null },
    isLoading: false,
    isError: false,
  }),
  useCreateApiKey: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useRevokeApiKey: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useWebhooksQuery: () => ({
    data: { data: [], next_cursor: null },
    isLoading: false,
    isError: false,
  }),
  useCreateWebhook: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useDeleteWebhook: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useRotateWebhookSecret: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useOrgScimTargetsQuery: () => ({
    data: [],
    isLoading: false,
    isError: false,
  }),
  useCreateScimTarget: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useUpdateScimTarget: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useDeleteScimTarget: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useSyncScimTarget: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useOrgOutboundSamlAppsQuery: () => ({
    data: [],
    isLoading: false,
    isError: false,
  }),
  useCreateOutboundSamlApp: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useUpdateOutboundSamlApp: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
  useDeleteOutboundSamlApp: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
}))

import OrgApiKeys from './OrgApiKeys'
import OrgApplications from './OrgApplications'
import OrgBranding from './OrgBranding'
import OrgDomains from './OrgDomains'
import OrgMembers from './OrgMembers'
import OrgOverview from './OrgOverview'
import OrgProjects from './OrgProjects'
import OrgRoles from './OrgRoles'
import OrgScim from './OrgScim'
import OrgOutboundSso, { parseCertificates } from './OrgOutboundSso'
import OrgScimTargets from './OrgScimTargets'
import OrgSso from './OrgSso'
import OrgWebhooks from './OrgWebhooks'

describe('org target pages', () => {
  it.each([
    ['overview', <OrgOverview />],
    ['members', <OrgMembers />],
    ['projects', <OrgProjects />],
    ['roles', <OrgRoles />],
    ['domains', <OrgDomains />],
    ['branding', <OrgBranding />],
    ['scim', <OrgScim />],
    ['scim-targets', <OrgScimTargets />],
    ['outbound-sso', <OrgOutboundSso />],
    ['sso', <OrgSso />],
    ['applications', <OrgApplications />],
    ['api-keys', <OrgApiKeys />],
    ['webhooks', <OrgWebhooks />],
  ])('renders %s from activeOrg when query organization data differs', (_name, page) => {
    const html = renderToStaticMarkup(page)

    expect(html).not.toContain('No organization selected')
  })

  it('only offers canonical Organization Membership roles in the invitation form', () => {
    const html = renderToStaticMarkup(<OrgMembers />)

    expect(html).toContain('<option value="member"')
    expect(html).toContain('<option value="admin"')
    expect(html).not.toContain('<option value="viewer"')
  })

  it('warns that a custom hostname requires passkey re-registration', () => {
    const html = renderToStaticMarkup(<OrgDomains />)

    expect(html).toContain('A custom hostname changes the WebAuthn RP ID')
    expect(html).toContain('Existing passkeys will not work on the new hostname')
    expect(html).toContain('users must register passkeys again')
  })

  it('offers secret rotation only for applications that actually use a shared secret', () => {
    const html = renderToStaticMarkup(<OrgApplications />)

    expect(html.match(/Rotate secret/g)).toHaveLength(1)
    expect(html).toContain('client_public')
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
