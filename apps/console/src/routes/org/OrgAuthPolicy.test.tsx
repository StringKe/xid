import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AuthPolicyInsights, OrgAuthPolicyView } from './auth-queries'

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value, other }: { value: number; other: string }) => (
    <>{other.replace('#', String(value))}</>
  ),
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings[0] }),
}))

vi.mock('@xid-kit/web-ui/api-error-message', () => ({
  useManagementErrorMessage: () => (error: { code: string } | null | undefined) => error?.code,
}))

vi.mock('@xid-kit/web-ui/session', () => ({
  useAuth: () => ({ activeOrg: { id: 'org_1', name: 'Northwind Logistics' } }),
}))

vi.mock('@xid-kit/web-ui/tanstack-router', () => ({
  useSearchParams: () => [new URLSearchParams()],
  useLocation: () => ({ pathname: '/console/org/auth-policy', search: '', hash: '' }),
  useNavigate: () => vi.fn(),
}))

const method = {
  enabled: false,
  allowLogin: false,
  allowUserCreation: false,
  requireEmailVerification: true,
}

const policy: OrgAuthPolicyView = {
  hostedAuth: {
    identifierMode: 'email',
    requireVerifiedEmail: true,
    allowedEmailDomains: [],
    blockedEmailDomains: [],
    forceSso: false,
    allowUserCreation: true,
    allowExistingUserLogin: true,
    profileFields: {
      email: 'required',
      username: 'hidden',
      phone: 'hidden',
      name: 'hidden',
      givenName: 'hidden',
      familyName: 'hidden',
    },
    password: { ...method, enabled: true, allowLogin: true },
    magicLink: method,
    emailOtp: { ...method, enabled: true, allowLogin: true },
    whatsappOtp: method,
    smsOtp: method,
    passkey: { ...method, enabled: true, allowLogin: true },
    enterpriseSso: {
      enabled: false,
      allowLogin: false,
      allowJitUserCreation: false,
      domainDiscovery: false,
      allowedEmailDomains: [],
      blockedEmailDomains: [],
    },
  },
  loginPolicy: { forceSso: false, allowPasswordLogin: true },
  attestationRootsConfigured: false,
  sessionPolicy: { idleTimeoutMin: 4320, absoluteTimeoutDays: 14 },
  tokenPolicy: {
    accessTokenTtlSec: 3600,
    sessionTokenTtlSec: null,
    refreshIdleTimeoutDays: 30,
    refreshAbsoluteTimeoutDays: 7,
  },
  deliveryChannelReadiness: {
    whatsappOtp: { configured: false, channel: null },
    smsOtp: { configured: false, channel: null },
  },
  mfaPolicy: 'required',
  effectiveMfaPolicy: 'required',
}

const insights: AuthPolicyInsights = {
  passkeySignIns30d: 5804,
  passwordUserCount: 3140,
  usersWithoutSecondFactor: 1206,
  routedDomains: [],
}

let currentPolicy: OrgAuthPolicyView = policy

const idleMutation = () => ({ mutate: vi.fn(), isPending: false, error: null })

vi.mock('./auth-queries', () => ({
  useOrgAuthPolicyView: () => ({ data: currentPolicy, isLoading: false, isError: false }),
  useOrgAuthInsights: () => ({ data: insights }),
  useOrgSsoConnectionsView: () => ({ data: [] }),
  useSaveOrgAuthPolicy: () => idleMutation(),
  useTrustedRoots: () => ({ data: { configured: false, data: [] }, isLoading: false }),
  useReplaceTrustedRoots: () => idleMutation(),
  useRemoveTrustedRoots: () => idleMutation(),
}))

function directRadio(html: string): string {
  return html.match(/<input[^>]*value="direct"[^>]*>/)?.[0] ?? ''
}

import OrgAuthPolicyPage from './OrgAuthPolicy'

describe('OrgAuthPolicyPage', () => {
  it('renders each section with its own save button', () => {
    const html = renderToStaticMarkup(<OrgAuthPolicyPage />)

    expect(html).toContain('Sign-in &amp; MFA')
    for (const label of [
      'Save sign-in methods',
      'Save two-step verification',
      'Save sessions and tokens',
      'Save single sign-on',
      'Save attestation',
      'Save sign-up settings',
    ]) {
      expect(html).toContain(label)
    }
  })

  it('shows sign-in counts from the insights endpoint', () => {
    const html = renderToStaticMarkup(<OrgAuthPolicyPage />)

    expect(html).toContain('5804 people signed in with a passkey in the last 30 days.')
    expect(html).toContain('3140 people still use one.')
    expect(html).toContain('1206 people have not set one up yet.')
  })

  it('shows lifetimes in the units the fields use', () => {
    const html = renderToStaticMarkup(<OrgAuthPolicyPage />)

    expect(html).toContain('value="14"')
    expect(html).toContain('value="3"')
    expect(html).toContain('value="60"')
    expect(html).not.toContain('Session token TTL')
  })

  it('disables required attestation until trusted roots are configured', () => {
    currentPolicy = policy

    const html = renderToStaticMarkup(<OrgAuthPolicyPage />)

    expect(directRadio(html)).toContain('disabled')
    expect(html).toContain('Add trusted roots first.')
  })

  it('enables required attestation once trusted roots are configured', () => {
    currentPolicy = { ...policy, attestationRootsConfigured: true }

    const html = renderToStaticMarkup(<OrgAuthPolicyPage />)

    expect(directRadio(html)).not.toContain('disabled')
    currentPolicy = policy
  })

  it('warns when attestation is required but no trusted roots remain', () => {
    currentPolicy = { ...policy, hostedAuth: { ...policy.hostedAuth, attestationMode: 'direct' } }

    const html = renderToStaticMarkup(<OrgAuthPolicyPage />)

    expect(html).toContain('no one can register a passkey')
    currentPolicy = policy
  })

  it('shows single sign-on as required when only the organization policy column enforces it', () => {
    currentPolicy = { ...policy, loginPolicy: { forceSso: true, allowPasswordLogin: false } }

    const html = renderToStaticMarkup(<OrgAuthPolicyPage />)

    expect(html).toContain('Required, other sign-in methods are off')
    currentPolicy = policy
  })

  it('has a single password switch, under sign-in methods', () => {
    const html = renderToStaticMarkup(<OrgAuthPolicyPage />)

    expect(html).not.toContain('Allow password sign-in')
    expect(html).toContain('Passkeys, password, email code')
  })

  it('shows password as off when the organization policy disallows password sign-in', () => {
    currentPolicy = { ...policy, loginPolicy: { forceSso: false, allowPasswordLogin: false } }

    const html = renderToStaticMarkup(<OrgAuthPolicyPage />)

    expect(html).toContain('Passkeys, email code')
    expect(html).not.toContain('Passkeys, password')
    currentPolicy = policy
  })

  it('does not render social provider or delivery channel configuration', () => {
    const html = renderToStaticMarkup(<OrgAuthPolicyPage />)

    expect(html).not.toContain('GOOGLE_CLIENT_SECRET')
    expect(html).not.toContain('TWILIO_AUTH_TOKEN')
    expect(html).toContain('Set up SMS or WhatsApp in Messaging before turning this on.')
  })
})
