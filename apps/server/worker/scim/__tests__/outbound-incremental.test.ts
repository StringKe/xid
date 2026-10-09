// 出站 SCIM 增量同步与全量续传(真实 SQLite + 全量 migration,下游用内存 SCIM 服务模拟)。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTenantDb, schema } from '@xid-kit/db'
import type { ScimSyncQueueMessage, TenantContext } from '@xid-kit/types'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteD1 } from '../../../../../packages/db/src/__tests__/sqlite-d1'
import { handleScimSyncBatch } from '../../queues/scim-sync'
import { SCIM_FULL_SYNC_DEDUPE_WINDOW_MS } from '../../lib/ttl'
import { claimScimFullSync, enqueueOrgScimTargetSyncs } from '../outbound-enqueue'
import { executeScimTargetSync, executeScimUserSync, FULL_SYNC_CHUNK_SIZE } from '../outbound-sync'
import { encryptScimTargetToken } from '../target-credentials'

const resolveTenantContextByIssuer = vi.hoisted(() => vi.fn())

vi.mock('@xid-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xid-kit/db')>()),
  resolveTenantContextByIssuer,
}))

const migrationDir = fileURLToPath(new URL('../../../../../packages/db/drizzle/', import.meta.url))
const KEK = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))

function tenantContext(tenantId: string): TenantContext {
  return {
    tenantId,
    issuer: 'https://xid.dev',
    rpId: 'xid.dev',
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: {},
  }
}

type DownstreamCall = { method: string; path: string }

// 最小下游 SCIM 服务:POST 分配 id,PUT/PATCH 返回 200,GET filter 返回空列表。
function stubDownstream(): DownstreamCall[] {
  const calls: DownstreamCall[] = []
  let next = 0
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    calls.push({ method, path: url.pathname })
    if (method === 'GET') {
      return Response.json({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
        Resources: [],
      })
    }
    if (method === 'POST') return Response.json({ id: `down_${++next}` }, { status: 201 })
    return Response.json({}, { status: 200 })
  })
  return calls
}

async function setup(memberCount: number) {
  const d1 = new SqliteD1()
  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    d1.database.exec(readFileSync(join(migrationDir, file), 'utf8'))
  }
  const db = d1 as unknown as D1Database
  const tenant = tenantContext('t_1')
  const tenantDb = createTenantDb(db, tenant)
  const sent: ScimSyncQueueMessage[] = []
  const env = {
    DB: db,
    KEK,
    ENVIRONMENT: 'test',
    SCIM_QUEUE: { send: vi.fn(async (message: ScimSyncQueueMessage) => void sent.push(message)) },
    AUDIT_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Env
  await tenantDb.scimTargets.insert({
    id: 'st_1',
    tenantId: 't_1',
    orgId: 'org_1',
    provider: 'custom',
    baseUrl: 'https://downstream.example.com/scim',
    tokenSecretRef: 'st_1',
    ...(await encryptScimTargetToken(env, 'downstream-token')),
  })
  for (let index = 0; index < memberCount; index++) {
    const userId = `user_${String(index).padStart(4, '0')}`
    await tenantDb.users.insert({ id: userId, tenantId: 't_1', status: 'active' })
    await tenantDb.memberships.insert({
      id: `mem_${String(index).padStart(4, '0')}`,
      tenantId: 't_1',
      orgId: 'org_1',
      userId,
      role: 'member',
      status: 'active',
    })
  }
  const target = (await tenantDb.scimTargets.findOne(eq(schema.scimTargets.id, 'st_1')))!
  return { env, tenant, tenantDb, target, sent }
}

function queueMessage(body: ScimSyncQueueMessage) {
  const message = {
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  }
  const batch = { messages: [message] } as unknown as MessageBatch<ScimSyncQueueMessage>
  return { message, batch }
}

describe('outbound SCIM incremental sync', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pushes only the changed user plus the role groups, never the rest of the org', async () => {
    const { env, tenant, target } = await setup(5)
    const calls = stubDownstream()

    const summary = await executeScimUserSync({ env, tenant, target, userId: 'user_0002' })

    expect(summary.users).toBe(1)
    const userWrites = calls.filter(
      (call) => call.path.endsWith('/Users') && call.method === 'POST',
    )
    expect(userWrites).toHaveLength(1)
    expect(calls.every((call) => !call.path.includes('/Users/') || call.method !== 'PUT')).toBe(
      true,
    )
  })

  it('deactivates the downstream user once the membership is gone', async () => {
    const { env, tenant, tenantDb, target } = await setup(2)
    stubDownstream()
    await executeScimUserSync({ env, tenant, target, userId: 'user_0001' })
    await tenantDb.memberships.update(
      { status: 'suspended' },
      eq(schema.memberships.id, 'mem_0001'),
    )
    const calls = stubDownstream()

    const summary = await executeScimUserSync({ env, tenant, target, userId: 'user_0001' })

    expect(summary.deactivations).toBe(1)
    expect(calls).toContainEqual({ method: 'PATCH', path: '/scim/Users/down_1' })
    const mapping = await tenantDb
      .forOrg('org_1')
      .scimTargetResources.findOne(eq(schema.scimTargetResources.localResourceId, 'user_0001'))
    expect(mapping?.status).toBe('deprovisioned')
  })
})

describe('outbound SCIM full reconciliation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('processes one chunk per call and returns a resume cursor until the org is exhausted', async () => {
    const { env, tenant, target } = await setup(FULL_SYNC_CHUNK_SIZE + 3)
    stubDownstream()

    const first = await executeScimTargetSync({ env, tenant, target })
    const second = await executeScimTargetSync({ env, tenant, target, cursor: first.nextCursor })

    expect(first.users).toBe(FULL_SYNC_CHUNK_SIZE)
    expect(first.nextCursor).toBe(`mem_${String(FULL_SYNC_CHUNK_SIZE - 1).padStart(4, '0')}`)
    expect(second.users).toBe(3)
    expect(second.nextCursor).toBeUndefined()
    expect(second.groups).toBe(1)
  })

  it('the consumer enqueues the continuation with the cursor and acks the finished chunk', async () => {
    const { env, target, sent } = await setup(FULL_SYNC_CHUNK_SIZE + 1)
    stubDownstream()
    const { message, batch } = queueMessage({
      tenantId: 't_1',
      orgId: target.orgId,
      targetId: target.id,
      issuer: 'https://xid.dev',
      runId: 'run_1',
      requestedAt: Date.now(),
    })
    resolveTenantContextByIssuer.mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: tenantContext('t_1') },
    })

    await handleScimSyncBatch(batch, env)

    expect(message.ack).toHaveBeenCalled()
    expect(message.retry).not.toHaveBeenCalled()
    expect(sent).toEqual([expect.objectContaining({ runId: 'run_1', cursor: expect.any(String) })])
  })

  it('keeps a single pending full run per target until the consumer picks it up', async () => {
    const { env, tenant, sent } = await setup(1)

    const first = await enqueueOrgScimTargetSyncs({ env, tenant, orgId: 'org_1' })
    const second = await enqueueOrgScimTargetSyncs({ env, tenant, orgId: 'org_1' })
    const userScoped = await enqueueOrgScimTargetSyncs({
      env,
      tenant,
      orgId: 'org_1',
      userId: 'user_0000',
    })

    expect([first, second, userScoped]).toEqual([1, 0, 1])
    expect(sent.map((message) => (message as { userId?: string }).userId)).toEqual([
      undefined,
      'user_0000',
    ])
  })

  it('shares one pending full-sync claim between the daily cron and org-level enqueue', async () => {
    const { env, tenant, sent } = await setup(1)
    const key = { tenantId: 't_1', orgId: 'org_1', targetId: 'st_1' }
    const now = Date.now()

    const cronClaimed = await claimScimFullSync(env, key, now)
    const orgQueued = await enqueueOrgScimTargetSyncs({ env, tenant, orgId: 'org_1' })
    const otherTenantClaimed = await claimScimFullSync(env, { ...key, tenantId: 't_2' }, now)
    const staleClaimed = await claimScimFullSync(
      env,
      key,
      now + SCIM_FULL_SYNC_DEDUPE_WINDOW_MS + 1,
    )

    expect([cronClaimed, orgQueued, otherTenantClaimed, staleClaimed]).toEqual([
      true,
      0,
      false,
      true,
    ])
    expect(sent).toEqual([])
  })

  it('lets the next automatic full sync through once the consumer starts the pending run', async () => {
    const { env, tenant, target, sent } = await setup(1)
    stubDownstream()
    await enqueueOrgScimTargetSyncs({ env, tenant, orgId: 'org_1' })
    const { batch } = queueMessage(sent[0]!)
    resolveTenantContextByIssuer.mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant },
    })

    await handleScimSyncBatch(batch, env)
    const claimedAfterStart = await claimScimFullSync(env, {
      tenantId: 't_1',
      orgId: target.orgId,
      targetId: target.id,
    })

    expect(claimedAfterStart).toBe(true)
  })
})
