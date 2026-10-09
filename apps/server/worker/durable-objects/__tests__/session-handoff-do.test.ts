// SessionHandoffDO:只存 secret 与 state 的哈希,绑定租户、实例与目标 origin,过期或任一绑定不符都不放行,只能消费一次。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256Hex } from '@xid-kit/crypto'
import { SESSION_HANDOFF_TTL_MS } from '../../lib/ttl'
import { SessionHandoffDO } from '../session-handoff-do'
import { MockDurableObjectState } from './mock-do-state'

const SECRET = 'opaque-handoff-secret'
const STATE = 'browser-bound-handoff-state'

async function createBody() {
  return {
    secretHash: await sha256Hex(SECRET),
    stateHash: await sha256Hex(STATE),
    tenantId: 'org_acme',
    instanceId: 'inst_1',
    targetOrigin: 'https://xid.dev',
    userId: 'user_1',
    continuePath: '/authorize?authz_request_id=req_1&client_id=client_1',
    authenticatedAt: 1_000,
    sessionStatus: 'pending_mfa',
    acr: 'urn:xid:aal1',
    amr: ['pwd'],
    aal: 1,
    authMethod: 'sso',
    rememberMe: true,
    stepUp: null,
    ttlMs: SESSION_HANDOFF_TTL_MS,
  }
}

async function consumeBody(overrides: Record<string, unknown> = {}) {
  return {
    secretHash: await sha256Hex(SECRET),
    stateHash: await sha256Hex(STATE),
    tenantId: 'org_acme',
    instanceId: 'inst_1',
    targetOrigin: 'https://xid.dev',
    ...overrides,
  }
}

function post(target: SessionHandoffDO, path: string, body: Record<string, unknown>) {
  return target.fetch(
    new Request(`https://session-handoff${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

function makeDo(): { state: MockDurableObjectState; handoff: SessionHandoffDO } {
  const state = new MockDurableObjectState()
  return { state, handoff: new SessionHandoffDO(state as unknown as DurableObjectState) }
}

describe('SessionHandoffDO', () => {
  beforeEach(() => vi.useRealTimers())

  it('stores only hashes and hands the identity over exactly once', async () => {
    const { state, handoff } = makeDo()
    await post(handoff, '/create', await createBody())

    const stored = JSON.stringify([...(await state.storage.list()).values()])
    const first = await post(handoff, '/consume', await consumeBody())
    const second = await post(handoff, '/consume', await consumeBody())

    expect(stored).not.toContain(SECRET)
    expect(stored).not.toContain(STATE)
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toMatchObject({
      grant: {
        userId: 'user_1',
        tenantId: 'org_acme',
        authenticatedAt: 1_000,
        sessionStatus: 'pending_mfa',
        amr: ['pwd'],
        authMethod: 'sso',
      },
    })
    expect(second.status).toBe(404)
  })

  it('allows only one winner across concurrent consumers', async () => {
    const { handoff } = makeDo()
    await post(handoff, '/create', await createBody())

    const responses = await Promise.all([
      post(handoff, '/consume', await consumeBody()),
      post(handoff, '/consume', await consumeBody()),
    ])

    expect(responses.map((response) => response.status).sort()).toEqual([200, 404])
  })

  it.each([
    ['another browser state', { stateHash: '0'.repeat(64) }],
    ['a wrong secret', { secretHash: '1'.repeat(64) }],
    ['another tenant', { tenantId: 'org_other' }],
    ['another instance', { instanceId: 'inst_2' }],
    ['another origin', { targetOrigin: 'https://evil.example' }],
  ])('rejects %s and keeps the grant for the legitimate consumer', async (_label, overrides) => {
    const { handoff } = makeDo()
    await post(handoff, '/create', await createBody())

    const rejected = await post(handoff, '/consume', await consumeBody(overrides))
    const legitimate = await post(handoff, '/consume', await consumeBody())

    expect(rejected.status).toBe(404)
    expect(legitimate.status).toBe(200)
  })

  it('rejects an expired grant', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'))
    const { handoff } = makeDo()
    await post(handoff, '/create', await createBody())
    vi.setSystemTime(new Date(Date.now() + SESSION_HANDOFF_TTL_MS + 1))

    const response = await post(handoff, '/consume', await consumeBody())

    expect(response.status).toBe(410)
  })

  it('refuses an unknown session status', async () => {
    const { handoff } = makeDo()

    const response = await post(handoff, '/create', {
      ...(await createBody()),
      sessionStatus: 'impersonating',
    })

    expect(response.status).toBe(400)
  })

  it.each([
    ['an unknown sign-in method', 'kerberos'],
    ['a missing sign-in method', undefined],
  ])('refuses %s', async (_label, authMethod) => {
    const { handoff } = makeDo()

    const response = await post(handoff, '/create', { ...(await createBody()), authMethod })

    expect(response.status).toBe(400)
  })

  it('accepts a session without a recorded sign-in method', async () => {
    const { handoff } = makeDo()

    const response = await post(handoff, '/create', {
      ...(await createBody()),
      authMethod: null,
    })

    expect(response.status).toBe(201)
  })

  it('refuses a TTL longer than two minutes', async () => {
    const { handoff } = makeDo()

    const response = await post(handoff, '/create', {
      ...(await createBody()),
      ttlMs: SESSION_HANDOFF_TTL_MS + 1,
    })

    expect(response.status).toBe(400)
  })
})
