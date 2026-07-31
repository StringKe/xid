// saml-do.ts 单元测试:SAML 一次性 ChallengeStore helper 必须对 DO 故障 fail closed。

import { describe, expect, it, vi } from 'vitest'
import type { Context } from 'hono'
import { ChallengeStore } from '../../durable-objects/challenge-store'
import { MockDurableObjectState } from '../../durable-objects/__tests__/mock-do-state'
import { isAppError } from '../../lib/errors'
import type { XidHonoEnv } from '../../lib/types'
import {
  consumeOnce,
  consumeOutboundLogoutRequestContext,
  isLogoutRequestReplay,
  markOnce,
  releaseLogoutRequestReplay,
  storeOutboundLogoutRequestContext,
} from '../saml-do'

describe('saml-do markOnce', () => {
  it('stores one-time value through ChallengeStore', async () => {
    const calls: unknown[] = []

    await markOnce(makeEnv('/create', new Response(null, { status: 201 }), calls), 'key-1', '1')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ key: 'key-1', value: '1', ttlMs: 600_000 })
  })

  it('fails closed when ChallengeStore create returns non-201', async () => {
    await expectAppError(
      markOnce(makeEnv('/create', new Response('store failed', { status: 500 })), 'key-1', '1'),
    )
  })
})

describe('saml-do consumeOnce', () => {
  it('returns value on 200 ChallengeStore consume', async () => {
    const value = await consumeOnce(
      makeEnv('/consume', Response.json({ value: 'challenge-value' })),
      'key-1',
    )

    expect(value).toBe('challenge-value')
  })

  it('returns null for missing or expired one-time value', async () => {
    await expect(
      consumeOnce(makeEnv('/consume', new Response(null, { status: 404 })), 'key-1'),
    ).resolves.toBeNull()
    await expect(
      consumeOnce(makeEnv('/consume', new Response(null, { status: 410 })), 'key-1'),
    ).resolves.toBeNull()
  })

  it('fails closed when ChallengeStore consume returns unexpected status', async () => {
    await expectAppError(
      consumeOnce(makeEnv('/consume', new Response('store failed', { status: 500 })), 'key-1'),
    )
  })

  it('fails closed when ChallengeStore consume returns non-JSON payload', async () => {
    await expectAppError(
      consumeOnce(makeEnv('/consume', new Response('not json', { status: 200 })), 'key-1'),
    )
  })

  it('fails closed when ChallengeStore consume returns malformed payload', async () => {
    await expectAppError(consumeOnce(makeEnv('/consume', Response.json({ value: '' })), 'key-1'))
  })
})

describe('saml-do outbound SLO state', () => {
  it('stores tenant/app-scoped chain context and consumes it once', async () => {
    const calls: unknown[] = []
    await storeOutboundLogoutRequestContext(
      makeContext(makeEnv('/create', new Response(null, { status: 201 }), calls)),
      {
        appId: 'sp_1',
        requestId: '_request_1',
        sessionIndex: 'session-index',
        relayState: 'https://acme.xid.dev/sign-in',
        returnTo: 'https://acme.xid.dev/sign-in',
        remaining: [{ appId: 'sp_2', sessionIndex: 'next', nameId: 'user', nameIdFormat: 'email' }],
      },
    )
    expect(calls[0]).toMatchObject({
      key: expect.stringMatching(/^saml:outbound-logout:tenant_1:sp_1:_request_1:[0-9a-f]{64}$/),
      value: expect.any(String),
    })

    const stored = (calls[0] as { value: string }).value
    const consumed = await consumeOutboundLogoutRequestContext(
      makeContext(makeEnv('/consume', Response.json({ value: stored }))),
      'sp_1',
      '_request_1',
      'https://acme.xid.dev/sign-in',
    )
    expect(consumed).toMatchObject({
      tenantId: 'tenant_1',
      appId: 'sp_1',
      sessionIndex: 'session-index',
      remaining: [{ appId: 'sp_2', sessionIndex: 'next' }],
    })
  })

  it('returns null for missing chain state and rejects malformed state', async () => {
    await expect(
      consumeOutboundLogoutRequestContext(
        makeContext(makeEnv('/consume', new Response(null, { status: 404 }))),
        'sp_1',
        '_request_1',
        'https://acme.xid.dev/sign-in',
      ),
    ).resolves.toBeNull()
    await expectAppError(
      consumeOutboundLogoutRequestContext(
        makeContext(makeEnv('/consume', Response.json({ value: '{"tenantId":"other"}' }))),
        'sp_1',
        '_request_1',
        'https://acme.xid.dev/sign-in',
      ),
    )
  })

  it('binds consumption to RelayState without burning the legitimate context', async () => {
    const store = makeChallengeStore()
    const context = makeContext(makeChallengeStoreEnv(store))
    await storeOutboundLogoutRequestContext(context, {
      appId: 'sp_1',
      requestId: '_request_relay',
      sessionIndex: 'session-index',
      relayState: 'https://acme.xid.dev/sign-in',
      returnTo: 'https://acme.xid.dev/sign-in',
      remaining: [],
    })

    await expect(
      consumeOutboundLogoutRequestContext(
        context,
        'sp_1',
        '_request_relay',
        'https://attacker.example/changed',
      ),
    ).resolves.toBeNull()
    await expect(
      consumeOutboundLogoutRequestContext(
        context,
        'sp_1',
        '_request_relay',
        'https://acme.xid.dev/sign-in',
      ),
    ).resolves.toMatchObject({
      tenantId: 'tenant_1',
      appId: 'sp_1',
      sessionIndex: 'session-index',
    })
  })

  it('claims LogoutRequest IDs atomically and fails closed on DO errors', async () => {
    const validUntil = Date.now() + 8 * 60 * 1000
    await expect(
      isLogoutRequestReplay(makeContext(makeEnv('/claim', new Response(null, { status: 201 }))), {
        direction: 'inbound',
        scopeId: 'conn_1',
        requestId: '_request_1',
        validUntil,
      }),
    ).resolves.toBe(false)
    await expect(
      isLogoutRequestReplay(makeContext(makeEnv('/claim', new Response(null, { status: 409 }))), {
        direction: 'inbound',
        scopeId: 'conn_1',
        requestId: '_request_1',
        validUntil,
      }),
    ).resolves.toBe(true)
    await expectAppError(
      isLogoutRequestReplay(makeContext(makeEnv('/claim', new Response(null, { status: 500 }))), {
        direction: 'inbound',
        scopeId: 'conn_1',
        requestId: '_request_1',
        validUntil,
      }),
    )
  })

  it('releases only a failed LogoutRequest claim so one retry can claim it again', async () => {
    const context = makeContext(makeChallengeStoreEnv(makeChallengeStore()))
    const input = {
      direction: 'inbound' as const,
      scopeId: 'conn_1',
      requestId: '_request_retry',
      validUntil: Date.now() + 8 * 60 * 1000,
    }

    await expect(isLogoutRequestReplay(context, input)).resolves.toBe(false)
    await expect(isLogoutRequestReplay(context, input)).resolves.toBe(true)

    await releaseLogoutRequestReplay(context, input)

    await expect(isLogoutRequestReplay(context, input)).resolves.toBe(false)
    await expect(isLogoutRequestReplay(context, input)).resolves.toBe(true)
  })

  it('keeps a LogoutRequest replay claim after five minutes until its acceptance deadline', async () => {
    vi.useFakeTimers()
    try {
      const now = Date.parse('2026-07-29T09:00:00Z')
      vi.setSystemTime(now)
      const store = makeChallengeStore()
      const context = makeContext(makeChallengeStoreEnv(store))
      const validUntil = now + 8 * 60 * 1000

      await expect(
        isLogoutRequestReplay(context, {
          direction: 'inbound',
          scopeId: 'conn_1',
          requestId: '_request_long_lived',
          validUntil,
        }),
      ).resolves.toBe(false)

      vi.setSystemTime(now + 5 * 60 * 1000 + 1)
      await expect(
        isLogoutRequestReplay(context, {
          direction: 'inbound',
          scopeId: 'conn_1',
          requestId: '_request_long_lived',
          validUntil,
        }),
      ).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails closed instead of silently falling back when the replay deadline exceeds ten minutes', async () => {
    await expectAppError(
      isLogoutRequestReplay(makeContext(makeEnv('/claim', new Response(null, { status: 201 }))), {
        direction: 'outbound',
        scopeId: 'sp_1',
        requestId: '_request_too_long',
        validUntil: Date.now() + 10 * 60 * 1000 + 1,
      }),
    )
  })
})

function makeChallengeStore(): ChallengeStore {
  const state = new MockDurableObjectState()
  const store = new ChallengeStore(state as unknown as DurableObjectState)
  state.setAlarmHandler(() => store.alarm())
  return store
}

function makeChallengeStoreEnv(store: ChallengeStore): Env {
  return {
    WEBAUTHN_CHALLENGE: {
      idFromName: () => ({ toString: () => 'challenge-id' }) as DurableObjectId,
      get: () =>
        ({
          fetch: (input: string | Request, init?: RequestInit) =>
            store.fetch(new Request(typeof input === 'string' ? input : input.url, init)),
        }) as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace,
  } as unknown as Env
}

function makeEnv(path: string, response: Response, calls: unknown[] = []): Env {
  return {
    WEBAUTHN_CHALLENGE: {
      idFromName: () => ({ toString: () => 'challenge-id' }) as DurableObjectId,
      get: () =>
        ({
          fetch: async (input: string | Request, init?: RequestInit) => {
            const url = new URL(typeof input === 'string' ? input : input.url)
            if (url.pathname !== path) return new Response(null, { status: 404 })
            if (init?.body) calls.push(JSON.parse(init.body as string))
            return response
          },
        }) as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace,
  } as unknown as Env
}

function makeContext(env: Env): Context<XidHonoEnv> {
  return {
    env,
    get: (key: string) =>
      key === 'tenant'
        ? {
            tenantId: 'tenant_1',
            issuer: 'https://acme.xid.dev',
            rpId: 'acme.xid.dev',
            signingKeys: { activeKid: 'key_1', defaultAlg: 'ES256', keys: [] },
            policy: {},
          }
        : undefined,
  } as unknown as Context<XidHonoEnv>
}

async function expectAppError(promise: Promise<unknown>): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (err) {
    caught = err
  }

  expect(isAppError(caught)).toBe(true)
  if (isAppError(caught)) expect(caught.code).toBe('server_error')
}
