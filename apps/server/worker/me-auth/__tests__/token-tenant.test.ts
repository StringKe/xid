// token-tenant 单元测试:unresolved root 时从 JWT hint 解析 issuer 并切换租户。
import { Hono } from 'hono'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TenantVar, XidHonoEnv } from '../../lib/types'
import { resolveTokenTenant } from '../token-tenant'

const resolveTenantContextByIssuer = vi.hoisted(() => vi.fn())

vi.mock('@xid-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/db')>()
  return { ...actual, resolveTenantContextByIssuer }
})

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

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

function makeContext(tenant: TenantVar): Parameters<typeof resolveTokenTenant>[0] {
  const app = new Hono<XidHonoEnv>()
  let ctx!: Parameters<typeof resolveTokenTenant>[0]
  app.get('/probe', async (c) => {
    ctx = c
    return c.text('ok')
  })
  return {
    async getCtx() {
      await app.request('https://xid.dev/probe', {}, {} as Env)
      ctx.set('tenant', tenant)
      return ctx
    },
  }
}

describe('resolveTokenTenant', () => {
  beforeEach(() => {
    resolveTenantContextByIssuer.mockReset()
  })

  it('returns current tenant when root is already resolved', async () => {
    const tenant = resolvedTenant('tenant_a')
    const c = await makeContext(tenant).getCtx()
    const result = await resolveTokenTenant(
      c,
      fakeJwt({ iss: 'https://other.xid.dev' }),
      'invalid_token',
    )
    expect(result).toBe(tenant)
    expect(resolveTenantContextByIssuer).not.toHaveBeenCalled()
  })

  it('throws invalid_token when JWT lacks issuer hint on unresolved root', async () => {
    const c = await makeContext(unresolvedTenant()).getCtx()
    await expect(resolveTokenTenant(c, 'not-a-jwt', 'invalid_token')).rejects.toMatchObject({
      code: 'invalid_token',
    })
  })

  it('resolves tenant by issuer hint when root unresolved', async () => {
    const target = resolvedTenant('tenant_b')
    resolveTenantContextByIssuer.mockResolvedValue({
      ok: true,
      value: { tenant: target },
    })
    const c = await makeContext(unresolvedTenant()).getCtx()
    const token = fakeJwt({ iss: 'https://tenant_b.xid.dev', tenant_id: 'tenant_b' })
    const result = await resolveTokenTenant(c, token, 'invalid_token')
    expect(result.tenantId).toBe('tenant_b')
    expect(resolveTenantContextByIssuer).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      'https://tenant_b.xid.dev',
      { tenantId: 'tenant_b' },
    )
  })

  it('throws invalid_token when issuer resolution fails', async () => {
    resolveTenantContextByIssuer.mockResolvedValue({
      ok: false,
      error: { code: 'tenant_not_found', message: 'hidden', httpStatus: 404 },
    })
    const c = await makeContext(unresolvedTenant()).getCtx()
    const token = fakeJwt({ iss: 'https://missing.xid.dev' })
    await expect(resolveTokenTenant(c, token, 'invalid_token')).rejects.toMatchObject({
      code: 'invalid_token',
    })
  })
})
