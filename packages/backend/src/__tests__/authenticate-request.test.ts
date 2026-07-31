import { describe, expect, it, vi } from 'vitest'

import { authenticateRequest } from '../authenticate-request'
import { makeEs256Key, mintToken, type TestKey } from './test-keys'

const NOW = 1_700_000_000

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://acme.xid.dev',
    sub: 'user_123',
    aud: 'client_abc',
    azp: 'client_abc',
    sid: 'sess_xyz',
    exp: NOW + 60,
    iat: NOW - 5,
    nbf: NOW - 5,
    jti: 'jti_1',
    scope: 'openid',
    client_id: 'client_abc',
    ...overrides,
  }
}

describe('authenticateRequest', () => {
  it('authenticates from Authorization Bearer header', async () => {
    const key: TestKey = await makeEs256Key('kid_1')
    const token = await mintToken(key, payload())
    const request = new Request('https://app.example.com/api', {
      headers: { authorization: `Bearer ${token}` },
    })

    const state = await authenticateRequest(request, { jwtKey: key.publicJwk, now: NOW })

    expect(state.isSignedIn).toBe(true)
    if (state.isSignedIn) {
      expect(state.userId).toBe('user_123')
      expect(state.sessionId).toBe('sess_xyz')
    }
  })

  it('does not treat the legacy __session cookie as a JWT by default', async () => {
    const key = await makeEs256Key('kid_1')
    const token = await mintToken(key, payload())
    const request = new Request('https://app.example.com/api', {
      headers: { cookie: `__session=${token}; other=1` },
    })

    const state = await authenticateRequest(request, { jwtKey: key.publicJwk, now: NOW })

    expect(state).toEqual({ isSignedIn: false, reason: 'no_token' })
  })

  it('honors an explicitly configured application JWT cookie', async () => {
    const key = await makeEs256Key('kid_1')
    const token = await mintToken(key, payload())
    const request = new Request('https://app.example.com/api', {
      headers: { cookie: `__Host-app.xid.jwt=${token}` },
    })

    const state = await authenticateRequest(request, {
      jwtKey: key.publicJwk,
      jwtCookieName: '__Host-app.xid.jwt',
      now: NOW,
    })

    expect(state.isSignedIn).toBe(true)
  })

  it('prefers the Authorization header over the application JWT cookie', async () => {
    const headerKey = await makeEs256Key('kid_header')
    const cookieKey = await makeEs256Key('kid_cookie')
    const headerToken = await mintToken(headerKey, payload({ sub: 'header_user' }))
    const cookieToken = await mintToken(cookieKey, payload({ sub: 'cookie_user' }))
    const request = new Request('https://app.example.com/api', {
      headers: {
        authorization: `Bearer ${headerToken}`,
        cookie: `__Host-app.xid.jwt=${cookieToken}`,
      },
    })

    const state = await authenticateRequest(request, {
      jwtKey: headerKey.publicJwk,
      jwtCookieName: '__Host-app.xid.jwt',
      now: NOW,
    })

    expect(state.isSignedIn).toBe(true)
    if (state.isSignedIn) {
      expect(state.userId).toBe('header_user')
    }
  })

  it('exchanges an opaque Core cookie at an exact same-origin endpoint before verifying', async () => {
    const key = await makeEs256Key('kid_exchange')
    const token = await mintToken(key, payload({ sub: 'exchanged_user' }))
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://app.example.com/v1/sessions/token')
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('cookie')).toBe(
        '__Host-xid.rt.sess_xyz=opaque-refresh; __Host-xid.active=sess_xyz',
      )
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      expect(init?.redirect).toBe('manual')
      return Response.json({ token })
    })
    const request = new Request('https://app.example.com/api', {
      headers: {
        cookie: '__Host-xid.rt.sess_xyz=opaque-refresh; __Host-xid.active=sess_xyz',
      },
    })

    const state = await authenticateRequest(request, {
      jwtKey: key.publicJwk,
      now: NOW,
      sessionTokenExchange: {
        endpoint: '/v1/sessions/token',
        fetcher: fetcher as typeof fetch,
      },
    })

    expect(state.isSignedIn).toBe(true)
    if (state.isSignedIn) {
      expect(state.userId).toBe('exchanged_user')
    }
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('never sends Core cookies to a cross-origin exchange endpoint', async () => {
    const key = await makeEs256Key('kid_exchange_origin')
    const fetcher = vi.fn()
    const request = new Request('https://app.example.com/api', {
      headers: { cookie: '__Host-xid.rt.sess_xyz=opaque-refresh' },
    })

    await expect(
      authenticateRequest(request, {
        jwtKey: key.publicJwk,
        now: NOW,
        sessionTokenExchange: {
          endpoint: 'https://xid.dev/v1/sessions/token',
          fetcher: fetcher as typeof fetch,
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_options' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    '/v1/sessions/token?target=other',
    '/v1/sessions/token#fragment',
    '/v1/sessions/other',
    'https://user@app.example.com/v1/sessions/token',
  ])(
    'never sends Core cookies to an invalid same-origin exchange endpoint: %s',
    async (endpoint) => {
      const key = await makeEs256Key('kid_exchange_endpoint')
      const fetcher = vi.fn()
      const request = new Request('https://app.example.com/api', {
        headers: { cookie: '__Host-xid.rt.sess_xyz=opaque-refresh' },
      })

      await expect(
        authenticateRequest(request, {
          jwtKey: key.publicJwk,
          now: NOW,
          sessionTokenExchange: {
            endpoint,
            fetcher: fetcher as typeof fetch,
          },
        }),
      ).rejects.toMatchObject({ code: 'invalid_options' })
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it('returns session_rejected when Core rejects the opaque session', async () => {
    const key = await makeEs256Key('kid_exchange_rejected')
    const request = new Request('https://app.example.com/api', {
      headers: { cookie: '__Host-xid.rt.sess_xyz=opaque-refresh' },
    })

    const state = await authenticateRequest(request, {
      jwtKey: key.publicJwk,
      now: NOW,
      sessionTokenExchange: {
        fetcher: vi.fn(async () => new Response(null, { status: 401 })) as typeof fetch,
      },
    })

    expect(state).toEqual({ isSignedIn: false, reason: 'session_rejected' })
  })

  it('fails closed when Core returns a malformed session-token response', async () => {
    const key = await makeEs256Key('kid_exchange_invalid')
    const request = new Request('https://app.example.com/api', {
      headers: { cookie: '__Host-xid.rt.sess_xyz=opaque-refresh' },
    })

    await expect(
      authenticateRequest(request, {
        jwtKey: key.publicJwk,
        now: NOW,
        sessionTokenExchange: {
          fetcher: vi.fn(async () => Response.json({ jwt: 'wrong-field' })) as typeof fetch,
        },
      }),
    ).rejects.toMatchObject({ code: 'session_token_exchange_failed' })
  })

  it('fails closed when Core returns extra session-token response fields', async () => {
    const key = await makeEs256Key('kid_exchange_extra_field')
    const request = new Request('https://app.example.com/api', {
      headers: { cookie: '__Host-xid.rt.sess_xyz=opaque-refresh' },
    })

    await expect(
      authenticateRequest(request, {
        jwtKey: key.publicJwk,
        now: NOW,
        sessionTokenExchange: {
          fetcher: vi.fn(async () =>
            Response.json({ token: 'not-accepted', expireAt: NOW + 60 }),
          ) as typeof fetch,
        },
      }),
    ).rejects.toMatchObject({ code: 'session_token_exchange_failed' })
  })

  it('fails closed when Core returns a whitespace-only session token', async () => {
    const key = await makeEs256Key('kid_exchange_empty_token')
    const request = new Request('https://app.example.com/api', {
      headers: { cookie: '__Host-xid.rt.sess_xyz=opaque-refresh' },
    })

    await expect(
      authenticateRequest(request, {
        jwtKey: key.publicJwk,
        now: NOW,
        sessionTokenExchange: {
          fetcher: vi.fn(async () => Response.json({ token: '   ' })) as typeof fetch,
        },
      }),
    ).rejects.toMatchObject({ code: 'session_token_exchange_failed' })
  })

  it('returns no_token when neither header nor cookie carries a token', async () => {
    const key = await makeEs256Key('kid_1')
    const request = new Request('https://app.example.com/api')

    const state = await authenticateRequest(request, { jwtKey: key.publicJwk, now: NOW })

    expect(state).toEqual({ isSignedIn: false, reason: 'no_token' })
  })

  it('returns the verification failure reason for an expired token', async () => {
    const key = await makeEs256Key('kid_1')
    const token = await mintToken(key, payload({ exp: NOW - 120 }))
    const request = new Request('https://app.example.com/api', {
      headers: { authorization: `Bearer ${token}` },
    })

    const state = await authenticateRequest(request, { jwtKey: key.publicJwk, now: NOW })

    expect(state).toEqual({ isSignedIn: false, reason: 'expired' })
  })

  it('ignores a non-Bearer Authorization scheme', async () => {
    const key = await makeEs256Key('kid_1')
    const request = new Request('https://app.example.com/api', {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    })

    const state = await authenticateRequest(request, { jwtKey: key.publicJwk, now: NOW })

    expect(state).toEqual({ isSignedIn: false, reason: 'no_token' })
  })
})
