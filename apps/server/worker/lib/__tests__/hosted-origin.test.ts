// hosted-origin 单元测试:租户 Hosted Auth base URL 解析优先级。
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { TenantVar, XidHonoEnv } from '../types'
import { hostedAuthOrigin, hostedAuthOriginForTenant } from '../hosted-origin'

describe('hostedAuthOriginForTenant', () => {
  it('prefers tenant.hostedAuthOrigin over request origin and issuer', () => {
    const tenant = {
      tenantId: 'tenant_1',
      issuer: 'https://xid.dev',
      hostedAuthOrigin: 'https://auth.tenant_1.xid.dev',
      rpId: 'tenant_1.xid.dev',
      signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
      policy: {},
    } as TenantVar
    expect(hostedAuthOriginForTenant(tenant, 'https://request.example')).toBe(
      'https://auth.tenant_1.xid.dev',
    )
  })

  it('falls back to request origin then issuer', () => {
    const tenant = {
      tenantId: 'tenant_1',
      issuer: 'https://tenant_1.xid.dev',
      rpId: 'tenant_1.xid.dev',
      signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
      policy: {},
    } as TenantVar
    expect(hostedAuthOriginForTenant(tenant, 'https://custom.host')).toBe('https://custom.host')
    expect(hostedAuthOriginForTenant(tenant)).toBe('https://tenant_1.xid.dev')
  })
})

describe('hostedAuthOrigin', () => {
  it('uses request URL origin when tenant has no hostedAuthOrigin', async () => {
    const app = new Hono<XidHonoEnv>()
    app.get('/probe', (c) => {
      c.set('tenant', {
        tenantId: 'tenant_1',
        issuer: 'https://tenant_1.xid.dev',
        rpId: 'tenant_1.xid.dev',
        signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
        policy: {},
      } as TenantVar)
      return c.json({ origin: hostedAuthOrigin(c) })
    })
    const res = await app.request('https://login.tenant_1.xid.dev/probe')
    expect(await res.json()).toEqual({ origin: 'https://login.tenant_1.xid.dev' })
  })
})
