import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { OrgSocialProviders } from './types'

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('@xid-kit/web-ui/session', () => ({
  useAuth: () => ({
    activeOrg: { id: 'org_1', name: 'Default' },
  }),
}))

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
  useSearchParams: () => [new URLSearchParams()],
}))

const providers: OrgSocialProviders = {
  socialProviders: {
    google: {
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      clientId: 'google-client',
      clientSecretRef: 'GOOGLE_CLIENT_SECRET',
      userInfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
      issuer: 'https://accounts.google.com',
      jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
      scopes: ['openid', 'email', 'profile'],
      usesPkce: true,
      enabled: true,
      allowLogin: true,
      allowUserCreation: true,
      requireVerifiedEmail: true,
      allowedEmailDomains: [],
      blockedEmailDomains: [],
      hasClientSecret: true,
      credentialsReady: false,
    },
  },
}

const updatePolicy = {
  error: null,
  isPending: false,
  mutateAsync: vi.fn(),
}

vi.mock('./queries', () => ({
  useOrgSocialProvidersQuery: () => ({
    data: providers,
    isLoading: false,
    isError: false,
  }),
  useUpdateOrgSocialProviders: () => updatePolicy,
}))

import OrgSocialProvidersPage from './OrgSocialProviders'

describe('OrgSocialProvidersPage', () => {
  it('renders social provider connection management separately from auth policy', () => {
    const html = renderToStaticMarkup(<OrgSocialProvidersPage />)

    expect(html).toContain('Social providers')
    expect(html).toContain('Provider connections')
    expect(html).toContain('Add google template')
    expect(html).toContain('Client secret binding')
    expect(html).toContain('Binding names are fixed by the deployment configuration')
    expect(html).toContain('GOOGLE_CLIENT_SECRET')
    expect(html).toContain('Save social providers')
  })
})
