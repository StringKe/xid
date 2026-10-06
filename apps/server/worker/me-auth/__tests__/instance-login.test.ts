// instance-login 单元测试:login hint 解析与 unresolved root 租户切换。
import { Hono } from 'hono'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TenantVar, XidHonoEnv } from '../../lib/types'
import {
  loginHintCandidates,
  resolveEntryTenant,
  resolveEntryTenants,
  withTenant,
} from '../instance-login'

const resolveInstanceLogin = vi.hoisted(() => vi.fn())
const resolveInstanceLoginCandidates = vi.hoisted(() => vi.fn())
const resolveTenantContextById = vi.hoisted(() => vi.fn())
const resolveInvitationTenant = vi.hoisted(() => vi.fn())

vi.mock('@xid-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/db')>()
  return {
    ...actual,
    resolveInstanceLogin,
    resolveInstanceLoginCandidates,
    resolveTenantContextById,
  }
})

vi.mock('../../auth/invitations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../auth/invitations')>()
  return {
    ...actual,
    resolveInvitationTenant,
  }
})

function unresolvedTenant(): TenantVar {
  return {
    tenantId: 'instance',
    issuer: 'https://xid.dev',
    rpId: 'xid.dev',
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: {},
    resolution: { unresolvedRoot: true },
  } as TenantVar
}

function resolvedTenant(tenantId: string): TenantVar {
  return {
    tenantId,
    issuer: `https://${tenantId}.xid.dev`,
    rpId: `${tenantId}.xid.dev`,
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: {},
  } as TenantVar
}

async function makeCtx(tenant: TenantVar) {
  const app = new Hono<XidHonoEnv>()
  let ctx!: Parameters<typeof resolveEntryTenant>[0]
  app.get('/probe', async (c) => {
    ctx = c
    return c.text('ok')
  })
  await app.request('https://xid.dev/probe', {}, {} as Env)
  ctx.set('tenant', tenant)
  return ctx
}

describe('loginHintCandidates', () => {
  it('classifies email hints', () => {
    expect(loginHintCandidates(' User@Acme.COM ')).toEqual([
      { kind: 'email', value: 'user@acme.com' },
    ])
  })

  it('classifies E.164 phone hints', () => {
    expect(loginHintCandidates('+14155552671')).toEqual([{ kind: 'phone', value: '+14155552671' }])
  })

  it('normalizes formatted phone hints to the same E.164 value', () => {
    expect(loginHintCandidates('+1 (415) 555-2671')).toEqual([
      { kind: 'phone', value: '+14155552671' },
    ])
  })

  it('returns username and external_id candidates for other identifiers', () => {
    expect(loginHintCandidates('AcmeUser')).toEqual([
      { kind: 'username', value: 'acmeuser' },
      { kind: 'external_id', value: 'AcmeUser' },
    ])
  })

  it('returns empty list for blank hint', () => {
    expect(loginHintCandidates('   ')).toEqual([])
  })
})

describe('resolveEntryTenant', () => {
  beforeEach(() => {
    resolveInstanceLogin.mockReset()
    resolveInstanceLoginCandidates.mockReset()
    resolveTenantContextById.mockReset()
    resolveInvitationTenant.mockReset()
  })

  it('returns current tenant when root already resolved', async () => {
    const tenant = resolvedTenant('tenant_a')
    const c = await makeCtx(tenant)
    const result = await resolveEntryTenant(c, { kind: 'email', value: 'user@example.com' })
    expect(result).toBe(tenant)
    expect(resolveInstanceLogin).not.toHaveBeenCalled()
  })

  it('lets a valid invitation override a different resolved cookie Tenant', async () => {
    const target = resolvedTenant('tenant_invited')
    resolveInvitationTenant.mockResolvedValue(target)
    const c = await makeCtx(resolvedTenant('tenant_cookie'))

    const result = await resolveEntryTenant(
      c,
      { kind: 'email', value: 'invitee@example.com' },
      null,
      { invitationToken: 'bound-invitation-token' },
    )

    expect(result).toBe(target)
    expect(resolveInvitationTenant).toHaveBeenCalledWith(c, 'bound-invitation-token')
    expect(resolveInstanceLogin).not.toHaveBeenCalled()
  })

  it('resolves explicit tenantId when provided on unresolved root', async () => {
    const target = resolvedTenant('tenant_pick')
    resolveTenantContextById.mockResolvedValue({ ok: true, value: { tenant: target } })
    const c = await makeCtx(unresolvedTenant())
    const result = await resolveEntryTenant(
      c,
      { kind: 'email', value: 'user@example.com' },
      'tenant_pick',
    )
    expect(result.tenantId).toBe('tenant_pick')
  })

  it('keeps explicit root sign-up in the default staging tenant before identifier resolution', async () => {
    const current = unresolvedTenant()
    const c = await makeCtx(current)
    const result = await resolveEntryTenant(
      c,
      { kind: 'email', value: 'existing@verified.example' },
      'tenant_existing',
      { intent: 'sign-up' },
    )
    expect(result).toBe(current)
    expect(resolveTenantContextById).not.toHaveBeenCalled()
    expect(resolveInstanceLogin).not.toHaveBeenCalled()
    expect(resolveInstanceLoginCandidates).not.toHaveBeenCalled()
  })

  it('throws cross_tenant_access_denied when explicit tenantId cannot be resolved', async () => {
    resolveTenantContextById.mockResolvedValue({
      ok: false,
      error: { code: 'tenant_not_found', message: 'hidden', httpStatus: 404 },
    })
    const c = await makeCtx(unresolvedTenant())
    await expect(
      resolveEntryTenant(c, { kind: 'email', value: 'user@example.com' }, 'missing'),
    ).rejects.toMatchObject({ code: 'cross_tenant_access_denied' })
  })

  it('throws organization_selection_required without English copy when instance login is ambiguous', async () => {
    const current = unresolvedTenant()
    resolveInstanceLogin.mockResolvedValue({
      ok: true,
      value: { status: 'ambiguous', matches: [] },
    })
    const c = await makeCtx(current)
    const failure = resolveEntryTenant(c, { kind: 'email', value: 'user@shared.com' })
    await expect(failure).rejects.toMatchObject({ code: 'organization_selection_required' })
    await expect(failure).rejects.not.toHaveProperty('longMessage', expect.any(String))
  })

  it('resolveEntryTenants returns every matching organization for always-200 send endpoints', async () => {
    resolveInstanceLogin.mockResolvedValue({
      ok: true,
      value: {
        status: 'ambiguous',
        matches: [{ tenantId: 'tenant_a' }, { tenantId: 'tenant_b' }],
      },
    })
    resolveTenantContextById.mockImplementation(async (_req: Request, _env: Env, id: string) => ({
      ok: true,
      value: { tenant: resolvedTenant(id) },
    }))
    const c = await makeCtx(unresolvedTenant())

    const tenants = await resolveEntryTenants(c, { kind: 'email', value: 'user@shared.com' })

    expect(tenants.map((tenant) => tenant.tenantId)).toEqual(['tenant_a', 'tenant_b'])
  })

  it('session-derived root context keeps the cookie tenant for identifier-only requests', async () => {
    const cookieTenant = {
      ...resolvedTenant('tenant_cookie'),
      resolution: { kind: 'tenant', primaryDomain: 'xid.dev', sessionDerivedRoot: true },
    }
    const c = await makeCtx(cookieTenant as never)

    const result = await resolveEntryTenant(c, { kind: 'email', value: 'user@other.com' })

    expect(result).toBe(cookieTenant)
    expect(resolveInstanceLogin).not.toHaveBeenCalled()
  })

  it('session-derived root context still honors an explicit organization selection', async () => {
    const cookieTenant = {
      ...resolvedTenant('tenant_cookie'),
      resolution: { kind: 'tenant', primaryDomain: 'xid.dev', sessionDerivedRoot: true },
    }
    resolveTenantContextById.mockResolvedValue({
      ok: true,
      value: { tenant: resolvedTenant('tenant_selected') },
    })
    const c = await makeCtx(cookieTenant as never)

    const result = await resolveEntryTenant(
      c,
      { kind: 'email', value: 'user@acme.com' },
      'tenant_selected',
    )

    expect(result.tenantId).toBe('tenant_selected')
  })

  it('returns resolved tenant from instance login on success', async () => {
    const target = resolvedTenant('tenant_found')
    resolveInstanceLogin.mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: target },
    })
    const c = await makeCtx(unresolvedTenant())
    const result = await resolveEntryTenant(c, { kind: 'email', value: 'user@acme.com' })
    expect(result.tenantId).toBe('tenant_found')
  })
})

describe('withTenant', () => {
  it('temporarily swaps tenant and restores previous context', async () => {
    const previous = resolvedTenant('tenant_a')
    const next = resolvedTenant('tenant_b')
    const c = await makeCtx(previous)
    const seen: string[] = []
    await withTenant(c, next, async () => {
      seen.push(c.get('tenant').tenantId)
    })
    expect(seen).toEqual(['tenant_b'])
    expect(c.get('tenant').tenantId).toBe('tenant_a')
  })
})
