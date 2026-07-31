// tenant 中间件单元测试:解析失败返回模糊 404,成功注入 tenant。
import { Hono } from 'hono'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TenantContext } from '@xid-kit/types'
import { sha256Hex } from '@xid-kit/crypto'
import type { XidHonoEnv } from '../../lib/types'
import { tenantMiddleware } from '../tenant'

const resolveTenantContext = vi.hoisted(() => vi.fn())
const resolveTenantContextByApplicationClientId = vi.hoisted(() => vi.fn())
const resolveTenantContextBySessionHash = vi.hoisted(() => vi.fn())

vi.mock('@xid-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/db')>()
  return {
    ...actual,
    resolveTenantContext,
    resolveTenantContextByApplicationClientId,
    resolveTenantContextBySessionHash,
  }
})

const TENANT: TenantContext = {
  tenantId: 'tenant_a',
  issuer: 'https://test.xid.dev',
  rpId: 'test.xid.dev',
  signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
  policy: {},
}

function buildApp(): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.use('*', tenantMiddleware)
  app.get('/probe', (c) => c.json({ tenantId: c.get('tenant').tenantId }))
  app.get('/authorize', (c) => c.json({ tenantId: c.get('tenant').tenantId }))
  return app
}

describe('tenantMiddleware', () => {
  beforeEach(() => {
    resolveTenantContext.mockReset()
    resolveTenantContextByApplicationClientId.mockReset()
    resolveTenantContextBySessionHash.mockReset()
  })

  it('returns opaque 404 when tenant resolution fails', async () => {
    resolveTenantContext.mockResolvedValue({
      ok: false,
      error: { code: 'tenant_not_found', message: 'hidden', httpStatus: 404 },
    })
    const res = await buildApp().request('https://unknown.xid.dev/probe', {}, {} as Env)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body).toEqual({ error: 'not_found' })
    expect(JSON.stringify(body)).not.toContain('tenant_not_found')
  })

  it('injects tenant and continues when resolution succeeds', async () => {
    resolveTenantContext.mockResolvedValue({ ok: true, value: TENANT })
    const res = await buildApp().request('https://test.xid.dev/probe', {}, {} as Env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tenantId: string }
    expect(body.tenantId).toBe('tenant_a')
  })

  it('root session tenant resolution is reused before default tenant resolution', async () => {
    resolveTenantContextBySessionHash.mockResolvedValue({
      ok: true,
      value: {
        status: 'resolved',
        tenant: TENANT,
        session: {
          id: 'session_1',
          tenantId: TENANT.tenantId,
          userId: 'user_1',
          refreshTokenHash: 'hash_1',
          activeOrgId: null,
          deviceFingerprintHash: null,
          deviceName: null,
          userAgent: null,
          ip: null,
          location: null,
          status: 'active',
          rememberMe: false,
          isImpersonation: false,
          impersonatorUserId: null,
          acr: null,
          amr: null,
          aal: null,
          authenticatedAt: new Date(),
          lastActiveAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          createdAt: new Date(),
        },
      },
    })
    const res = await buildApp().request(
      'https://xid.dev/probe',
      { headers: { cookie: '__Host-xid.rt.session_1=token_1' } },
      {} as Env,
    )
    expect(res.status).toBe(200)
    expect(resolveTenantContextBySessionHash).toHaveBeenCalledOnce()
    expect(resolveTenantContext).not.toHaveBeenCalled()
  })

  it('resolves the active-session pointer before earlier refresh cookies', async () => {
    resolveTenantContextBySessionHash.mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: TENANT },
    })
    const tokenBHash = await sha256Hex('token_b')

    const res = await buildApp().request(
      'https://xid.dev/probe',
      {
        headers: {
          cookie: [
            '__Host-xid.rt.aaaaaaaa=token_a',
            '__Host-xid.rt.bbbbbbbb=token_b',
            '__Host-xid.active=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          ].join('; '),
        },
      },
      {} as Env,
    )

    expect(res.status).toBe(200)
    expect(resolveTenantContextBySessionHash).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      tokenBHash,
    )
  })

  it('resolves a unique client_id before an unrelated browser session', async () => {
    const appTenant = { ...TENANT, tenantId: 'application_tenant' }
    resolveTenantContextByApplicationClientId.mockResolvedValue({
      ok: true,
      value: appTenant,
    })

    const res = await buildApp().request(
      'https://xid.dev/authorize?client_id=rp_client',
      { headers: { cookie: '__Host-xid.rt.session_1=token_1' } },
      {} as Env,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tenantId: 'application_tenant' })
    expect(resolveTenantContextByApplicationClientId).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      'rp_client',
    )
    expect(resolveTenantContextBySessionHash).not.toHaveBeenCalled()
  })

  it('duplicate client_id never falls through to an unrelated browser session', async () => {
    const hostTenant = { ...TENANT, tenantId: 'instance_entry' }
    resolveTenantContext.mockResolvedValue({ ok: true, value: hostTenant })

    const res = await buildApp().request(
      'https://xid.dev/authorize?client_id=rp_a&client_id=rp_b',
      { headers: { cookie: '__Host-xid.rt.session_1=token_1' } },
      {} as Env,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tenantId: 'instance_entry' })
    expect(resolveTenantContextByApplicationClientId).not.toHaveBeenCalled()
    expect(resolveTenantContextBySessionHash).not.toHaveBeenCalled()
  })
})
