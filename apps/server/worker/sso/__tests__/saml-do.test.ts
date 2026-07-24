// saml-do.ts 单元测试:SAML 一次性 ChallengeStore helper 必须对 DO 故障 fail closed。

import { describe, expect, it } from 'vitest'
import { isAppError } from '../../lib/errors'
import { consumeOnce, markOnce } from '../saml-do'

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
