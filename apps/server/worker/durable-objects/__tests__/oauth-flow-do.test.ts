// OAuthFlowDO 单元测试:一次性消费 / 过期失效 / 重放拒绝 / PKCE plain 拒绝 / alarm 清理。
// 见 oidc-oauth rule:state/nonce 防 CSRF;PKCE 强制 S256 only 拒 plain。

import { describe, it, expect } from 'vitest'
import { OAuthFlowDO } from '../oauth-flow-do'
import { MockDurableObjectState } from './mock-do-state'

function makeDO(): { do_: OAuthFlowDO; state: MockDurableObjectState } {
  const state = new MockDurableObjectState()
  const do_ = new OAuthFlowDO(state as unknown as DurableObjectState)
  state.setAlarmHandler(() => (do_ as unknown as { alarm(): Promise<void> }).alarm())
  return { do_, state }
}

async function post(do_: OAuthFlowDO, path: string, body: unknown): Promise<Response> {
  return do_.fetch(
    new Request(`http://do${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

const baseStorePayload = {
  state: 'state-abc-123',
  nonce: 'nonce-xyz',
  codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  codeChallengeMethod: 'S256',
  ttlMs: 60_000,
}

describe('OAuthFlowDO.store', () => {
  it('returns 201 on valid store', async () => {
    const { do_ } = makeDO()
    const res = await post(do_, '/store', baseStorePayload)
    expect(res.status).toBe(201)
  })

  it('returns 400 when state is missing', async () => {
    const { do_ } = makeDO()
    const res = await post(do_, '/store', { nonce: 'n', ttlMs: 60_000 })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('invalid_request')
  })

  it('rejects plain code_challenge_method with 400', async () => {
    const { do_ } = makeDO()
    const res = await post(do_, '/store', {
      state: 'st-plain',
      codeChallenge: 'verifier',
      codeChallengeMethod: 'plain',
      ttlMs: 60_000,
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('invalid_request')
  })

  it('accepts store without optional fields', async () => {
    const { do_ } = makeDO()
    const res = await post(do_, '/store', { state: 'state-minimal', ttlMs: 30_000 })
    expect(res.status).toBe(201)
  })
})

describe('OAuthFlowDO.consume - 一次性', () => {
  it('returns record on first consume', async () => {
    const { do_ } = makeDO()
    await post(do_, '/store', baseStorePayload)

    const res = await post(do_, '/consume', { state: 'state-abc-123' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      record: { state: string; nonce: string; codeChallenge: string }
    }
    expect(body.record.state).toBe('state-abc-123')
    expect(body.record.nonce).toBe('nonce-xyz')
    expect(body.record.codeChallenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('returns 404 on second consume (replay denied)', async () => {
    const { do_ } = makeDO()
    await post(do_, '/store', { ...baseStorePayload, state: 'state-replay' })

    const first = await post(do_, '/consume', { state: 'state-replay' })
    expect(first.status).toBe(200)

    // 第二次消费即重放,必须拒绝
    const second = await post(do_, '/consume', { state: 'state-replay' })
    expect(second.status).toBe(404)
    const body = (await second.json()) as { code: string }
    expect(body.code).toBe('invalid_request')
  })

  it('returns 404 when state does not exist', async () => {
    const { do_ } = makeDO()
    const res = await post(do_, '/consume', { state: 'nonexistent-state' })
    expect(res.status).toBe(404)
  })
})

describe('OAuthFlowDO.claim - 重放栅栏', () => {
  it('only accepts the first claim for an unexpired state', async () => {
    const { do_ } = makeDO()
    const first = await post(do_, '/claim', { state: 'jti-1', ttlMs: 60_000 })
    const replay = await post(do_, '/claim', { state: 'jti-1', ttlMs: 60_000 })

    expect(first.status).toBe(201)
    expect(replay.status).toBe(409)
    expect((await replay.json()) as { code: string }).toMatchObject({ code: 'replay_detected' })
  })

  it('reclaims an expired state', async () => {
    const { do_ } = makeDO()
    await post(do_, '/claim', { state: 'jti-expired', ttlMs: 1 })
    await new Promise((resolve) => setTimeout(resolve, 5))

    const reclaimed = await post(do_, '/claim', { state: 'jti-expired', ttlMs: 60_000 })
    expect(reclaimed.status).toBe(201)
  })
})

describe('OAuthFlowDO.consume - 过期失效', () => {
  it('returns 410 when flow is expired', async () => {
    const { do_, state } = makeDO()
    await post(do_, '/store', { state: 'state-exp', ttlMs: 1 })

    await new Promise((r) => setTimeout(r, 5))

    const res = await post(do_, '/consume', { state: 'state-exp' })
    expect(res.status).toBe(410)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('invalid_request')

    // 过期后 state key 应被删除
    const record = await state.storage.get('state-exp')
    expect(record).toBeUndefined()
  })

  it('alarm clears expired entries', async () => {
    const { do_, state } = makeDO()
    await post(do_, '/store', { state: 'st-alarm', ttlMs: 1 })

    await new Promise((r) => setTimeout(r, 5))

    expect(state.storage.size()).toBe(1)
    await state.triggerAlarm()
    expect(state.storage.size()).toBe(0)
  })
})

describe('OAuthFlowDO.store - pendingParams 存储', () => {
  it('stores and returns pendingParams', async () => {
    const { do_ } = makeDO()
    const pending = {
      clientId: 'client-1',
      redirectUri: 'https://app.example.com/callback',
      scope: 'openid profile',
      responseType: 'code',
      loginHint: 'user@example.com',
    }
    await post(do_, '/store', {
      state: 'state-pending',
      pendingParams: pending,
      ttlMs: 60_000,
    })

    const res = await post(do_, '/consume', { state: 'state-pending' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      record: { pendingParams: typeof pending }
    }
    expect(body.record.pendingParams?.clientId).toBe('client-1')
    expect(body.record.pendingParams?.redirectUri).toBe('https://app.example.com/callback')
  })

  it('stores and returns social OAuth callback payload fields', async () => {
    const { do_ } = makeDO()
    await post(do_, '/store', {
      state: 'state-social',
      tenantId: 'org_default',
      provider: 'localoidc',
      codeVerifier: 'code-verifier-123',
      nonce: 'nonce-social',
      redirectAfterLogin: '/console',
      returnToOrigin: 'https://xid.dev',
      createdAt: 1780640000000,
      ttlMs: 60_000,
    })

    const res = await post(do_, '/consume', { state: 'state-social' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      record: {
        tenantId: string
        provider: string
        codeVerifier: string
        nonce: string
        redirectAfterLogin: string
        returnToOrigin: string
        createdAt: number
      }
    }
    expect(body.record).toMatchObject({
      tenantId: 'org_default',
      provider: 'localoidc',
      codeVerifier: 'code-verifier-123',
      nonce: 'nonce-social',
      redirectAfterLogin: '/console',
      returnToOrigin: 'https://xid.dev',
      createdAt: 1780640000000,
    })
  })

  it('stores and returns enterprise OIDC callback payload fields', async () => {
    const { do_ } = makeDO()
    await post(do_, '/store', {
      state: 'state-enterprise',
      tenantId: 'org_default',
      connectionId: 'conn_enterprise_oidc',
      codeVerifier: 'code-verifier-enterprise',
      nonce: 'nonce-enterprise',
      redirectAfterLogin: '/console',
      returnToOrigin: 'https://xid.dev',
      createdAt: 1780640000000,
      ttlMs: 60_000,
    })

    const res = await post(do_, '/consume', { state: 'state-enterprise' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      record: {
        tenantId: string
        connectionId: string
        codeVerifier: string
        nonce: string
        redirectAfterLogin: string
        returnToOrigin: string
        createdAt: number
      }
    }
    expect(body.record).toMatchObject({
      tenantId: 'org_default',
      connectionId: 'conn_enterprise_oidc',
      codeVerifier: 'code-verifier-enterprise',
      nonce: 'nonce-enterprise',
      redirectAfterLogin: '/console',
      returnToOrigin: 'https://xid.dev',
      createdAt: 1780640000000,
    })
  })
})

describe('OAuthFlowDO.store - alarm 取最早过期', () => {
  it('先长 TTL 后短 TTL,alarm 拉早到短记录的过期时间', async () => {
    const { do_, state } = makeDO()
    await post(do_, '/store', { state: 'st-long', ttlMs: 1_200_000 })
    const afterLong = await state.storage.getAlarm()
    expect(afterLong).not.toBeNull()

    await post(do_, '/store', { state: 'st-short', ttlMs: 1000 })
    const afterShort = await state.storage.getAlarm()
    expect(afterShort).not.toBeNull()
    expect(afterShort as number).toBeLessThan(afterLong as number)
  })

  it('先短 TTL 后长 TTL,alarm 不被长记录推迟', async () => {
    const { do_, state } = makeDO()
    await post(do_, '/store', { state: 'st-short', ttlMs: 1000 })
    const afterShort = await state.storage.getAlarm()

    await post(do_, '/store', { state: 'st-long', ttlMs: 1_200_000 })
    const afterLong = await state.storage.getAlarm()
    expect(afterLong).toBe(afterShort)
  })
})

describe('OAuthFlowDO - 400 on bad JSON', () => {
  it('returns 400 on non-JSON body for store', async () => {
    const { do_ } = makeDO()
    const res = await do_.fetch(new Request('http://do/store', { method: 'POST', body: 'bad' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 on non-JSON body for consume', async () => {
    const { do_ } = makeDO()
    const res = await do_.fetch(new Request('http://do/consume', { method: 'POST', body: 'bad' }))
    expect(res.status).toBe(400)
  })
})

describe('OAuthFlowDO - unknown path', () => {
  it('returns 404 for unknown path', async () => {
    const { do_ } = makeDO()
    const res = await do_.fetch(new Request('http://do/unknown', { method: 'POST' }))
    expect(res.status).toBe(404)
  })
})
