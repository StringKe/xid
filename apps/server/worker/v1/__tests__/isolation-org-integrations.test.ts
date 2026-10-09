// 跨租户隔离:租户 A 的 API key 或管理员会话访问租户 B 的 webhook、投递记录、API key 与目录,一律 404 且不泄露存在性。

import { describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'
import type { XidHonoEnv } from '../../lib/types'
import { registerApiKeys } from '../api-keys'
import { registerOrganizationDirectoryRoutes } from '../organization-directories'
import { registerWebhooks } from '../webhooks'
import {
  TENANT_A,
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
  tenantDb,
} from './console-fixtures'

vi.mock('../../lib/management-access', () => ({
  requireVerifiedManagementMutation: async () => undefined,
}))

const HOST = 'https://acme.xid.dev'

async function seedTwoTenants() {
  const d1 = makeDb()
  await seedOrg(d1, { id: 't_a' })
  await seedOrg(d1, { id: 't_b', tenant: TENANT_B })
  await seedUser(d1, { id: 'user_dana', firstName: 'Dana' })
  await seedMembership(d1, { id: 'mem_dana', userId: 'user_dana', orgId: 't_a', role: 'admin' })
  const tokenA = await seedApiKey(d1, {
    id: 'ak_a',
    scopes: ['webhooks:read', 'webhooks:write', 'api_keys:read', 'directories:read'],
  })
  await seedApiKey(d1, { id: 'ak_b', tenant: TENANT_B, scopes: ['*'] })
  const dbB = tenantDb(d1, TENANT_B)
  await dbB.webhooks.insert({
    id: 'wh_victim',
    tenantId: 't_b',
    url: 'https://victim.example.com/hook',
    eventTypes: [],
    signingSecretHash: 'v3:whsec_base64',
    status: 'active',
  })
  await dbB.webhookDeliveries.insert({
    id: 'del_victim',
    tenantId: 't_b',
    webhookId: 'wh_victim',
    eventType: 'user.created',
    payload: { type: 'user.created', data: { userId: 'user_victim' } },
    status: 'dead',
  })
  await dbB.directories.insert({
    id: 'dir_victim',
    tenantId: 't_b',
    orgId: 't_b',
    provider: 'okta',
    scimTokenHash: 'hash',
  })
  return { d1, tokenA }
}

function asKey(app: Hono<XidHonoEnv>, env: Env, token: string, path: string) {
  return app.request(`${HOST}${path}`, { headers: { Authorization: `Bearer ${token}` } }, env)
}

describe('org-integrations cross-tenant isolation', () => {
  it('hides another tenant webhook deliveries from an API key', async () => {
    const { d1, tokenA } = await seedTwoTenants()
    const app = buildApp(registerWebhooks)

    const res = await asKey(app, envOf(d1), tokenA, '/v1/webhooks/wh_victim/deliveries')

    expect(res.status).toBe(404)
    expect(JSON.stringify(await json(res))).not.toContain('del_victim')
  })

  it('hides another tenant webhook deliveries from an organization admin session', async () => {
    const { d1 } = await seedTwoTenants()
    const app = buildApp(registerWebhooks, { session: sessionFor('user_dana'), tenant: TENANT_A })

    const res = await app.request(
      `${HOST}/v1/webhooks/wh_victim/deliveries?status=failed`,
      {},
      envOf(d1),
    )

    expect(res.status).toBe(404)
  })

  it('hides another tenant webhook detail and its statistics', async () => {
    const { d1, tokenA } = await seedTwoTenants()
    const app = buildApp(registerWebhooks)

    const res = await asKey(app, envOf(d1), tokenA, '/v1/webhooks/wh_victim')

    expect(res.status).toBe(404)
  })

  it('cannot disable another tenant webhook', async () => {
    const { d1, tokenA } = await seedTwoTenants()
    const app = buildApp(registerWebhooks)

    const res = await app.request(
      `${HOST}/v1/webhooks/wh_victim`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'disabled' }),
      },
      envOf(d1),
    )
    const victim = await tenantDb(d1, TENANT_B).webhooks.findOne()

    expect(res.status).toBe(404)
    expect(victim?.status).toBe('active')
  })

  it('lists only the caller tenant API keys with their creators', async () => {
    const { d1, tokenA } = await seedTwoTenants()
    const app = buildApp(registerApiKeys)

    const body = await json<{ data: { id: string }[] }>(
      await asKey(app, envOf(d1), tokenA, '/v1/api-keys'),
    )

    expect(body.data.map((row) => row.id)).toEqual(['ak_a'])
  })

  it('hides another tenant directory list behind the organization guard', async () => {
    const { d1, tokenA } = await seedTwoTenants()
    const app = buildApp((parent) => registerOrganizationDirectoryRoutes(parent))

    const res = await asKey(app, envOf(d1), tokenA, '/t_b/directories')

    expect(res.status).toBe(404)
    expect(JSON.stringify(await json(res))).not.toContain('dir_victim')
  })
})
