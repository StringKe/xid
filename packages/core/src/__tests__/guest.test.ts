import { describe, expect, it } from 'vitest'

import { XidClient } from '../client'
import { isGuestToken, isGuestUser, isSameUser } from '../guest'
import { decodeTokenClaims } from '../jwt-decode'
import { makeFetch, makeJwt, makeState, makeUser, type RouteHandler } from './fixtures'

function client(routes: Record<string, RouteHandler>) {
  const fetcher = makeFetch(routes)
  return { fetcher, instance: new XidClient({ fetcher, now: () => 1000 }) }
}

describe('XidClient.signInAnonymously', () => {
  it('reuses the existing session without a request when already signed in', async () => {
    const { fetcher, instance } = client({
      '/v1/me': () => ({ status: 200, json: { data: makeState() } }),
    })
    await instance.load()

    const result = await instance.signInAnonymously()

    expect(result.ok).toBe(true)
    expect(fetcher.calls.map((call) => call.path)).toEqual(['/v1/me'])
  })

  it('posts /auth/guest with the turnstile token and refreshes state', async () => {
    const { fetcher, instance } = client({
      '/auth/guest': () => ({ status: 201, json: null }),
      '/v1/me': () => ({
        status: 200,
        json: {
          user: {
            id: 'user_guest',
            provisioned_by: 'anonymous',
          },
          activeOrg: null,
          organizations: [],
          session: {
            id: 'sess_guest',
            expiresAt: '2030-01-01T00:00:00.000Z',
            isImpersonation: false,
          },
        },
      }),
    })

    const result = await instance.signInAnonymously({ turnstileToken: 'ts_token' })

    expect(result.ok).toBe(true)
    expect(instance.isSignedIn).toBe(true)
    expect(instance.user?.id).toBe('user_guest')
    expect(instance.user?.provisionedBy).toBe('anonymous')
    expect(instance.isAnonymous).toBe(true)
    expect(fetcher.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /auth/guest',
      'GET /v1/me',
    ])
  })

  it('returns the error and keeps the signed-out state when the request fails', async () => {
    const { fetcher, instance } = client({
      '/auth/guest': () => ({
        status: 429,
        json: { error: { code: 'rate_limited', message: 'slow down', httpStatus: 429 } },
      }),
    })

    const result = await instance.signInAnonymously()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('rate_limited')
    expect(instance.isSignedIn).toBe(false)
    // 失败路径不得触发状态重拉。
    expect(fetcher.calls.map((call) => call.path)).toEqual(['/auth/guest'])
  })

  it('treats a non-guest user as not anonymous after refresh', async () => {
    const { instance } = client({
      '/auth/guest': () => ({ status: 200, json: null }),
      '/v1/me': () => ({ status: 200, json: { data: makeState() } }),
    })

    await instance.signInAnonymously()

    expect(instance.isAnonymous).toBe(false)
  })
})

describe('isGuestUser', () => {
  it('matches only provisionedBy === anonymous', () => {
    expect(isGuestUser(makeUser({ provisionedBy: 'anonymous' }))).toBe(true)
    expect(isGuestUser(makeUser())).toBe(false)
    expect(isGuestUser(makeUser({ provisionedBy: 'password' }))).toBe(false)
    expect(isGuestUser(null)).toBe(false)
    expect(isGuestUser(undefined)).toBe(false)
  })
})

describe('isGuestToken', () => {
  it('reads the amr claim from a decoded token', () => {
    const claims = decodeTokenClaims(makeJwt({ sub: 'user_1', amr: ['guest'] }))
    expect(claims?.amr).toEqual(['guest'])
    expect(isGuestToken(claims)).toBe(true)
    expect(isGuestToken(decodeTokenClaims(makeJwt({ sub: 'user_1', amr: ['pwd'] })))).toBe(false)
    expect(isGuestToken(decodeTokenClaims(makeJwt({ sub: 'user_1' })))).toBe(false)
    expect(isGuestToken(null)).toBe(false)
  })
})

describe('isSameUser', () => {
  it('detects the guest sub -> account sub switch for data merge', () => {
    expect(isSameUser('user_guest', 'user_guest')).toBe(true)
    expect(isSameUser('user_guest', 'user_full')).toBe(false)
    expect(isSameUser(null, 'user_full')).toBe(false)
    expect(isSameUser('user_guest', null)).toBe(false)
    expect(isSameUser(undefined, undefined)).toBe(false)
  })
})
