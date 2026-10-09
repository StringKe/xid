// 跨租户:A 租户的 API key 与组织管理员会话访问 B 租户的品牌、域名与登录域名一律 404,不泄露存在性。

import { describe, expect, it, vi } from 'vitest'
import { registerCustomHostnameRoutes } from '../custom-hostnames'
import { registerOrgBrandingRoutes } from '../org-branding'
import { registerOrgDomainsRoutes } from '../org-domains'
import {
  TENANT_B,
  buildApp,
  envOf,
  makeDb,
  seedApiKey,
  seedMembership,
  seedOrg,
  seedUser,
  sessionFor,
  tenantDb,
} from './console-fixtures'
import { seedDomain } from './governance-fixtures'

function register(parent: Parameters<typeof registerOrgBrandingRoutes>[0]): void {
  registerOrgBrandingRoutes(parent)
  registerOrgDomainsRoutes(parent)
  registerCustomHostnameRoutes(parent)
}

async function setup() {
  const d1 = makeDb()
  await seedOrg(d1, { id: 't_a' })
  await seedOrg(d1, { id: 't_b', tenant: TENANT_B })
  await seedDomain(d1, { id: 'dom_b', orgId: 't_b', domain: 'beta.example', tenant: TENANT_B })
  await tenantDb(d1, TENANT_B).customHostnames.insert({
    id: 'ch_b',
    tenantId: 't_b',
    orgId: 't_b',
    instanceId: 'inst_1',
    hostname: 'auth.beta.example',
    cloudflareHostnameId: 'cf_b',
    trafficCnameTarget: 'customers.xid.dev',
  })
  const token = await seedApiKey(d1, { id: 'ak_a', scopes: ['*'] })
  await seedUser(d1, { id: 'u_admin', email: 'admin@acme.example' })
  await seedMembership(d1, { id: 'm_admin', userId: 'u_admin', orgId: 't_a', role: 'owner' })
  const env = {
    ...envOf(d1),
    CACHE: { get: vi.fn().mockResolvedValue(null), delete: vi.fn() },
    STORAGE: { put: vi.fn() },
  } as unknown as ReturnType<typeof envOf>
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ Answer: [] })))
  return { d1, env, token }
}

const CROSS_TENANT_REQUESTS: readonly [string, string, string?][] = [
  ['GET', '/t_b/branding'],
  ['PATCH', '/t_b/branding', JSON.stringify({ accentColor: '#8C6400' })],
  ['POST', '/t_b/branding/publish'],
  ['GET', '/t_b/domains'],
  ['POST', '/t_a/domains/dom_b/verify'],
  ['POST', '/t_b/domains/dom_b/verify'],
  ['GET', '/t_a/custom-hostnames/ch_b'],
  ['GET', '/t_b/custom-hostnames/ch_b'],
]

describe('org brand and domains cross-tenant isolation', () => {
  it.each(CROSS_TENANT_REQUESTS)(
    'API key of tenant A gets 404 for %s %s',
    async (method, path, body) => {
      const { env, token } = await setup()
      const app = buildApp(register)

      const res = await app.request(
        `https://acme.xid.dev/v1/organizations${path}`,
        {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body ? { body } : {}),
        },
        env,
      )

      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('beta.example')
    },
  )

  it.each(CROSS_TENANT_REQUESTS)(
    'owner session of tenant A gets 404 for %s %s',
    async (method, path, body) => {
      const { env } = await setup()
      const app = buildApp(register, { session: sessionFor('u_admin') })

      const res = await app.request(
        `https://acme.xid.dev/v1/organizations${path}`,
        { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body } : {}) },
        env,
      )

      expect(res.status).toBe(404)
    },
  )

  it('keeps tenant B data unchanged after the cross-tenant attempts', async () => {
    const { d1, env, token } = await setup()
    const app = buildApp(register)

    await app.request(
      'https://acme.xid.dev/v1/organizations/t_a/domains/dom_b/verify',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    const domain = (await tenantDb(d1, TENANT_B).organizationDomains.findMany())[0]!

    expect(domain.lastCheckedAt).toBeNull()
    expect(domain.verificationStatus).toBe('pending')
  })
})
