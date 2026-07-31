import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRIVACY_DELETE_GRACE_MS } from '../../privacy/constants'
import { registerPrivacyRoutes } from '../privacy'
import { asUnknown, buildApp, makeSession } from './harness'

type StoredRequest = {
  id: string
  tenantId: string
  userId: string
  requestType: 'export' | 'delete'
  status: 'pending' | 'processing' | 'completed' | 'canceled' | 'expired'
  storageKey: string | null
  contentType: string | null
  availableAt: number | null
  expiresAt: number | null
  scheduledFor: number | null
  processingStartedAt: number | null
  completedAt: number | null
  canceledAt: number | null
  errorCode: string | null
  createdAt: number
  updatedAt: number
}

function makeEnv(
  initial: StoredRequest[] = [],
  objects: Record<string, string> = {},
  options: {
    blocksOwnerErasure?: boolean
    blocksInstanceManagerErasure?: boolean
    provisionalWithoutMembership?: boolean
  } = {},
): { env: Env; requests: StoredRequest[]; queueSend: ReturnType<typeof vi.fn> } {
  const requests = [...initial]
  const queueSend = vi.fn().mockResolvedValue(undefined)
  const prepare = (sql: string) => {
    let params: unknown[] = []
    const statement = {
      bind: (...values: unknown[]) => {
        params = values
        return statement
      },
      run: async () => {
        if (sql.includes('INSERT INTO privacy_requests')) {
          const [id, tenantId, userId, requestType, scheduledFor, createdAt, updatedAt] = params
          const duplicate = requests.some(
            (row) =>
              row.tenantId === tenantId &&
              row.userId === userId &&
              row.requestType === requestType &&
              (row.status === 'pending' || row.status === 'processing'),
          )
          if (duplicate) return { success: true, meta: { changes: 0 } }
          requests.push({
            id: String(id),
            tenantId: String(tenantId),
            userId: String(userId),
            requestType: requestType as 'export' | 'delete',
            status: 'pending',
            storageKey: null,
            contentType: null,
            availableAt: null,
            expiresAt: null,
            scheduledFor: Number(scheduledFor),
            processingStartedAt: null,
            completedAt: null,
            canceledAt: null,
            errorCode: null,
            createdAt: Number(createdAt),
            updatedAt: Number(updatedAt),
          })
          return { success: true, meta: { changes: 1 } }
        }
        if (sql.includes("SET status = 'canceled'")) {
          const [canceledAt, updatedAt, id, tenantId, userId] = params
          const row = requests.find(
            (candidate) =>
              candidate.id === id &&
              candidate.tenantId === tenantId &&
              candidate.userId === userId &&
              candidate.status === 'pending',
          )
          if (!row) return { success: true, meta: { changes: 0 } }
          row.status = 'canceled'
          row.canceledAt = Number(canceledAt)
          row.updatedAt = Number(updatedAt)
          return { success: true, meta: { changes: 1 } }
        }
        return { success: true, meta: { changes: 0 } }
      },
      first: async () => {
        if (sql.includes('AS eligible')) {
          return { eligible: options.provisionalWithoutMembership ? 0 : 1 }
        }
        if (sql.includes('blocksOwnerErasure') && sql.includes('blocksInstanceManagerErasure')) {
          return {
            blocksOwnerErasure: options.blocksOwnerErasure ? 1 : 0,
            blocksInstanceManagerErasure: options.blocksInstanceManagerErasure ? 1 : 0,
          }
        }
        if (
          sql.includes('request_type = ?') &&
          sql.includes("status IN ('pending', 'processing')")
        ) {
          const [tenantId, userId, requestType] = params
          return (
            requests.find(
              (row) =>
                row.tenantId === tenantId &&
                row.userId === userId &&
                row.requestType === requestType &&
                (row.status === 'pending' || row.status === 'processing'),
            ) ?? null
          )
        }
        const [id, tenantId, userId] = params
        return (
          requests.find(
            (row) => row.id === id && row.tenantId === tenantId && row.userId === userId,
          ) ?? null
        )
      },
      all: async () => {
        const [tenantId, userId] = params
        return {
          results: requests.filter((row) => row.tenantId === tenantId && row.userId === userId),
        }
      },
    }
    return statement
  }

  const env = asUnknown<Env>({
    DB: { prepare },
    PRIVACY_QUEUE: { send: queueSend },
    STORAGE: {
      get: async (key: string) => {
        const value = objects[key]
        if (value === undefined) return null
        return {
          body: new Response(value).body,
          size: new TextEncoder().encode(value).byteLength,
        }
      },
    },
  })
  return { env, requests, queueSend }
}

function row(overrides: Partial<StoredRequest> = {}): StoredRequest {
  const now = Date.now()
  return {
    id: 'prv_existing',
    tenantId: 't_1',
    userId: 'u_1',
    requestType: 'export',
    status: 'pending',
    storageKey: null,
    contentType: null,
    availableAt: null,
    expiresAt: null,
    scheduledFor: now,
    processingStartedAt: null,
    completedAt: null,
    canceledAt: null,
    errorCode: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('account privacy request API', () => {
  it('rejects provisional users without a Membership and never creates or queues an export', async () => {
    const { env, requests, queueSend } = makeEnv([], {}, { provisionalWithoutMembership: true })
    const app = buildApp({ register: registerPrivacyRoutes, session: makeSession() })

    const response = await app.request(
      'https://acme.xid.dev/v1/me/privacy/requests',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'export' }),
      },
      env,
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'conflict' })
    expect(requests).toHaveLength(0)
    expect(queueSend).not.toHaveBeenCalled()
  })

  it('creates an idempotent export request and enqueues identifiers only', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-28T00:00:00.000Z'))
    const { env, requests, queueSend } = makeEnv()
    const app = buildApp({ register: registerPrivacyRoutes, session: makeSession() })

    const first = await app.request(
      'https://acme.xid.dev/v1/me/privacy/requests',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'export' }),
      },
      env,
    )
    const second = await app.request(
      'https://acme.xid.dev/v1/me/privacy/requests',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'export' }),
      },
      env,
    )

    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(requests).toHaveLength(1)
    expect(queueSend).toHaveBeenCalledTimes(2)
    expect(queueSend).toHaveBeenLastCalledWith({
      requestId: requests[0]?.id,
      tenantId: 't_1',
      userId: 'u_1',
      operation: 'export',
      requestedAt: Date.now(),
    })
    expect(JSON.stringify(queueSend.mock.calls)).not.toContain('@')
  })

  it('schedules deletion after the 30-day grace period without enqueueing it early', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-28T00:00:00.000Z'))
    const { env, requests, queueSend } = makeEnv()
    const app = buildApp({ register: registerPrivacyRoutes, session: makeSession() })

    const response = await app.request(
      'https://acme.xid.dev/v1/me/privacy/requests',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'delete', confirmation: 'DELETE' }),
      },
      env,
    )

    expect(response.status).toBe(202)
    expect(requests[0]?.scheduledFor).toBe(Date.now() + PRIVACY_DELETE_GRACE_MS)
    expect(queueSend).not.toHaveBeenCalled()
  })

  it.each([
    ['the sole active owner', { blocksOwnerErasure: true }],
    ['the last active instance manager', { blocksInstanceManagerErasure: true }],
  ])('rejects deletion scheduling for %s without exposing the role', async (_label, options) => {
    const { env, requests, queueSend } = makeEnv([], {}, options)
    const app = buildApp({ register: registerPrivacyRoutes, session: makeSession() })

    const response = await app.request(
      'https://acme.xid.dev/v1/me/privacy/requests',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'delete', confirmation: 'DELETE' }),
      },
      env,
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'conflict' })
    expect(requests).toHaveLength(0)
    expect(queueSend).not.toHaveBeenCalled()
  })

  it('rejects a deletion request without the exact destructive confirmation', async () => {
    const { env, requests, queueSend } = makeEnv()
    const app = buildApp({ register: registerPrivacyRoutes, session: makeSession() })

    for (const body of [
      { type: 'delete' },
      { type: 'delete', confirmation: 'delete' },
      { type: 'delete', confirmation: 'DELETE ' },
    ]) {
      const response = await app.request(
        'https://acme.xid.dev/v1/me/privacy/requests',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        env,
      )
      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({
        code: 'validation_failed',
        meta: { paramName: 'confirmation' },
      })
    }
    expect(requests).toHaveLength(0)
    expect(queueSend).not.toHaveBeenCalled()
  })

  it('lists, gets, and cancels only the authenticated tenant user request', async () => {
    const own = row({ id: 'prv_own' })
    const otherTenant = row({ id: 'prv_other', tenantId: 't_other' })
    const { env } = makeEnv([own, otherTenant])
    const app = buildApp({ register: registerPrivacyRoutes, session: makeSession() })

    const list = await app.request(
      'https://acme.xid.dev/v1/me/privacy/requests',
      { method: 'GET' },
      env,
    )
    expect((await list.json()) as unknown[]).toHaveLength(1)

    const hidden = await app.request(
      'https://acme.xid.dev/v1/me/privacy/requests/prv_other',
      { method: 'GET' },
      env,
    )
    expect(hidden.status).toBe(404)

    const canceled = await app.request(
      'https://acme.xid.dev/v1/me/privacy/requests/prv_own/cancel',
      { method: 'POST' },
      env,
    )
    expect(canceled.status).toBe(200)
    expect(own.status).toBe('canceled')
  })

  it('streams a completed export only during its authenticated 48-hour window', async () => {
    const now = Date.now()
    const storageKey = 'privacy-exports/t_1/u_1/prv_ready.json'
    const ready = row({
      id: 'prv_ready',
      status: 'completed',
      storageKey,
      contentType: 'application/json; charset=utf-8',
      availableAt: now - 1_000,
      expiresAt: now + 1_000,
      completedAt: now - 1_000,
    })
    const expired = row({
      id: 'prv_expired',
      status: 'completed',
      storageKey: 'privacy-exports/t_1/u_1/prv_expired.json',
      availableAt: now - 2_000,
      expiresAt: now - 1_000,
    })
    const { env } = makeEnv([ready, expired], { [storageKey]: '{"ok":true}' })
    const app = buildApp({ register: registerPrivacyRoutes, session: makeSession() })

    const response = await app.request(
      'https://acme.xid.dev/v1/me/privacy/requests/prv_ready/download',
      { method: 'GET' },
      env,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('content-disposition')).toContain('attachment')
    expect(await response.text()).toBe('{"ok":true}')

    const expiredResponse = await app.request(
      'https://acme.xid.dev/v1/me/privacy/requests/prv_expired/download',
      { method: 'GET' },
      env,
    )
    expect(expiredResponse.status).toBe(404)

    const anonymous = buildApp({ register: registerPrivacyRoutes, session: null })
    const unauthenticated = await anonymous.request(
      'https://acme.xid.dev/v1/me/privacy/requests/prv_ready/download',
      { method: 'GET' },
      env,
    )
    expect(unauthenticated.status).toBe(401)
  })
})
