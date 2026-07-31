// hosted-policy 单元测试:邮箱域/方法/社交/企业 SSO 策略门控 + 公开配置输出。
import { describe, it, expect } from 'vitest'
import type { HostedAuthPolicy, SocialProviderPolicy, TenantContext } from '@xid-kit/types'
import { DEFAULT_HOSTED_AUTH_POLICY } from '@xid-kit/types'
import {
  assertEmailAllowed,
  assertEnterpriseSsoAllowed,
  assertGuestAllowed,
  assertMethodAllowedWithCapabilities,
  assertMethodAvailableWithCapabilities,
  assertSocialProviderAllowed,
  assertTenantResolvedForWebAuthn,
  ambiguousHostedAuthConfig,
  emailDomain,
  hasSocialProviderCredentials,
  HostedAuthPolicyError,
  isHostedAuthPolicyError,
  publicHostedAuthConfig,
} from '../hosted-policy'

function makeTenant(
  policy: Partial<HostedAuthPolicy> = {},
  extra: Partial<TenantContext> = {},
): TenantContext {
  return {
    tenantId: 'tenant_test',
    issuer: 'https://test.xid.dev',
    rpId: 'test.xid.dev',
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: { hostedAuth: { ...DEFAULT_HOSTED_AUTH_POLICY, ...policy } },
    ...extra,
  }
}

function githubProvider(over: Partial<SocialProviderPolicy> = {}): SocialProviderPolicy {
  return {
    enabled: true,
    clientId: 'gh_client',
    clientSecretRef: 'GITHUB_SECRET',
    authorizationEndpoint: 'https://github.com/login/oauth/authorize',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    allowLogin: true,
    allowUserCreation: true,
    requireVerifiedEmail: false,
    allowedEmailDomains: [],
    blockedEmailDomains: [],
    ...over,
  }
}

describe('emailDomain', () => {
  it('extracts normalized domain from valid email', () => {
    expect(emailDomain('User@Example.COM')).toBe('example.com')
  })

  it('returns null for missing or malformed @ placement', () => {
    expect(emailDomain('not-an-email')).toBeNull()
    expect(emailDomain('@example.com')).toBeNull()
    expect(emailDomain('user@')).toBeNull()
  })
})

describe('assertEmailAllowed', () => {
  it('allows email when no domain restrictions', () => {
    expect(() => assertEmailAllowed(makeTenant(), 'user@acme.com')).not.toThrow()
  })

  it('denies blocked domain', () => {
    const tenant = makeTenant({ blockedEmailDomains: ['blocked.test'] })
    expect(() => assertEmailAllowed(tenant, 'user@blocked.test')).toThrow(
      expect.objectContaining({ policyReason: 'email_domain_blocked' }),
    )
  })

  it('denies email outside allowlist', () => {
    const tenant = makeTenant({ allowedEmailDomains: ['allowed.test'] })
    expect(() => assertEmailAllowed(tenant, 'user@other.test')).toThrow(
      expect.objectContaining({ policyReason: 'email_domain_not_allowed' }),
    )
  })

  it('denies invalid email shape', () => {
    expect(() => assertEmailAllowed(makeTenant(), 'bad-email')).toThrow(
      expect.objectContaining({ policyReason: 'invalid_email' }),
    )
  })
})

describe('assertMethodAllowedWithCapabilities', () => {
  it('denies when force_sso is enabled', () => {
    const tenant = makeTenant({ forceSso: true })
    expect(() => assertMethodAllowedWithCapabilities(tenant, 'magicLink', 'login')).toThrow(
      expect.objectContaining({ policyReason: 'force_sso' }),
    )
  })

  it('denies magic link when identifier mode is phone-only', () => {
    const tenant = makeTenant({ identifierMode: 'phone' })
    expect(() => assertMethodAllowedWithCapabilities(tenant, 'magicLink', 'login')).toThrow(
      expect.objectContaining({ policyReason: 'identifier_mode_not_allowed' }),
    )
  })

  it('denies when capability resolver reports method not configured', () => {
    const tenant = makeTenant()
    expect(() =>
      assertMethodAllowedWithCapabilities(tenant, 'magicLink', 'login', () => false),
    ).toThrow(expect.objectContaining({ policyReason: 'method_not_configured' }))
  })

  it('denies login when global login disabled', () => {
    const tenant = makeTenant({ allowExistingUserLogin: false })
    expect(() => assertMethodAllowedWithCapabilities(tenant, 'magicLink', 'login')).toThrow(
      expect.objectContaining({ policyReason: 'global_login_disabled' }),
    )
  })

  it('denies user creation when global creation disabled', () => {
    const tenant = makeTenant({ allowUserCreation: false })
    expect(() => assertMethodAllowedWithCapabilities(tenant, 'magicLink', 'user_creation')).toThrow(
      expect.objectContaining({ policyReason: 'global_user_creation_disabled' }),
    )
  })

  it('denies when method login disabled', () => {
    const tenant = makeTenant({
      magicLink: { enabled: true, allowLogin: false, allowUserCreation: true },
    })
    expect(() => assertMethodAllowedWithCapabilities(tenant, 'magicLink', 'login')).toThrow(
      expect.objectContaining({ policyReason: 'method_login_disabled' }),
    )
  })
})

describe('assertMethodAvailableWithCapabilities', () => {
  it('denies disabled method with no login or creation path', () => {
    const tenant = makeTenant({
      magicLink: { enabled: false, allowLogin: false, allowUserCreation: false },
    })
    expect(() => assertMethodAvailableWithCapabilities(tenant, 'magicLink')).toThrow(
      expect.objectContaining({ policyReason: 'method_disabled' }),
    )
  })
})

describe('assertGuestAllowed', () => {
  it('denies guest login and creation when force_sso is enabled', () => {
    const tenant = makeTenant({ forceSso: true })
    expect(() => assertGuestAllowed(tenant, 'login')).toThrow(
      expect.objectContaining({ policyReason: 'force_sso' }),
    )
    expect(() => assertGuestAllowed(tenant, 'user_creation')).toThrow(
      expect.objectContaining({ policyReason: 'force_sso' }),
    )
  })

  it('applies global login and user creation switches independently', () => {
    expect(() =>
      assertGuestAllowed(makeTenant({ allowExistingUserLogin: false }), 'login'),
    ).toThrow(expect.objectContaining({ policyReason: 'global_login_disabled' }))
    expect(() =>
      assertGuestAllowed(makeTenant({ allowUserCreation: false }), 'user_creation'),
    ).toThrow(expect.objectContaining({ policyReason: 'global_user_creation_disabled' }))
  })
})

describe('assertSocialProviderAllowed', () => {
  it('denies unconfigured provider', () => {
    const tenant = makeTenant({}, { policy: { hostedAuth: DEFAULT_HOSTED_AUTH_POLICY } })
    expect(() =>
      assertSocialProviderAllowed({
        tenant,
        provider: 'github',
        action: 'login',
        email: 'user@acme.com',
        emailVerified: true,
        hasSecret: () => true,
      }),
    ).toThrow(expect.objectContaining({ policyReason: 'provider_not_configured' }))
  })

  it('denies when provider requires verified email', () => {
    const tenant = makeTenant(
      {},
      { policy: { socialProviders: { github: githubProvider({ requireVerifiedEmail: true }) } } },
    )
    expect(() =>
      assertSocialProviderAllowed({
        tenant,
        provider: 'github',
        action: 'login',
        email: 'user@acme.com',
        emailVerified: false,
        hasSecret: () => true,
      }),
    ).toThrow(expect.objectContaining({ policyReason: 'provider_email_unverified' }))
  })

  it('denies provider-blocked email domain', () => {
    const tenant = makeTenant(
      {},
      {
        policy: {
          socialProviders: {
            github: githubProvider({ blockedEmailDomains: ['blocked.test'] }),
          },
        },
      },
    )
    expect(() =>
      assertSocialProviderAllowed({
        tenant,
        provider: 'github',
        action: 'login',
        email: 'user@blocked.test',
        emailVerified: true,
        hasSecret: () => true,
      }),
    ).toThrow(expect.objectContaining({ policyReason: 'provider_email_domain_blocked' }))
  })
})

describe('assertEnterpriseSsoAllowed', () => {
  it('allows logout without enterprise checks', () => {
    expect(() =>
      assertEnterpriseSsoAllowed({
        tenant: makeTenant(),
        action: 'logout',
        email: null,
      }),
    ).not.toThrow()
  })

  it('denies login when enterprise SSO disabled', () => {
    expect(() =>
      assertEnterpriseSsoAllowed({
        tenant: makeTenant(),
        action: 'login',
        email: 'user@acme.com',
      }),
    ).toThrow(expect.objectContaining({ policyReason: 'enterprise_sso_disabled' }))
  })

  it('denies JIT user creation when disabled', () => {
    const tenant = makeTenant({
      enterpriseSso: {
        enabled: true,
        allowLogin: true,
        allowJitUserCreation: false,
        domainDiscovery: false,
        allowedEmailDomains: [],
        blockedEmailDomains: [],
      },
    })
    expect(() =>
      assertEnterpriseSsoAllowed({
        tenant,
        action: 'user_creation',
        email: 'user@acme.com',
      }),
    ).toThrow(
      expect.objectContaining({ policyReason: 'enterprise_sso_jit_user_creation_disabled' }),
    )
  })
})

describe('assertTenantResolvedForWebAuthn', () => {
  it('denies unresolved instance root', () => {
    const tenant = makeTenant(
      {},
      {
        resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
      },
    )
    expect(() => assertTenantResolvedForWebAuthn(tenant)).toThrow(
      expect.objectContaining({ policyReason: 'instance_tenant_unresolved' }),
    )
  })
})

describe('hasSocialProviderCredentials', () => {
  it('accepts github without issuer/jwks', () => {
    expect(hasSocialProviderCredentials(githubProvider(), 'github', () => true)).toBe(true)
  })

  it('requires issuer and jwks for non-github providers', () => {
    const policy = githubProvider({ issuer: '', jwksUri: '' })
    expect(hasSocialProviderCredentials(policy, 'google', () => true)).toBe(false)
  })
})

describe('publicHostedAuthConfig', () => {
  it('omits SMS/WhatsApp when capability resolver returns false', () => {
    const config = publicHostedAuthConfig(
      makeTenant(),
      () => false,
      () => false,
    )
    expect(config.methods.smsOtp.enabled).toBe(false)
    expect(config.methods.whatsappOtp.enabled).toBe(false)
    expect(config.guest).toBeNull()
  })

  it('hides social providers when force_sso', () => {
    const tenant = makeTenant(
      { forceSso: true },
      {
        policy: {
          hostedAuth: { ...DEFAULT_HOSTED_AUTH_POLICY, forceSso: true },
          socialProviders: { github: githubProvider() },
        },
      },
    )
    const config = publicHostedAuthConfig(
      tenant,
      () => true,
      () => true,
    )
    expect(config.socialProviders).toHaveLength(0)
    expect(config.forceSso).toBe(true)
  })
})

describe('ambiguousHostedAuthConfig', () => {
  it('disables all methods and marks resolution ambiguous', () => {
    const config = ambiguousHostedAuthConfig({
      matchedBy: 'email',
      matches: [
        { tenantId: 'org_a', slug: 'a', name: 'A', issuer: 'https://xid.dev' },
        { tenantId: 'org_b', slug: 'b', name: 'B', issuer: 'https://xid.dev' },
      ],
    })
    expect(config.resolution.status).toBe('ambiguous')
    expect(config.methods.password.enabled).toBe(false)
    expect(config.socialProviders).toHaveLength(0)
    expect(config.guest).toBeNull()
  })
})

describe('HostedAuthPolicyError', () => {
  it('is discriminated by isHostedAuthPolicyError', () => {
    const err = new HostedAuthPolicyError('force_sso')
    expect(isHostedAuthPolicyError(err)).toBe(true)
    expect(isHostedAuthPolicyError(new Error('x'))).toBe(false)
  })
})
