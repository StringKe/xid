import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TenantVar, XidHonoEnv } from '../../lib/types'

const resolveInstanceLoginCandidates = vi.hoisted(() => vi.fn())
const resolveTenantContextById = vi.hoisted(() => vi.fn())
const resolveEntryTenant = vi.hoisted(() => vi.fn())
const createGuestEntryCapability = vi.hoisted(() => vi.fn(async () => 'guest-capability-token'))

vi.mock('@xid-kit/db', () => ({
  resolveInstanceLoginCandidates,
  resolveTenantContextById,
}))

vi.mock('../../me-auth/instance-login', () => ({
  loginHintCandidates: (loginHint: string) => [
    { kind: 'email', value: loginHint.trim().toLowerCase() },
  ],
  resolveEntryTenant,
}))

vi.mock('../hosted-policy', () => ({
  ambiguousHostedAuthConfig: vi.fn(() => ({ resolution: { status: 'ambiguous' } })),
  publicHostedAuthConfig: vi.fn((tenant: TenantVar) => {
    const hostedAuth = tenant.policy.hostedAuth
    return {
      tenantId: tenant.tenantId,
      resolution: { status: 'ready' },
      forceSso: hostedAuth?.forceSso ?? false,
      allowUserCreation: hostedAuth?.allowUserCreation ?? true,
      allowExistingUserLogin: hostedAuth?.allowExistingUserLogin ?? true,
      guest: null,
    }
  }),
}))

vi.mock('../delivery-channels', () => ({
  smsDeliveryReady: vi.fn(() => true),
  whatsappDeliveryReady: vi.fn(() => true),
}))

vi.mock('../social-providers', () => ({
  hasProviderSecret: vi.fn(() => true),
}))

vi.mock('../../me-auth/guest-entry-capability', () => ({
  createGuestEntryCapability,
  isRootGuestOnboardingTenant: (value: TenantVar) =>
    value.resolution?.kind === 'instance_entry' &&
    value.resolution.unresolvedRoot === true &&
    value.customHostname === undefined,
}))

import { registerHostedAuthConfigRoutes } from '../config'

function tenant(
  tenantId: string,
  unresolvedRoot = false,
  options: {
    customHostname?: string
    forceSso?: boolean
    allowUserCreation?: boolean
    allowExistingUserLogin?: boolean
  } = {},
): TenantVar {
  return {
    tenantId,
    issuer: 'https://xid.dev',
    rpId: unresolvedRoot ? 'xid.dev' : `${tenantId}.xid.dev`,
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: {
      hostedAuth: {
        identifierMode: 'email',
        requireVerifiedEmail: true,
        allowedEmailDomains: [],
        blockedEmailDomains: [],
        forceSso: options.forceSso ?? false,
        allowUserCreation: options.allowUserCreation ?? true,
        allowExistingUserLogin: options.allowExistingUserLogin ?? true,
        profileFields: {
          email: 'required',
          username: 'hidden',
          phone: 'hidden',
          name: 'hidden',
          givenName: 'hidden',
          familyName: 'hidden',
        },
        password: { enabled: false, allowLogin: false, allowUserCreation: false },
        magicLink: { enabled: true, allowLogin: true, allowUserCreation: true },
        emailOtp: { enabled: true, allowLogin: true, allowUserCreation: true },
        whatsappOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
        smsOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
        passkey: { enabled: false, allowLogin: false, allowUserCreation: false },
        enterpriseSso: {
          enabled: false,
          allowLogin: false,
          allowJitUserCreation: false,
          domainDiscovery: false,
          allowedEmailDomains: [],
          blockedEmailDomains: [],
        },
      },
    },
    ...(options.customHostname ? { customHostname: options.customHostname } : {}),
    ...(unresolvedRoot
      ? {
          resolution: {
            kind: 'instance_entry' as const,
            primaryDomain: 'xid.dev',
            unresolvedRoot: true,
          },
        }
      : {}),
  }
}

function appWithTenant(current: TenantVar): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.use('*', async (c, next) => {
    c.set('tenant', current)
    await next()
  })
  registerHostedAuthConfigRoutes(app)
  return app
}

describe('GET /auth/config flow resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createGuestEntryCapability.mockResolvedValue('guest-capability-token')
  })

  it.each([
    ['plain root entry', 'https://xid.dev/auth/config'],
    ['explicit sign-up', 'https://xid.dev/auth/config?intent=sign-up'],
  ])('issues a root staging guest capability for %s', async (_name, url) => {
    const root = tenant('default', true)
    resolveEntryTenant.mockResolvedValue(root)
    const app = appWithTenant(root)

    const res = await app.request(url, {}, {} as Env)

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toMatchObject({
      tenantId: 'default',
      guest: { capabilityToken: 'guest-capability-token' },
    })
    expect(createGuestEntryCapability).toHaveBeenCalledWith({
      env: expect.anything(),
      tenantId: 'default',
      origin: 'https://xid.dev',
    })
  })

  it.each([
    ['creation only', true, false],
    ['existing guest login only', false, true],
  ])(
    'issues a capability when root staging policy allows %s',
    async (_name, allowUserCreation, allowExistingUserLogin) => {
      const root = tenant('default', true, { allowUserCreation, allowExistingUserLogin })
      const app = appWithTenant(root)

      const res = await app.request('https://xid.dev/auth/config', {}, {} as Env)

      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        guest: { capabilityToken: 'guest-capability-token' },
      })
    },
  )

  it('keeps root sign-up on default staging before organization and candidate resolution', async () => {
    const root = tenant('default', true)
    resolveEntryTenant.mockResolvedValue(root)
    resolveInstanceLoginCandidates.mockResolvedValue({
      ok: true,
      value: { status: 'ambiguous', matches: [] },
    })
    const app = appWithTenant(root)

    const res = await app.request(
      'https://xid.dev/auth/config?login_hint=owner%40verified.example&organization_id=tenant-existing&intent=sign-up',
      {},
      {} as Env,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ tenantId: 'default', guest: null })
    expect(resolveTenantContextById).not.toHaveBeenCalled()
    expect(resolveInstanceLoginCandidates).not.toHaveBeenCalled()
    expect(resolveEntryTenant).toHaveBeenCalledWith(
      expect.anything(),
      [{ kind: 'email', value: 'owner@verified.example' }],
      'tenant-existing',
      { intent: 'sign-up', invitationToken: null, applicationClientId: null },
    )
  })

  it('passes invitation capability to resolver instead of running ambiguous discovery', async () => {
    const root = tenant('default', true)
    const invited = tenant('tenant-invite')
    resolveEntryTenant.mockResolvedValue(invited)
    const app = appWithTenant(root)

    const res = await app.request(
      'https://xid.dev/auth/config?login_hint=invitee%40example.com&intent=sign-up&invitation_token=tenant-bound-token',
      {},
      {} as Env,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ tenantId: 'tenant-invite', guest: null })
    expect(resolveTenantContextById).not.toHaveBeenCalled()
    expect(resolveInstanceLoginCandidates).not.toHaveBeenCalled()
    expect(resolveEntryTenant).toHaveBeenCalledWith(
      expect.anything(),
      [{ kind: 'email', value: 'invitee@example.com' }],
      undefined,
      {
        intent: 'sign-up',
        invitationToken: 'tenant-bound-token',
        applicationClientId: null,
      },
    )
  })

  it.each([
    ['authorization', '?authz_request_id=authz-1'],
    ['explicit non-onboarding intent', '?intent=sign-in'],
  ])('does not issue guest capability for %s flow', async (_name, query) => {
    const root = tenant('default', true)
    const app = appWithTenant(root)

    const res = await app.request(`https://xid.dev/auth/config${query}`, {}, {} as Env)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ guest: null })
    expect(createGuestEntryCapability).not.toHaveBeenCalled()
  })

  it('does not issue guest capability for an explicit organization selection', async () => {
    const root = tenant('default', true)
    const selected = tenant('tenant-selected')
    resolveTenantContextById.mockResolvedValue({ ok: true, value: { tenant: selected } })
    const app = appWithTenant(root)

    const res = await app.request(
      'https://xid.dev/auth/config?organization_id=tenant-selected',
      {},
      {} as Env,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ tenantId: 'tenant-selected', guest: null })
    expect(createGuestEntryCapability).not.toHaveBeenCalled()
  })

  it.each([
    ['tenant subdomain', tenant('tenant-ready')],
    [
      'custom hostname',
      tenant('tenant-ready', false, { customHostname: 'login.customer.example' }),
    ],
    ['force SSO root', tenant('default', true, { forceSso: true })],
    [
      'all guest actions disabled',
      tenant('default', true, {
        allowUserCreation: false,
        allowExistingUserLogin: false,
      }),
    ],
  ])('does not issue guest capability on %s', async (_name, current) => {
    const app = appWithTenant(current)

    const res = await app.request('https://xid.dev/auth/config', {}, {} as Env)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ guest: null })
    expect(createGuestEntryCapability).not.toHaveBeenCalled()
  })

  it('exposes the public site key only when Turnstile is fully configured', async () => {
    const app = appWithTenant(tenant('tenant-ready'))
    const res = await app.request('https://tenant-ready.xid.dev/auth/config', {}, {
      TURNSTILE_SITE_KEY: ' site-key ',
      TURNSTILE_SECRET: 'secret',
    } as Env)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ turnstileSiteKey: 'site-key' })
  })

  it('fails closed when the Turnstile site key and secret are incomplete', async () => {
    const app = appWithTenant(tenant('tenant-ready'))
    const res = await app.request('https://tenant-ready.xid.dev/auth/config', {}, {
      TURNSTILE_SECRET: 'secret',
    } as Env)

    expect(res.status).toBe(500)
  })
})
