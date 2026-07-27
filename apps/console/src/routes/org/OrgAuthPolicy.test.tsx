import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { OrgAuthPolicy } from './types'

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

const policy: OrgAuthPolicy = {
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
    password: {
      enabled: false,
      allowLogin: false,
      allowUserCreation: false,
      requireEmailVerification: true,
    },
    magicLink: {
      enabled: true,
      allowLogin: true,
      allowUserCreation: false,
      requireEmailVerification: true,
    },
    emailOtp: {
      enabled: true,
      allowLogin: true,
      allowUserCreation: false,
      requireEmailVerification: true,
    },
    whatsappOtp: {
      enabled: false,
      allowLogin: false,
      allowUserCreation: false,
      requireEmailVerification: true,
    },
    smsOtp: {
      enabled: false,
      allowLogin: false,
      allowUserCreation: false,
      requireEmailVerification: true,
    },
    passkey: {
      enabled: false,
      allowLogin: false,
      allowUserCreation: false,
      requireEmailVerification: true,
    },
    enterpriseSso: {
      enabled: false,
      allowLogin: false,
      allowJitUserCreation: false,
      domainDiscovery: false,
      allowedEmailDomains: [],
      blockedEmailDomains: [],
    },
  },
  sessionPolicy: {
    idleTimeoutMin: 60,
    absoluteTimeoutDays: null,
  },
  tokenPolicy: {
    accessTokenTtlSec: 300,
    sessionTokenTtlSec: null,
    refreshIdleTimeoutDays: null,
    refreshAbsoluteTimeoutDays: null,
  },
  deliveryChannelReadiness: {
    whatsappOtp: { configured: false, channel: null },
    smsOtp: { configured: false, channel: null },
  },
}

const updatePolicy = {
  error: null,
  isPending: false,
  mutateAsync: vi.fn(),
}

vi.mock('./queries', () => ({
  useOrgAuthPolicyQuery: () => ({
    data: policy,
    isLoading: false,
    isError: false,
  }),
  useUpdateOrgAuthPolicy: () => updatePolicy,
}))

import OrgAuthPolicyPage from './OrgAuthPolicy'

describe('OrgAuthPolicyPage', () => {
  it('does not render social provider connection management', () => {
    const html = renderToStaticMarkup(<OrgAuthPolicyPage />)

    expect(html).toContain('Authentication policy')
    expect(html).toContain('Methods')
    expect(html).toContain('Delivery channel is not configured')
    expect(html).not.toContain('Social providers')
    expect(html).not.toContain('Provider connections')
    expect(html).not.toContain('Provider configured')
    expect(html).not.toContain('Provider is not configured')
    expect(html).not.toContain('Add provider')
    expect(html).not.toContain('Client secret reference')
    expect(html).not.toContain('GOOGLE_CLIENT_SECRET')
  })

  it('renders session and token override fields', () => {
    const html = renderToStaticMarkup(<OrgAuthPolicyPage />)

    expect(html).toContain('Session idle timeout (minutes)')
    expect(html).toContain('Session absolute timeout (days)')
    expect(html).toContain('Access token TTL (seconds)')
    expect(html).toContain('Session token TTL (seconds)')
    expect(html).toContain('Refresh token idle timeout (days)')
    expect(html).toContain('Refresh token absolute timeout (days)')
    // 留空 = 继承 instance 默认(静态渲染不跑 useEffect,初始态即空值占位)。
    expect(html.match(/Inherit instance default/g)).toHaveLength(6)
  })
})
