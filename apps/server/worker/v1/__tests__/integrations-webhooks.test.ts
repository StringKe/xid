// /v1/webhooks 端点详情与投递记录:状态过滤、键集游标、近 7 天统计、创建者与轮换时间、不回传 payload 原文。
// 真实 sqlite + 迁移链,数据经 createTenantDb 写入。

import { describe, expect, it } from 'vitest'
import { registerWebhooks } from '../webhooks'
import {
  TENANT_A,
  buildApp,
  envOf,
  json,
  makeDb,
  seedApiKey,
  seedOrg,
  seedUser,
  tenantDb,
} from './console-fixtures'
import type { SqliteD1 } from '../../../../../packages/db/src/__tests__/sqlite-d1'

const BASE = 'https://acme.xid.dev/v1/webhooks'
const NOW = Date.now()
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

type Delivery = {
  id: string
  eventType: string
  status: string
  attemptCount: number
  maxAttempts: number
  responseStatus: number | null
  responseMs: number | null
  lastError: string | null
  nextRetryAt: string | null
  summary: { userName: string | null; organizationName: string | null }
}

type DeliveryPage = { data: Delivery[]; next_cursor: string | null; has_more: boolean }

async function seedWebhook(d1: SqliteD1, id: string, tenant = TENANT_A): Promise<void> {
  await tenantDb(d1, tenant).webhooks.insert({
    id,
    tenantId: tenant.tenantId,
    url: 'https://hooks.fleetplanner.app/xid/events',
    eventTypes: ['user.created'],
    signingSecretHash: 'v3:whsec_base64',
    status: 'active',
    createdAt: new Date(NOW - 30 * DAY),
  })
}

async function seedDelivery(
  d1: SqliteD1,
  input: {
    id: string
    webhookId: string
    status: string
    ageMs: number
    payload?: Record<string, unknown>
    lastError?: 'timeout' | 'network' | 'http' | null
  },
): Promise<void> {
  await tenantDb(d1).webhookDeliveries.insert({
    id: input.id,
    tenantId: TENANT_A.tenantId,
    webhookId: input.webhookId,
    eventType: 'user.updated',
    payload: input.payload ?? { type: 'user.updated', data: { userId: 'user_ravi' } },
    status: input.status,
    attemptCount: input.status === 'dead' ? 5 : 2,
    responseStatus: input.status === 'delivered' ? 200 : 503,
    responseMs: input.status === 'delivered' ? 182 : null,
    lastError: input.lastError ?? (input.status === 'delivered' ? null : 'http'),
    nextRetryAt: input.status === 'pending' ? new Date(NOW + 5 * MINUTE) : null,
    createdAt: new Date(NOW - input.ageMs),
  })
}

async function seedScenario() {
  const d1 = makeDb()
  await seedOrg(d1, { id: 't_a', name: 'Northwind Logistics' })
  await seedUser(d1, { id: 'user_ravi', firstName: 'Ravi' })
  await seedUser(d1, { id: 'user_dana', firstName: 'Dana' })
  const token = await seedApiKey(d1, { id: 'ak_ops', scopes: ['webhooks:read', 'webhooks:write'] })
  await seedWebhook(d1, 'wh_fleet')
  await seedWebhook(d1, 'wh_other')
  await seedDelivery(d1, {
    id: 'del_1',
    webhookId: 'wh_fleet',
    status: 'delivered',
    ageMs: 1 * MINUTE,
  })
  await seedDelivery(d1, {
    id: 'del_2',
    webhookId: 'wh_fleet',
    status: 'pending',
    ageMs: 2 * MINUTE,
  })
  await seedDelivery(d1, {
    id: 'del_3',
    webhookId: 'wh_fleet',
    status: 'dead',
    ageMs: 3 * MINUTE,
    lastError: 'timeout',
    payload: {
      type: 'organizationMembership.created',
      data: { userId: 'user_ravi', orgId: 't_a', email: 'ravi@northwind.com' },
    },
  })
  await seedDelivery(d1, {
    id: 'del_4',
    webhookId: 'wh_fleet',
    status: 'delivered',
    ageMs: 4 * MINUTE,
  })
  await seedDelivery(d1, { id: 'del_old', webhookId: 'wh_fleet', status: 'dead', ageMs: 9 * DAY })
  await seedDelivery(d1, { id: 'del_x', webhookId: 'wh_other', status: 'delivered', ageMs: MINUTE })
  const app = buildApp(registerWebhooks)
  const env = envOf(d1)
  const get = (path: string) =>
    app.request(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } }, env)
  return { d1, app, env, token, get }
}

describe('GET /v1/webhooks/:id/deliveries', () => {
  it('lists the endpoint deliveries newest first without exposing the payload', async () => {
    const { get } = await seedScenario()

    const res = await get('/wh_fleet/deliveries')
    const body = await json<DeliveryPage>(res)

    expect(res.status).toBe(200)
    expect(body.data.map((row) => row.id)).toEqual(['del_1', 'del_2', 'del_3', 'del_4', 'del_old'])
    expect(JSON.stringify(body)).not.toContain('ravi@northwind.com')
    expect(body.data[0]).not.toHaveProperty('payload')
  })

  it('maps queue states and resolves the subject display names', async () => {
    const { get } = await seedScenario()

    const body = await json<DeliveryPage>(await get('/wh_fleet/deliveries'))
    const [delivered, pending, failed] = body.data

    expect(delivered).toMatchObject({
      status: 'delivered',
      responseStatus: 200,
      responseMs: 182,
      lastError: null,
      nextRetryAt: null,
    })
    expect(pending).toMatchObject({
      status: 'pending',
      attemptCount: 2,
      maxAttempts: 5,
      lastError: 'http',
    })
    expect(pending?.nextRetryAt).not.toBeNull()
    expect(failed).toMatchObject({ status: 'failed', lastError: 'timeout', nextRetryAt: null })
    expect(failed?.summary).toEqual({
      userId: 'user_ravi',
      userName: 'Ravi',
      organizationId: 't_a',
      organizationName: 'Northwind Logistics',
    })
  })

  it('filters failed deliveries to the given-up ones only', async () => {
    const { get } = await seedScenario()

    const body = await json<DeliveryPage>(await get('/wh_fleet/deliveries?status=failed'))

    expect(body.data.map((row) => row.id)).toEqual(['del_3', 'del_old'])
  })

  it('filters pending deliveries', async () => {
    const { get } = await seedScenario()

    const body = await json<DeliveryPage>(await get('/wh_fleet/deliveries?status=pending'))

    expect(body.data.map((row) => row.id)).toEqual(['del_2'])
  })

  it('walks every delivery once through the cursor', async () => {
    const { get } = await seedScenario()
    const seen: string[] = []

    let cursor: string | null = null
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2'
      const page: DeliveryPage = await json<DeliveryPage>(await get(`/wh_fleet/deliveries${query}`))
      seen.push(...page.data.map((row) => row.id))
      expect(page.data.length).toBeLessThanOrEqual(2)
      cursor = page.next_cursor
    } while (cursor)

    expect(seen).toEqual(['del_1', 'del_2', 'del_3', 'del_4', 'del_old'])
  })

  it('rejects an unknown status filter with validation_failed', async () => {
    const { get } = await seedScenario()

    const res = await get('/wh_fleet/deliveries?status=dead')

    expect(res.status).toBe(422)
    expect(await json(res)).toMatchObject({
      code: 'validation_failed',
      meta: { paramName: 'status' },
    })
  })

  it('rejects a malformed cursor with validation_failed', async () => {
    const { get } = await seedScenario()

    const res = await get(`/wh_fleet/deliveries?cursor=${btoa('not-a-cursor')}`)

    expect(res.status).toBe(422)
  })

  it('returns 404 for a deleted endpoint', async () => {
    const { d1, get } = await seedScenario()
    await tenantDb(d1).webhooks.update({ status: 'deleted' })

    const res = await get('/wh_fleet/deliveries')

    expect(res.status).toBe(404)
  })
})

describe('GET /v1/webhooks/:id detail', () => {
  it('counts the last 7 days of deliveries by outcome', async () => {
    const { get } = await seedScenario()

    const body = await json<{ stats7d: Record<string, number> }>(await get('/wh_fleet'))

    expect(body.stats7d).toEqual({ sent: 4, delivered: 2, failed: 1, pending: 1 })
  })

  it('reads the creator and the last secret rotation from the audit trail', async () => {
    const { d1, get } = await seedScenario()
    const db = tenantDb(d1)
    const audit = (seq: number, eventType: string, actorId: string, occurredAt: string) =>
      db.auditEvents.insert({
        seq,
        id: `aud_${seq}`,
        tenantId: TENANT_A.tenantId,
        eventType,
        actorId,
        targetType: 'webhook',
        targetId: 'wh_fleet',
        occurredAt,
        prevHash: '0'.repeat(64),
        hash: String(seq).padStart(64, '0'),
      })
    await audit(1, 'webhook.created', 'user_dana', '2026-03-03T10:00:00.000Z')
    await audit(2, 'webhook.secret_rotated', 'user_dana', '2026-09-01T10:00:00.000Z')
    await audit(3, 'webhook.secret_rotated', 'ak_ops', '2026-10-07T10:00:00.000Z')

    const body = await json<Record<string, unknown>>(await get('/wh_fleet'))

    expect(body['createdBy']).toEqual({ kind: 'user', id: 'user_dana', displayName: 'Dana' })
    expect(body['secretRotatedAt']).toBe('2026-10-07T10:00:00.000Z')
  })

  it('falls back to the creation time when the secret was never rotated', async () => {
    const { get } = await seedScenario()

    const body = await json<Record<string, unknown>>(await get('/wh_fleet'))

    expect(body['createdBy']).toBeNull()
    expect(body['secretRotatedAt']).toBe(new Date(NOW - 30 * DAY).toISOString())
  })
})

describe('PATCH /v1/webhooks/:id status', () => {
  it('disables an endpoint and keeps it in the list', async () => {
    const { app, env, token, get } = await seedScenario()

    const res = await app.request(
      `${BASE}/wh_fleet`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'disabled' }),
      },
      env,
    )
    const list = await json<{ data: { id: string; status: string }[] }>(await get(''))

    expect(res.status).toBe(200)
    expect(list.data.find((row) => row.id === 'wh_fleet')?.status).toBe('disabled')
  })

  it('rejects a status outside active and disabled', async () => {
    const { app, env, token } = await seedScenario()

    const res = await app.request(
      `${BASE}/wh_fleet`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'deleted' }),
      },
      env,
    )

    expect(res.status).toBe(422)
  })
})
