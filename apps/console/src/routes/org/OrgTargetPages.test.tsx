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
    data: { data: [], next_cursor: null },
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
import OrgRoles from './OrgRoles'
import OrgScim from './OrgScim'
import OrgOutboundSso from './OrgOutboundSso'
import OrgScimTargets from './OrgScimTargets'
import OrgSso from './OrgSso'
import OrgWebhooks from './OrgWebhooks'

describe('org target pages', () => {
  it.each([
    ['overview', <OrgOverview />],
    ['members', <OrgMembers />],
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
})
