// org-governance 路由的跨租户与跨组织隔离:租户 A 的凭据访问租户 B 的组织返回 404,
// 组织 A 的管理员访问同租户的组织 B 返回 403,两种情况都不返回对方数据。

import { describe, expect, it, vi } from 'vitest'
import { registerOrgAuditRoutes } from '../org-audit'
import { registerOrgMembersRoutes } from '../org-members'
import {
  TENANT_B,
  buildApp,
  envOf,
  json,
  makeDb,
  seedApiKey,
  seedMembership,
  seedOrg,
  seedUser,
  sessionFor,
} from './console-fixtures'
import { seedAudit, seedDomain, seedInvitation } from './governance-fixtures'

vi.mock('../../lib/management-access', () => ({
  requireVerifiedManagementMutation: async () => undefined,
}))

const ROUTES = ['attention', 'sign-in-activity', 'setup-progress', 'audit-events'] as const

function register(app: Parameters<typeof registerOrgAuditRoutes>[0]): void {
  registerOrgMembersRoutes(app)
  registerOrgAuditRoutes(app)
}

async function setup() {
  const d1 = makeDb()
  await seedOrg(d1, { id: 't_a', name: 'Northwind Logistics' })
  await seedOrg(d1, { id: 'org_fin', name: 'Finance' })
  await seedOrg(d1, { id: 't_b', tenant: TENANT_B, name: 'Other Co' })
  await seedDomain(d1, { id: 'dom_b', orgId: 't_b', domain: 'other.example', tenant: TENANT_B })
  await seedInvitation(d1, {
    id: 'inv_b',
    orgId: 't_b',
    email: 'secret@other.example',
    status: 'expired',
    expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    tenant: TENANT_B,
  })
  await seedAudit(d1, {
    seq: 1,
    eventType: 'user.created',
    targetId: 'user_secret',
    occurredAt: new Date().toISOString(),
    tenant: TENANT_B,
  })
  await seedUser(d1, { id: 'user_fin_admin' })
  await seedMembership(d1, {
    id: 'mem_fin',
    userId: 'user_fin_admin',
    orgId: 'org_fin',
    role: 'admin',
  })
  const token = await seedApiKey(d1, { id: 'ak_a', scopes: ['*'] })
  return { d1, token }
}

describe('org-governance cross-tenant isolation', () => {
  it.each(ROUTES)('returns 404 for /%s on another tenant organization', async (route) => {
    const { d1, token } = await setup()
    const app = buildApp(register)

    const response = await app.request(
      `https://acme.xid.dev/v1/organizations/t_b/${route}`,
      { headers: { Authorization: `Bearer ${token}` } },
      envOf(d1),
    )

    expect(response.status).toBe(404)
    const text = await response.text()
    expect(text).not.toContain('other.example')
    expect(text).not.toContain('user_secret')
  })

  it.each(ROUTES)(
    'returns 403 for /%s when an admin of a sibling organization asks',
    async (route) => {
      const { d1 } = await setup()
      const app = buildApp(register, { session: sessionFor('user_fin_admin') })

      const response = await app.request(
        `https://acme.xid.dev/v1/organizations/t_a/${route}`,
        {},
        envOf(d1),
      )

      expect(response.status).toBe(403)
    },
  )

  it('keeps another tenant out of attention items and sign-in counts', async () => {
    const { d1, token } = await setup()
    await seedAudit(d1, {
      seq: 2,
      eventType: 'auth.login_succeeded',
      orgId: null,
      actorId: 'user_b',
      occurredAt: new Date().toISOString(),
      tenant: TENANT_B,
    })
    const app = buildApp(register)
    const get = (path: string) =>
      app.request(
        `https://acme.xid.dev/v1/organizations/t_a/${path}`,
        { headers: { Authorization: `Bearer ${token}` } },
        envOf(d1),
      )

    const [attention, activity] = await Promise.all([
      json<{ items: unknown[] }>(await get('attention')),
      json<{ metrics: { value: number }[] }>(await get('sign-in-activity')),
    ])

    expect(attention.items).toEqual([])
    expect(activity.metrics.map((metric) => metric.value)).toEqual([0, 0, 0])
  })
})
