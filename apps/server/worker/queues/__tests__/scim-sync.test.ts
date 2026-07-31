import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScimSyncQueueMessage, TenantContext } from '@xid-kit/types'
import { handleScimSyncBatch } from '../scim-sync'

const resolveTenantContextByIssuer = vi.hoisted(() => vi.fn())

vi.mock('@xid-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xid-kit/db')>()),
  resolveTenantContextByIssuer,
}))

const TENANT: TenantContext = {
  tenantId: 't_1',
  issuer: 'https://acme.xid.dev',
  rpId: 'acme.xid.dev',
  signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
  policy: {},
}

function asUnknown<T>(value: unknown): T {
  return value as T
}

function projectionColumns(sql: string): string[] {
  const ret = /returning\s+(.+)$/i.exec(sql)
  const head = ret ? ret[1] : /^select\s+(.+?)\s+from\s/i.exec(sql)?.[1]
  if (!head) return []
  return [...head.matchAll(/"([a-z_]+)"/g)].map((match) => match[1] ?? '')
}

function makeD1(): D1Database {
  const target = {
    id: 'st_1',
    tenant_id: 't_1',
    org_id: 'org_1',
    provider: 'okta',
    base_url: 'https://downstream.example.com/scim',
    token_secret_ref: 'SCIM_TARGET_TOKEN_st_1',
    user_filter: '{}',
    status: 'active',
    last_sync_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  }
  const membership = {
    id: 'mem_1',
    tenant_id: 't_1',
    org_id: 'org_1',
    user_id: 'user_1',
    role: 'member',
    status: 'active',
  }
  const user = {
    id: 'user_1',
    tenant_id: 't_1',
    primary_email_id: 'email_1',
    status: 'active',
    deleted_at: null,
  }
  const email = {
    id: 'email_1',
    tenant_id: 't_1',
    user_id: 'user_1',
    email: 'user@example.test',
    verified: 1,
    verification_status: 'verified',
    is_primary: 1,
  }
  const rows = (sql: string): Record<string, unknown>[] => {
    const lower = sql.toLowerCase()
    if (lower.includes('scim_target_resources')) return []
    if (lower.includes('scim_targets')) return [target]
    if (lower.includes('memberships')) return [membership]
    if (lower.includes('user_emails')) return [email]
    if (lower.includes('users')) return [user]
    return []
  }
  const prepare = (sql: string): unknown => {
    const stmt = {
      bind: (..._params: unknown[]) => stmt,
      all: async () => ({ results: rows(sql), success: true, meta: {} }),
      run: async () => ({ results: [], success: true, meta: {} }),
      first: async () => rows(sql)[0] ?? null,
      raw: async () =>
        rows(sql).map((row) => projectionColumns(sql).map((column) => row[column] ?? null)),
    }
    return stmt
  }
  return asUnknown<D1Database>({ prepare, batch: async () => [] })
}

function makeMessage(body: ScimSyncQueueMessage, attempts = 1): Message<ScimSyncQueueMessage> {
  return asUnknown<Message<ScimSyncQueueMessage>>({
    id: 'queue_message_1',
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  })
}

function makeBatch(message: Message<ScimSyncQueueMessage>): MessageBatch<ScimSyncQueueMessage> {
  return asUnknown<MessageBatch<ScimSyncQueueMessage>>({
    queue: 'xid-scim-sync',
    messages: [message],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  })
}

describe('Outbound SCIM Queue consumer', () => {
  beforeEach(() => {
    resolveTenantContextByIssuer.mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: TENANT },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('429 honors Retry-After delta seconds and audits the same runId before retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '120' },
        }),
      ),
    )
    const auditSend = vi.fn().mockResolvedValue(undefined)
    const env = asUnknown<Env>({
      DB: makeD1(),
      SCIM_TARGET_TOKEN_st_1: 'secret',
      AUDIT_QUEUE: { send: auditSend },
    })
    const body: ScimSyncQueueMessage = {
      tenantId: 't_1',
      orgId: 'org_1',
      targetId: 'st_1',
      issuer: 'https://acme.xid.dev',
      actorId: 'user_1',
      runId: 'run_1',
      requestedAt: 123,
    }
    const message = makeMessage(body)

    await handleScimSyncBatch(makeBatch(message), env)

    const tenantRequest = resolveTenantContextByIssuer.mock.calls[0]?.[0] as Request
    expect(tenantRequest.headers.get('host')).toBe('acme.xid.dev')
    expect(message.ack).not.toHaveBeenCalled()
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 120 })
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't_1',
        orgId: 'org_1',
        action: 'outbound_scim.sync.retry_scheduled',
        actorId: 'user_1',
        payload: expect.objectContaining({
          runId: 'run_1',
          targetId: 'st_1',
          attempt: 1,
          statusCode: 429,
          retryAfterSeconds: 120,
        }),
      }),
    )
    expect(JSON.stringify(auditSend.mock.calls)).not.toContain('rate limited')
    expect(JSON.stringify(auditSend.mock.calls)).not.toContain('secret')
  })

  it('429 honors Retry-After HTTP-date', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('', {
          status: 429,
          headers: { 'Retry-After': 'Tue, 28 Jul 2026 10:02:00 GMT' },
        }),
      ),
    )
    const env = asUnknown<Env>({
      DB: makeD1(),
      SCIM_TARGET_TOKEN_st_1: 'secret',
      AUDIT_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    })
    const message = makeMessage({
      tenantId: 't_1',
      orgId: 'org_1',
      targetId: 'st_1',
      issuer: 'https://acme.xid.dev',
      runId: 'run_http_date',
      requestedAt: Date.now(),
    })

    await handleScimSyncBatch(makeBatch(message), env)

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 120 })
  })

  it('configured five retries marks only delivery attempt 6 as terminal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })))
    const auditSend = vi.fn().mockResolvedValue(undefined)
    const env = asUnknown<Env>({
      DB: makeD1(),
      SCIM_TARGET_TOKEN_st_1: 'secret',
      AUDIT_QUEUE: { send: auditSend },
    })
    const body: ScimSyncQueueMessage = {
      tenantId: 't_1',
      orgId: 'org_1',
      targetId: 'st_1',
      issuer: 'https://acme.xid.dev',
      runId: 'run_retry_limit',
      requestedAt: Date.now(),
    }
    const fifthDelivery = makeMessage(body, 5)

    await handleScimSyncBatch(makeBatch(fifthDelivery), env)

    expect(fifthDelivery.retry).toHaveBeenCalledWith({ delaySeconds: 480 })
    expect(auditSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'outbound_scim.sync.retry_scheduled',
        payload: expect.objectContaining({ attempt: 5, terminal: false }),
      }),
    )

    auditSend.mockClear()
    const finalDelivery = makeMessage(body, 6)
    await handleScimSyncBatch(makeBatch(finalDelivery), env)

    expect(finalDelivery.retry).toHaveBeenCalledWith({ delaySeconds: 960 })
    expect(auditSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'outbound_scim.sync.failed',
        payload: expect.objectContaining({ attempt: 6, terminal: true }),
      }),
    )
  })
})
