// protected-resource 单元测试:RFC9728 metadata 端点与 KV 缓存。
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { TenantVar, XidHonoEnv } from '../../lib/types'
import { registerProtectedResourceRoutes } from '../protected-resource'

function makeTenant(): TenantVar {
  return {
    tenantId: 'tenant_1',
    issuer: 'https://tenant_1.xid.dev',
    rpId: 'tenant_1.xid.dev',
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: {},
  } as TenantVar
}

function makeEnv(cached: unknown = null): Env {
  const put = vi.fn().mockResolvedValue(undefined)
  const get = vi.fn().mockResolvedValue(cached)
  return { CACHE: { get, put } } as unknown as Env
}

function buildApp(tenant: TenantVar): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.use('*', async (c, next) => {
    c.set('tenant', tenant)
    await next()
  })
  registerProtectedResourceRoutes(app)
  return app
}

describe('GET /.well-known/oauth-protected-resource', () => {
  it('returns metadata with cache-control and stores in KV on miss', async () => {
    const env = makeEnv(null)
    const res = await buildApp(makeTenant()).request(
      'https://tenant_1.xid.dev/.well-known/oauth-protected-resource',
      {},
      env,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
    const body = (await res.json()) as { resource: string }
    expect(body.resource).toBe('https://tenant_1.xid.dev')
    expect(env.CACHE.put).toHaveBeenCalled()
  })

  it('serves cached metadata without rebuilding', async () => {
    const cached = { resource: 'https://tenant_1.xid.dev', authorization_servers: [] }
    const env = makeEnv(cached)
    const res = await buildApp(makeTenant()).request(
      'https://tenant_1.xid.dev/.well-known/oauth-protected-resource',
      {},
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cached)
    expect(env.CACHE.put).not.toHaveBeenCalled()
  })
})
