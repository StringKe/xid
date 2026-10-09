import { beforeEach, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { AUTH_LOGIN_FAILED_EVENT, AUTH_LOGIN_SUCCEEDED_EVENT } from '@xid-kit/types'
import {
  TENANT_A,
  buildApp,
  envOf,
  json,
  makeDb,
  seedOrg,
  seedUser,
  sessionFor,
} from '../../v1/__tests__/console-fixtures'
import type { FakeEnv } from '../../v1/__tests__/console-fixtures'
import type { XidHonoEnv } from '../../lib/types'
import { registerPublicStatusRoutes } from '../../public-status'
import { registerPlatformAuditEventsRoutes } from '../audit-events'
import { registerPlatformComplianceRoutes } from '../compliance'
import { registerPlatformStatsRoutes } from '../stats'
import { registerPlatformStatusIncidentRoutes } from '../status-incidents'

type SqliteDb = ReturnType<typeof makeDb>

const MANAGER = 'usr_manager'
const MEMBER = 'usr_member'
const HOUR_MS = 60 * 60 * 1000
const CHECKSUM_OF_HELLO = 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'

function register(app: Hono<XidHonoEnv>): void {
  registerPublicStatusRoutes(app)
  registerPlatformStatsRoutes(app)
  registerPlatformAuditEventsRoutes(app)
  registerPlatformStatusIncidentRoutes(app)
  registerPlatformComplianceRoutes(app)
}

function rows(d1: SqliteDb, sql: string): Record<string, unknown>[] {
  return d1.database.prepare(sql).all() as Record<string, unknown>[]
}

function exec(d1: SqliteDb, sql: string, ...params: Array<string | number | null>): void {
  d1.database.prepare(sql).run(...params)
}

function seedAudit(
  d1: SqliteDb,
  input: { seq: number; tenantId: string; eventType: string; actorId: string; occurredAt: string },
): void {
  exec(
    d1,
    `INSERT INTO audit_events (
       seq, id, tenant_id, event_type, actor_id, meta, occurred_at, prev_hash, hash
     ) VALUES (?, ?, ?, ?, ?, '{"access":"read_only"}', ?, 'p', 'h')`,
    input.seq,
    `aud_${input.tenantId}_${input.seq}`,
    input.tenantId,
    input.eventType,
    input.actorId,
    input.occurredAt,
  )
}

function storage(objects: Record<string, string>): R2Bucket {
  return {
    head: async (key: string) => (key in objects ? { size: objects[key]?.length ?? 0 } : null),
    get: async (key: string) => {
      const value = objects[key]
      if (value === undefined) return null
      const bytes = new TextEncoder().encode(value)
      return {
        size: bytes.byteLength,
        httpMetadata: { contentType: 'application/pdf' },
        arrayBuffer: async () => bytes.buffer,
      }
    },
  } as unknown as R2Bucket
}

describe('platform operations surfaces', () => {
  let d1: SqliteDb
  let env: FakeEnv
  let app: Hono<XidHonoEnv>

  function send(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    return app.request(
      `https://xid.dev${path}`,
      {
        method: init.method ?? 'GET',
        ...(init.body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
      },
      env,
    )
  }

  beforeEach(async () => {
    d1 = makeDb()
    env = envOf(d1)
    await seedOrg(d1, { id: TENANT_A.tenantId, name: 'Acme' })
    await seedUser(d1, { id: MANAGER, email: 'dana@example.com', firstName: 'Dana' })
    await seedUser(d1, { id: MEMBER, email: 'member@example.com' })
    exec(
      d1,
      `INSERT INTO manager_assignments (
         id, tenant_id, user_id, manager_role, scope_type, scope_id, created_at, updated_at
       ) VALUES ('ma_1', ?, ?, 'instance_manager', 'instance', NULL, 1000, 1000)`,
      TENANT_A.tenantId,
      MANAGER,
    )
    app = buildApp(register, { session: sessionFor(MANAGER) })
  })

  it('rejects every operations endpoint for a user without instance_manager', async () => {
    app = buildApp(register, { session: sessionFor(MEMBER) })
    const paths = [
      '/v1/platform/stats',
      '/v1/platform/audit-events',
      '/v1/platform/status-incidents',
      '/v1/platform/compliance-documents',
    ]

    const statuses = await Promise.all(paths.map(async (path) => (await send(path)).status))

    expect(statuses).toEqual([403, 403, 403, 403])
  })

  it('reports what needs an instance manager with facts only', async () => {
    const now = Date.now()
    exec(
      d1,
      `INSERT INTO queue_dead_letters (
         id, source_queue, dead_letter_queue, message_id, event_type, error_code, status,
         attempts, payload_iv, payload_ciphertext, payload_tag, payload_kek_version,
         source_enqueued_at, failed_at, replay_count, created_at, updated_at
       ) VALUES ('dlq_1', 'xid-webhook', 'xid-webhook-dlq', 'm1', 'user.updated',
                 'consumer_retries_exhausted', 'pending', 5, 'iv', 'ct', 'tag', 1, ?, ?, 0, ?, ?)`,
      now,
      now,
      now,
      now,
    )
    exec(
      d1,
      `INSERT INTO instance_signing_keys (
         id, instance_id, kid, alg, public_key_jwk, private_key_iv, private_key_ciphertext,
         private_key_tag, kek_version, status, created_at, updated_at
       ) VALUES ('isk_next', 'inst_1', 'kid-next', 'ES256', '{}', x'00', x'00', x'00', 1, 'next', ?, ?)`,
      now - 2 * HOUR_MS,
      now - 2 * HOUR_MS,
    )
    await seedOrg(d1, {
      id: 'org_blue',
      tenant: { ...TENANT_A, tenantId: 'org_blue' },
      name: 'Bluefin',
    })
    exec(d1, `UPDATE organizations SET status = 'suspended' WHERE id = 'org_blue'`)
    exec(
      d1,
      `INSERT INTO organization_quotas (tenant_id, quota_key, "limit", enforcement, created_at, updated_at)
       VALUES (?, 'mau', 100, 'observe', 1000, 1000)`,
      TENANT_A.tenantId,
    )
    exec(
      d1,
      `INSERT INTO usage_monthly (tenant_id, year_month, mau, archived_at) VALUES (?, ?, 95, 'x')`,
      TENANT_A.tenantId,
      new Date().toISOString().slice(0, 7),
    )

    const response = await send('/v1/platform/stats')
    const body = await json<{
      attention: Array<{ kind: string; facts: Record<string, unknown> }>
      activity: Array<{ key: string }>
    }>(response)

    expect(response.status).toBe(200)
    expect(body.attention.map((item) => item.kind)).toEqual([
      'dead_letters',
      'signing_key_next_ready',
      'mau_quota_high',
      'organization_suspended',
    ])
    expect(body.attention[0]?.facts).toMatchObject({
      count: 1,
      byQueue: [{ queue: 'xid-webhook', count: 1 }],
    })
    expect(JSON.stringify(body)).not.toContain('private_key')
    expect(body.activity.map((metric) => metric.key)).toEqual([
      'dau',
      'mau',
      'login_success_rate',
      'organizations',
      'users',
    ])
  })

  it('compares sign-in success with the previous 30 days and counts only live top-level data', async () => {
    const day = 24 * HOUR_MS
    const recent = new Date(Date.now() - day).toISOString()
    const earlier = new Date(Date.now() - 40 * day).toISOString()
    const outcomes = [
      [AUTH_LOGIN_SUCCEEDED_EVENT, recent],
      [AUTH_LOGIN_SUCCEEDED_EVENT, recent],
      [AUTH_LOGIN_SUCCEEDED_EVENT, recent],
      [AUTH_LOGIN_FAILED_EVENT, recent],
      [AUTH_LOGIN_SUCCEEDED_EVENT, earlier],
      [AUTH_LOGIN_FAILED_EVENT, earlier],
    ] as const
    outcomes.forEach(([eventType, occurredAt], index) =>
      seedAudit(d1, {
        seq: index + 1,
        tenantId: TENANT_A.tenantId,
        eventType,
        actorId: MEMBER,
        occurredAt,
      }),
    )
    await seedOrg(d1, { id: 'org_child', name: 'Child' })
    await seedUser(d1, { id: 'usr_gone', deleted: true })

    const body = await json<{
      loginSuccessRate: number
      organizationCount: number
      activeOrgCount: number
      totalUsers: number
      activity: Array<{ key: string; now: number | null; previous: number | null }>
    }>(await send('/v1/platform/stats'))

    expect(body.loginSuccessRate).toBe(0.75)
    expect(body.activity.find((metric) => metric.key === 'login_success_rate')).toEqual({
      key: 'login_success_rate',
      now: 0.75,
      previous: 0.5,
    })
    expect(body.organizationCount).toBe(1)
    expect(body.activeOrgCount).toBe(1)
    expect(body.totalUsers).toBe(2)
  })

  it('reports no sign-in success rate when there are no sign-in events', async () => {
    const body = await json<{
      loginSuccessRate: number | null
      activity: Array<{ key: string; now: number | null; previous: number | null }>
    }>(await send('/v1/platform/stats'))

    expect(body.loginSuccessRate).toBeNull()
    expect(body.activity.find((metric) => metric.key === 'login_success_rate')).toEqual({
      key: 'login_success_rate',
      now: null,
      previous: null,
    })
  })

  it('does not flag a next signing key still inside the JWKS cache window', async () => {
    exec(
      d1,
      `INSERT INTO instance_signing_keys (
         id, instance_id, kid, alg, public_key_jwk, private_key_iv, private_key_ciphertext,
         private_key_tag, kek_version, status, created_at, updated_at
       ) VALUES ('isk_next', 'inst_1', 'kid-next', 'ES256', '{}', x'00', x'00', x'00', 1, 'next', ?, ?)`,
      Date.now(),
      Date.now(),
    )

    const body = await json<{ attention: unknown[] }>(await send('/v1/platform/stats'))

    expect(body.attention).toEqual([])
  })

  it('filters platform audit by actor, organization and event prefix and returns details', async () => {
    seedAudit(d1, {
      seq: 1,
      tenantId: 'platform',
      eventType: 'platform.impersonation.ended',
      actorId: MANAGER,
      occurredAt: '2026-10-07T13:42:00.000Z',
    })
    seedAudit(d1, {
      seq: 2,
      tenantId: 'platform',
      eventType: 'platform.quota_changed',
      actorId: 'usr_other',
      occurredAt: '2026-10-07T13:43:00.000Z',
    })
    seedAudit(d1, {
      seq: 1,
      tenantId: TENANT_A.tenantId,
      eventType: 'user.created',
      actorId: MANAGER,
      occurredAt: '2026-10-07T13:44:00.000Z',
    })

    const prefix = await json<{ data: Array<{ eventType: string }>; total: number }>(
      await send('/v1/platform/audit-events?event_type=platform.*'),
    )
    const byActor = await json<{
      data: Array<{ eventType: string; actorName: string; details: unknown }>
    }>(await send(`/v1/platform/audit-events?actor_id=${MANAGER}&organization_id=platform`))
    const invalid = await send('/v1/platform/audit-events?event_type=platform%25')

    expect(prefix.data.map((row) => row.eventType)).toEqual([
      'platform.quota_changed',
      'platform.impersonation.ended',
    ])
    expect(prefix.total).toBe(2)
    expect(byActor.data).toEqual([
      expect.objectContaining({
        eventType: 'platform.impersonation.ended',
        actorName: 'Dana',
        details: { access: 'read_only' },
      }),
    ])
    expect(invalid.status).toBe(422)
  })

  it('stores affected components on open, update and edit, and rejects unknown components', async () => {
    const created = await send('/v1/platform/status-incidents', {
      method: 'POST',
      body: {
        title: 'Delayed SMS codes',
        status: 'investigating',
        impact: 'minor',
        summary: 'Some codes are slow.',
        startedAt: '2026-10-07T10:12:00.000Z',
        components: ['sms_delivery', 'sms_delivery'],
      },
    })
    const incident = await json<{ id: string; components: string[] }>(created)
    const updated = await send(`/v1/platform/status-incidents/${incident.id}/updates`, {
      method: 'POST',
      body: {
        status: 'monitoring',
        message: 'Fix rolling out.',
        components: ['sms_delivery', 'whatsapp_delivery'],
      },
    })
    const updatedBody = await json<{
      components: string[]
      lastUpdateAt: string | null
      updates: Array<{ createdByName: string | null }>
    }>(updated)
    const rejected = await send(`/v1/platform/status-incidents/${incident.id}`, {
      method: 'PATCH',
      body: { components: ['payments'] },
    })
    const publicStatus = await json<{ incidents: Array<{ components: string[] }> }>(
      await send('/v1/public/status'),
    )

    expect(created.status).toBe(201)
    expect(incident.components).toEqual(['sms_delivery'])
    expect(updated.status).toBe(201)
    expect(updatedBody.components).toEqual(['sms_delivery', 'whatsapp_delivery'])
    expect(updatedBody.lastUpdateAt).not.toBeNull()
    expect(updatedBody.updates[0]?.createdByName).toBe('Dana')
    expect(rejected.status).toBe(422)
    expect(rows(d1, `SELECT components FROM status_incidents`)).toEqual([
      { components: '["sms_delivery","whatsapp_delivery"]' },
    ])
    expect(publicStatus.incidents.map((row) => row.components)).toEqual([
      ['sms_delivery', 'whatsapp_delivery'],
    ])
  })

  it('records object size at registration and the result of each download check', async () => {
    env.STORAGE = storage({ 'compliance/soc2.pdf': 'hello' })
    const created = await send('/v1/platform/compliance-documents', {
      method: 'POST',
      body: {
        documentType: 'soc2',
        title: 'SOC 2 Type II report',
        status: 'available',
        storageKey: 'compliance/soc2.pdf',
        checksum: CHECKSUM_OF_HELLO,
        version: '2026',
      },
    })
    const document = await json<{ id: string; sizeBytes: number; registeredBy: string }>(created)

    const matched = await send(`/v1/platform/compliance-documents/${document.id}/artifact`)
    const afterMatch = rows(d1, `SELECT last_check_result FROM compliance_documents`)
    env.STORAGE = storage({ 'compliance/soc2.pdf': 'tampered' })
    const blocked = await send(`/v1/platform/compliance-documents/${document.id}/artifact`)
    const list = await json<{ data: Array<{ lastCheckResult: string; lastCheckedAt: string }> }>(
      await send('/v1/platform/compliance-documents'),
    )

    expect(created.status).toBe(201)
    expect(document.sizeBytes).toBe(5)
    expect(document.registeredBy).toBe('Dana')
    expect(matched.status).toBe(200)
    expect(afterMatch).toEqual([{ last_check_result: 'matched' }])
    expect(blocked.status).toBe(503)
    expect(list.data[0]?.lastCheckResult).toBe('mismatch')
    expect(list.data[0]?.lastCheckedAt).toBeTypeOf('string')
  })

  it('refuses to register evidence whose object is not in private storage', async () => {
    env.STORAGE = storage({})

    const response = await send('/v1/platform/compliance-documents', {
      method: 'POST',
      body: {
        documentType: 'soc2',
        title: 'SOC 2 Type II report',
        status: 'available',
        storageKey: 'compliance/missing.pdf',
        checksum: CHECKSUM_OF_HELLO,
        version: '2026',
      },
    })

    expect(response.status).toBe(422)
    expect(await json(response)).toMatchObject({ meta: { paramName: 'storageKey' } })
    expect(rows(d1, `SELECT id FROM compliance_documents`)).toEqual([])
  })
})
