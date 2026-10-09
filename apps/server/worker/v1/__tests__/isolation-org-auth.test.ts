// 认证设置页新增与扩展路由的跨租户、跨组织隔离:另一租户的 API key 或会话访问本租户资源一律 404,
// 同租户其他组织的管理员拿不到别的组织的统计与活动。

import { describe, expect, it, vi } from 'vitest'
import { registerOrganizationsRoutes } from '../organizations'
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

vi.mock('../../lib/management-access', () => ({
  requireVerifiedManagementMutation: async () => undefined,
}))

const BASE = 'https://acme.xid.dev/v1/organizations'

const ROUTES = [
  { method: 'GET', path: 'auth-policy/insights' },
  { method: 'GET', path: 'auth-policy' },
  { method: 'PATCH', path: 'auth-policy', body: { mfaPolicy: 'required' } },
  { method: 'GET', path: 'social-providers' },
  { method: 'GET', path: 'delivery-channels' },
  { method: 'GET', path: 'sso-connections' },
  { method: 'GET', path: 'sso-connections/conn_a/activity' },
  { method: 'GET', path: 'outbound-saml-apps' },
  { method: 'GET', path: 'outbound-saml-apps/sap_a/activity' },
] as const

async function seedTwoTenants() {
  const d1 = makeDb()
  await seedOrg(d1, { id: 't_a' })
  await seedOrg(d1, { id: 'org_sibling' })
  await seedOrg(d1, { id: 't_b', tenant: TENANT_B })
  await seedUser(d1, { id: 'user_a', email: 'a@acme.example' })
  await seedUser(d1, { id: 'user_sibling', email: 's@acme.example' })
  await seedUser(d1, { id: 'user_b', tenant: TENANT_B, email: 'b@beta.example' })
  await seedMembership(d1, { id: 'mem_a', userId: 'user_a', orgId: 't_a', role: 'owner' })
  await seedMembership(d1, {
    id: 'mem_sibling',
    userId: 'user_sibling',
    orgId: 'org_sibling',
    role: 'owner',
  })
  await seedMembership(d1, {
    id: 'mem_b',
    userId: 'user_b',
    orgId: 't_b',
    role: 'owner',
    tenant: TENANT_B,
  })
  const db = tenantDb(d1)
  await db.forOrg('t_a').ssoConnections.insert({
    id: 'conn_a',
    tenantId: 't_a',
    orgId: 't_a',
    protocol: 'saml',
  })
  await db.samlServiceProviders.insert({
    id: 'sap_a',
    tenantId: 't_a',
    orgId: 't_a',
    spEntityId: 'https://sp.example',
    acsUrl: 'https://sp.example/acs',
  })
  return d1
}

function call(
  d1: ReturnType<typeof makeDb>,
  route: (typeof ROUTES)[number],
  options: { orgPath: string; tenant?: typeof TENANT_B; actor?: string; token?: string },
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`
  return buildApp(registerOrganizationsRoutes, {
    tenant: options.tenant,
    session: options.token ? null : sessionFor(options.actor ?? 'user_b'),
  }).request(
    `${BASE}/${options.orgPath}/${route.path}`,
    {
      method: route.method,
      headers,
      ...('body' in route ? { body: JSON.stringify(route.body) } : {}),
    },
    envOf(d1),
  )
}

describe('org auth routes cross-tenant isolation', () => {
  it.each(ROUTES)(
    '$method $path returns 404 for a tenant B session on a tenant A org',
    async (route) => {
      const d1 = await seedTwoTenants()

      const res = await call(d1, route, { orgPath: 't_a', tenant: TENANT_B, actor: 'user_b' })

      expect(res.status).toBe(404)
    },
  )

  it.each(ROUTES)(
    '$method $path returns 404 for a tenant B API key on a tenant A org',
    async (route) => {
      const d1 = await seedTwoTenants()
      const token = await seedApiKey(d1, { id: 'key_b', scopes: ['*'], tenant: TENANT_B })

      const res = await call(d1, route, { orgPath: 't_a', tenant: TENANT_B, token })

      expect(res.status).toBe(404)
      expect(await tenantDb(d1).forOrg('t_a').orgPolicies.findOne()).toBeUndefined()
    },
  )

  it.each(ROUTES)(
    '$method $path returns 403 for an admin of a sibling organization',
    async (route) => {
      const d1 = await seedTwoTenants()

      const res = await call(d1, route, { orgPath: 't_a', actor: 'user_sibling' })

      expect(res.status).toBe(403)
    },
  )

  it('returns 404 for connection activity requested through a sibling organization path', async () => {
    const d1 = await seedTwoTenants()

    const res = await call(
      d1,
      { method: 'GET', path: 'sso-connections/conn_a/activity' },
      { orgPath: 'org_sibling', actor: 'user_sibling' },
    )

    expect(res.status).toBe(404)
  })

  it('returns 404 for SAML app activity requested through a sibling organization path', async () => {
    const d1 = await seedTwoTenants()

    const res = await call(
      d1,
      { method: 'GET', path: 'outbound-saml-apps/sap_a/activity' },
      { orgPath: 'org_sibling', actor: 'user_sibling' },
    )

    expect(res.status).toBe(404)
  })
})
