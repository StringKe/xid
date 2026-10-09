import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { OrgSocialProvidersView, SocialProviderView } from './auth-queries'

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value, other }: { value: number; other: string }) => (
    <>{other.replace('#', String(value))}</>
  ),
  useLingui: () => ({
    t: (strings: TemplateStringsArray) => strings[0],
    i18n: {
      locale: 'en',
      number: (value: number) => String(value),
      date: (value: Date) => value.toISOString().slice(0, 10),
    },
  }),
}))

vi.mock('@xid-kit/web-ui/api-error-message', () => ({
  useManagementErrorMessage: () => (error: { code: string } | null | undefined) => error?.code,
}))

vi.mock('@xid-kit/web-ui/session', () => ({
  useAuth: () => ({ activeOrg: { id: 'org_1', name: 'Northwind' } }),
}))

const google: SocialProviderView = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  clientId: 'google-client',
  clientSecretRef: 'GOOGLE_CLIENT_SECRET',
  scopes: ['openid', 'email', 'profile'],
  usesPkce: true,
  enabled: true,
  allowLogin: true,
  allowUserCreation: true,
  requireVerifiedEmail: true,
  allowedEmailDomains: [],
  blockedEmailDomains: [],
  hasClientSecret: true,
  credentialsReady: true,
  signIns30d: 3402,
  disabledAt: null,
}

const providers: OrgSocialProvidersView = {
  socialProviders: {
    google,
    github: { ...google, enabled: false, signIns30d: 0, disabledAt: '2026-08-12T00:00:00.000Z' },
  },
}

vi.mock('./auth-queries', () => ({
  useOrgSocialProvidersView: () => ({ data: providers, isLoading: false, isError: false }),
}))

vi.mock('./queries', () => ({
  useUpdateOrgSocialProviders: () => ({
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null,
  }),
}))

import OrgSocialProvidersPage from './OrgSocialProviders'

describe('OrgSocialProvidersPage', () => {
  it('lists the built-in providers with status and 30-day usage', () => {
    const html = renderToStaticMarkup(<OrgSocialProvidersPage />)

    expect(html).toContain('Social login')
    for (const name of ['Google', 'Microsoft', 'GitHub', 'Apple']) expect(html).toContain(name)
    expect(html).toContain('3402')
    expect(html).toContain('Turned off 2026-08-12')
    expect(html).toContain('Not set up')
  })

  it('keeps provider configuration out of the list until a provider is opened', () => {
    const html = renderToStaticMarkup(<OrgSocialProvidersPage />)

    expect(html).toContain('Configure…')
    expect(html).toContain('Set up…')
    expect(html).not.toContain('GOOGLE_CLIENT_SECRET')
  })
})
