import { base64UrlEncode, envelopeEncrypt } from '@xid-kit/crypto'
import { beforeEach, describe, expect, it } from 'vitest'
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
import { decodeKek } from '../../oidc/shared'
import { registerPlatformDeadLetterRoutes } from '../dead-letters'

type SqliteDb = ReturnType<typeof makeDb>

const MANAGER = 'usr_manager'
const NOW = Date.now()

function rows(d1: SqliteDb, sql: string): Record<string, unknown>[] {
  return d1.database.prepare(sql).all() as Record<string, unknown>[]
}

function seedManager(d1: SqliteDb): void {
  d1.database
    .prepare(
      `INSERT INTO manager_assignments (
         id, tenant_id, user_id, manager_role, scope_type, scope_id, created_at, updated_at
       ) VALUES ('ma_1', ?, ?, 'instance_manager', 'instance', NULL, 1000, 1000)`,
    )
    .run(TENANT_A.tenantId, MANAGER)
}

type DeadLetterSeed = {
  id: string
  sourceQueue?: string
  status?: string
  replayRequestedAt?: number | null
  payload?: unknown
}

async function seedDeadLetter(env: FakeEnv, d1: SqliteDb, input: DeadLetterSeed): Promise<void> {
  const sourceQueue = input.sourceQueue ?? 'xid-email'
  const body = input.payload ?? { type: 'verify_email', recipient: 'a@example.com', payload: {} }
  const encrypted = await envelopeEncrypt(
    new TextEncoder().encode(JSON.stringify(body)),
    decodeKek(env.KEK),
    1,
  )
  d1.database
    .prepare(
      `INSERT INTO queue_dead_letters (
         id, source_queue, dead_letter_queue, message_id, tenant_id, org_id, event_type,
         error_code, status, attempts, payload_iv, payload_ciphertext, payload_tag,
         payload_kek_version, source_enqueued_at, failed_at, replay_requested_at,
         replay_count, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, NULL, 'verify_email', 'consumer_retries_exhausted', ?, 5,
                 ?, ?, ?, 1, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      input.id,
      sourceQueue,
      `${sourceQueue}-dlq`,
      `msg_${input.id}`,
      TENANT_A.tenantId,
      input.status ?? 'pending',
      base64UrlEncode(encrypted.iv),
      base64UrlEncode(encrypted.ciphertext),
      base64UrlEncode(encrypted.tag),
      NOW - 10_000,
      NOW - 5_000,
      input.replayRequestedAt ?? null,
      NOW,
      NOW,
    )
}

function post(app: ReturnType<typeof buildApp>, env: FakeEnv, body: unknown): Promise<Response> {
  return app.request(
    'https://xid.dev/v1/platform/dead-letters/replay',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
  )
}

describe('platform dead-letter queue filter and batch replay', () => {
  let d1: SqliteDb
  let env: FakeEnv
  let app: ReturnType<typeof buildApp>

  beforeEach(async () => {
    d1 = makeDb()
    env = Object.assign(envOf(d1), {
      EMAIL_QUEUE: { send: async () => undefined },
      WEBHOOK_QUEUE: { send: async () => undefined },
    }) as FakeEnv
    await seedOrg(d1, { id: TENANT_A.tenantId, name: 'Acme' })
    await seedUser(d1, { id: MANAGER, email: 'manager@example.com' })
    seedManager(d1)
    app = buildApp(registerPlatformDeadLetterRoutes, { session: sessionFor(MANAGER) })
  })

  it('rejects an organization user without an instance_manager assignment', async () => {
    await seedUser(d1, { id: 'usr_member', email: 'member@example.com' })
    await seedDeadLetter(env, d1, { id: 'dlq_1' })
    const memberApp = buildApp(registerPlatformDeadLetterRoutes, {
      session: sessionFor('usr_member'),
    })

    const response = await post(memberApp, env, { ids: ['dlq_1'] })

    expect(response.status).toBe(403)
    expect(rows(d1, `SELECT status FROM queue_dead_letters WHERE id = 'dlq_1'`)).toEqual([
      { status: 'pending' },
    ])
  })

  it('lists one source queue with organization names and open counts per queue', async () => {
    await seedDeadLetter(env, d1, { id: 'dlq_email' })
    await seedDeadLetter(env, d1, { id: 'dlq_hook', sourceQueue: 'xid-webhook', payload: {} })
    await seedDeadLetter(env, d1, { id: 'dlq_done', status: 'replayed' })

    const response = await app.request(
      'https://xid.dev/v1/platform/dead-letters?queue=xid-email&status=open',
      {},
      env,
    )
    const body = await json<{
      data: Array<{ id: string; organizationName: string | null }>
      countsByQueue: Array<{ queue: string; count: number }>
    }>(response)

    expect(response.status).toBe(200)
    expect(body.data.map((row) => row.id)).toEqual(['dlq_email'])
    expect(body.data[0]?.organizationName).toBe('Acme')
    expect(body.countsByQueue).toContainEqual({ queue: 'xid-email', count: 1 })
    expect(body.countsByQueue).toContainEqual({ queue: 'xid-webhook', count: 1 })
    expect(body.countsByQueue).toContainEqual({ queue: 'xid-sms', count: 0 })
  })

  it('rejects an unknown queue filter', async () => {
    const response = await app.request(
      'https://xid.dev/v1/platform/dead-letters?queue=xid-unknown',
      {},
      env,
    )

    expect(response.status).toBe(422)
    expect(await json(response)).toMatchObject({ meta: { paramName: 'queue' } })
  })

  it('rejects a batch that mixes source queues before replaying anything', async () => {
    await seedDeadLetter(env, d1, { id: 'dlq_email' })
    await seedDeadLetter(env, d1, { id: 'dlq_hook', sourceQueue: 'xid-webhook', payload: {} })

    const response = await post(app, env, { ids: ['dlq_email', 'dlq_hook'] })

    expect(response.status).toBe(422)
    expect(await json(response)).toMatchObject({ meta: { paramName: 'ids' } })
    expect(rows(d1, `SELECT status FROM queue_dead_letters ORDER BY id`)).toEqual([
      { status: 'pending' },
      { status: 'pending' },
    ])
  })

  it('rejects more than 25 ids and an empty batch', async () => {
    const tooMany = Array.from({ length: 26 }, (_, index) => `dlq_${index}`)

    const [oversized, empty] = await Promise.all([
      post(app, env, { ids: tooMany }),
      post(app, env, { ids: [] }),
    ])

    expect(oversized.status).toBe(422)
    expect(empty.status).toBe(422)
  })

  it('returns 404 when any id does not exist', async () => {
    await seedDeadLetter(env, d1, { id: 'dlq_1' })

    const response = await post(app, env, { ids: ['dlq_1', 'dlq_missing'] })

    expect(response.status).toBe(404)
  })

  it('replays each message under its own lease and reports a held lease without auditing it', async () => {
    await seedDeadLetter(env, d1, { id: 'dlq_free' })
    await seedDeadLetter(env, d1, {
      id: 'dlq_held',
      status: 'replaying',
      replayRequestedAt: Date.now() - 1_000,
    })

    const response = await post(app, env, { ids: ['dlq_free', 'dlq_held', 'dlq_free'] })
    const body = await json<{
      sourceQueue: string
      results: Array<{ id: string; outcome: string; replayed?: boolean }>
    }>(response)

    expect(response.status).toBe(200)
    expect(body.sourceQueue).toBe('xid-email')
    expect(body.results).toEqual([
      expect.objectContaining({ id: 'dlq_free', outcome: 'replayed', replayed: true }),
      expect.objectContaining({ id: 'dlq_held', outcome: 'lease_held', replayed: false }),
    ])
    expect(rows(d1, `SELECT id, status FROM queue_dead_letters ORDER BY id`)).toEqual([
      { id: 'dlq_free', status: 'replayed' },
      { id: 'dlq_held', status: 'replaying' },
    ])
    const audits = rows(d1, `SELECT action, payload FROM platform_audit_outbox`)
    expect(audits).toHaveLength(1)
    expect(audits[0]?.['action']).toBe('platform.queue_dead_letter.replayed')
    expect(JSON.parse(String(audits[0]?.['payload']))).toMatchObject({
      targetId: 'dlq_free',
      batch: true,
    })
  })

  it('reports an already replayed message as idempotent', async () => {
    await seedDeadLetter(env, d1, { id: 'dlq_done', status: 'replayed' })

    const response = await post(app, env, { ids: ['dlq_done'] })
    const body = await json<{ results: Array<{ outcome: string }> }>(response)

    expect(body.results).toEqual([expect.objectContaining({ outcome: 'already_replayed' })])
    expect(rows(d1, `SELECT id FROM platform_audit_outbox`)).toEqual([])
  })
})
