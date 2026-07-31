import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256Hex } from '@xid-kit/crypto'
import { IMPERSONATION_GRANT_TTL_MS, ImpersonationGrantDO } from '../impersonation-grant-do'
import { MockDurableObjectState } from './mock-do-state'

const SECRET = 'opaque-impersonation-secret'
const CREATE_BODY = {
  secretHash: '',
  targetTenantId: 'org_target',
  targetOrganizationId: 'org_target',
  targetOrganizationSlug: 'target',
  targetUserId: 'user_target',
  targetInstanceId: 'inst_1',
  targetOrigin: 'https://target.xid.dev',
  impersonatorUserId: 'user_manager',
  actorIp: '203.0.113.10',
  ttlMs: IMPERSONATION_GRANT_TTL_MS,
}

function post(doObject: ImpersonationGrantDO, path: string, body: Record<string, unknown>) {
  return doObject.fetch(
    new Request(`https://impersonation-grant${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

describe('ImpersonationGrantDO', () => {
  beforeEach(() => vi.useRealTimers())

  it('stores only the secret hash and consumes the grant exactly once', async () => {
    const state = new MockDurableObjectState()
    const grantDo = new ImpersonationGrantDO(state as unknown as DurableObjectState)
    const secretHash = await sha256Hex(SECRET)

    const created = await post(grantDo, '/create', { ...CREATE_BODY, secretHash })
    expect(created.status).toBe(201)
    const stored = await state.storage.list<Record<string, unknown>>()
    const serialized = JSON.stringify([...stored.values()])
    expect(serialized).toContain(secretHash)
    expect(serialized).not.toContain(SECRET)

    const consumeBody = {
      secretHash,
      targetTenantId: CREATE_BODY.targetTenantId,
      targetInstanceId: CREATE_BODY.targetInstanceId,
      targetOrigin: CREATE_BODY.targetOrigin,
    }
    const first = await post(grantDo, '/consume', consumeBody)
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toMatchObject({
      grant: {
        targetUserId: 'user_target',
        targetOrganizationSlug: 'target',
        impersonatorUserId: 'user_manager',
        targetOrigin: 'https://target.xid.dev',
      },
    })
    const second = await post(grantDo, '/consume', consumeBody)
    expect(second.status).toBe(404)
  })

  it('allows only one winner across concurrent consume requests', async () => {
    const state = new MockDurableObjectState()
    const grantDo = new ImpersonationGrantDO(state as unknown as DurableObjectState)
    const secretHash = await sha256Hex(SECRET)
    await post(grantDo, '/create', { ...CREATE_BODY, secretHash })
    const consumeBody = {
      secretHash,
      targetTenantId: CREATE_BODY.targetTenantId,
      targetInstanceId: CREATE_BODY.targetInstanceId,
      targetOrigin: CREATE_BODY.targetOrigin,
    }

    const responses = await Promise.all([
      post(grantDo, '/consume', consumeBody),
      post(grantDo, '/consume', consumeBody),
    ])

    expect(responses.map((response) => response.status).sort()).toEqual([200, 404])
  })

  it('does not burn the grant on a wrong secret or target origin', async () => {
    const state = new MockDurableObjectState()
    const grantDo = new ImpersonationGrantDO(state as unknown as DurableObjectState)
    const secretHash = await sha256Hex(SECRET)
    await post(grantDo, '/create', { ...CREATE_BODY, secretHash })

    const wrongSecret = await post(grantDo, '/consume', {
      secretHash: await sha256Hex('wrong'),
      targetTenantId: CREATE_BODY.targetTenantId,
      targetInstanceId: CREATE_BODY.targetInstanceId,
      targetOrigin: CREATE_BODY.targetOrigin,
    })
    expect(wrongSecret.status).toBe(404)

    const wrongOrigin = await post(grantDo, '/consume', {
      secretHash,
      targetTenantId: CREATE_BODY.targetTenantId,
      targetInstanceId: CREATE_BODY.targetInstanceId,
      targetOrigin: 'https://other.xid.dev',
    })
    expect(wrongOrigin.status).toBe(404)

    const valid = await post(grantDo, '/consume', {
      secretHash,
      targetTenantId: CREATE_BODY.targetTenantId,
      targetInstanceId: CREATE_BODY.targetInstanceId,
      targetOrigin: CREATE_BODY.targetOrigin,
    })
    expect(valid.status).toBe(200)
  })

  it('expires and deletes an unconsumed grant', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-28T00:00:00Z'))
    const state = new MockDurableObjectState()
    const grantDo = new ImpersonationGrantDO(state as unknown as DurableObjectState)
    const secretHash = await sha256Hex(SECRET)
    await post(grantDo, '/create', { ...CREATE_BODY, secretHash, ttlMs: 1000 })

    vi.advanceTimersByTime(1001)
    const expired = await post(grantDo, '/consume', {
      secretHash,
      targetTenantId: CREATE_BODY.targetTenantId,
      targetInstanceId: CREATE_BODY.targetInstanceId,
      targetOrigin: CREATE_BODY.targetOrigin,
    })
    expect(expired.status).toBe(410)
    expect(state.storage.size()).toBe(0)
  })
})
