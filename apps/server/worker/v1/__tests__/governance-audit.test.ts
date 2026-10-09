// 组织审计日志:actor_id 与 q 过滤、带 * 的事件前缀、返回链位置与来源、valibot 失败路径。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerOrgAuditRoutes } from '../org-audit'
import {
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
import { seedAudit } from './governance-fixtures'

vi.mock('../../lib/management-access', () => ({
  requireVerifiedManagementMutation: async () => undefined,
}))

const BASE = 'https://acme.xid.dev/v1/organizations/t_a/audit-events'

type AuditPage = {
  data: {
    id: string
    seq: number
    prevHash: string
    source: string
    eventType: string
    actor: { kind: string; displayName: string | null }
    targetDisplay: string | null
    payload: Record<string, unknown>
  }[]
  total: number
}

async function setup() {
  const d1 = makeDb()
  await seedOrg(d1, { id: 't_a', name: 'Northwind Logistics' })
  await seedUser(d1, { id: 'user_dana', email: 'dana@northwind.com', firstName: 'Dana' })
  await seedUser(d1, { id: 'user_ravi', email: 'ravi@northwind.com', firstName: 'Ravi' })
  await seedMembership(d1, { id: 'mem_dana', userId: 'user_dana', orgId: 't_a', role: 'admin' })
  await tenantDb(d1).directories.insert({
    id: 'dir_okta',
    tenantId: 't_a',
    orgId: 't_a',
    provider: 'okta',
    scimTokenHash: 'hash',
  })
  const token = await seedApiKey(d1, { id: 'ak_fleet', scopes: ['audit_events:read'] })
  await seedAudit(d1, {
    seq: 1,
    eventType: 'user.mfa_reset',
    actorId: 'user_dana',
    actorIp: '203.0.113.24',
    targetType: 'user',
    targetId: 'user_ravi',
    meta: { factors_removed: ['totp'] },
    occurredAt: '2026-10-07T14:02:31.000Z',
  })
  await seedAudit(d1, {
    seq: 2,
    eventType: 'scim.user.deactivated',
    actorId: 'dir_okta',
    targetType: 'user',
    targetId: 'user_ravi',
    occurredAt: '2026-10-07T13:47:05.000Z',
  })
  await seedAudit(d1, {
    seq: 3,
    eventType: 'api_key.created',
    actorId: 'ak_fleet',
    actorIp: '198.51.100.7',
    targetType: 'api_key',
    targetId: 'ak_fleet',
    occurredAt: '2026-10-07T11:20:44.000Z',
  })
  await seedAudit(d1, {
    seq: 4,
    eventType: 'auth.login_succeeded',
    orgId: null,
    actorId: 'user_ravi',
    occurredAt: '2026-10-07T09:00:00.000Z',
  })
  const app = buildApp(registerOrgAuditRoutes)
  const withKey = (query: string) =>
    app.request(`${BASE}${query}`, { headers: { Authorization: `Bearer ${token}` } }, envOf(d1))
  const asAdmin = (query: string) =>
    buildApp(registerOrgAuditRoutes, { session: sessionFor('user_dana') }).request(
      `${BASE}${query}`,
      {},
      envOf(d1),
    )
  return { withKey, asAdmin }
}

describe('GET /v1/organizations/:id/audit-events filters', () => {
  let ctx: Awaited<ReturnType<typeof setup>>

  beforeEach(async () => {
    ctx = await setup()
  })

  it('returns chain position, source and display names for each entry', async () => {
    const body = await json<AuditPage>(await ctx.withKey('?event_type=user.*'))

    expect(body.total).toBe(1)
    expect(body.data[0]).toMatchObject({
      seq: 1,
      prevHash: 'prev_1',
      source: 'console',
      actor: { kind: 'user', displayName: 'Dana' },
      targetDisplay: 'Ravi',
      payload: { factors_removed: ['totp'] },
    })
  })

  it('derives SCIM, Management API and account sources from the actor', async () => {
    const body = await json<AuditPage>(await ctx.withKey(''))

    expect(body.data.map((row) => [row.eventType, row.source, row.actor.kind])).toEqual([
      ['user.mfa_reset', 'console', 'user'],
      ['scim.user.deactivated', 'scim', 'directory'],
      ['api_key.created', 'management_api', 'api_key'],
      ['auth.login_succeeded', 'account', 'user'],
    ])
  })

  it('filters by actor_id', async () => {
    const body = await json<AuditPage>(await ctx.withKey('?actor_id=dir_okta'))

    expect(body.data.map((row) => row.seq)).toEqual([2])
  })

  it.each([
    ['user_ravi', [1, 2]],
    ['198.51.100.7', [3]],
    ['user_r', []],
  ])('q=%s matches target id or IP address exactly', async (q, seqs) => {
    const body = await json<AuditPage>(await ctx.withKey(`?q=${encodeURIComponent(q)}`))

    expect(body.data.map((row) => row.seq)).toEqual(seqs)
    expect(body.total).toBe(seqs.length)
  })

  it('treats an event type without * as the same prefix match', async () => {
    const [starred, plain] = await Promise.all([
      json<AuditPage>(await ctx.withKey('?event_type=scim.*')),
      json<AuditPage>(await ctx.withKey('?event_type=scim.')),
    ])

    expect(starred.data.map((row) => row.seq)).toEqual([2])
    expect(plain.data.map((row) => row.seq)).toEqual([2])
  })

  it('hides tenant-wide sign-in events from an organization admin session', async () => {
    const body = await json<AuditPage>(await ctx.asAdmin(''))

    expect(body.data.map((row) => row.seq)).toEqual([1, 2, 3])
  })

  it.each([
    ['actor_id', 'user dana'],
    ['actor_id', 'x'.repeat(201)],
    ['q', 'x'.repeat(201)],
    ['q', '   '],
    ['event_type', 'user.**'],
    ['event_type', '*'],
  ])('rejects %s=%j with validation_failed', async (name, value) => {
    const response = await ctx.withKey(`?${name}=${encodeURIComponent(value)}`)

    expect(response.status).toBe(422)
    expect((await json<{ code: string }>(response)).code).toBe('validation_failed')
  })
})
