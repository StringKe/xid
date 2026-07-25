import { describe, expect, it } from 'vitest'

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

  it('authenticates from the session cookie when no header is present', async () => {
    const key = await makeEs256Key('kid_1')
    const token = await mintToken(key, payload())
    const request = new Request('https://app.example.com/api', {
      headers: { cookie: `__session=${token}; other=1` },
    })

    const state = await authenticateRequest(request, { jwtKey: key.publicJwk, now: NOW })

    expect(state.isSignedIn).toBe(true)
  })

  it('honors a custom cookie name', async () => {
    const key = await makeEs256Key('kid_1')
    const token = await mintToken(key, payload())
    const request = new Request('https://app.example.com/api', {
      headers: { cookie: `__xid_session=${token}` },
    })

    const state = await authenticateRequest(request, {
      jwtKey: key.publicJwk,
      cookieName: '__xid_session',
      now: NOW,
    })

    expect(state.isSignedIn).toBe(true)
  })

  it('prefers the Authorization header over the cookie', async () => {
    const headerKey = await makeEs256Key('kid_header')
    const cookieKey = await makeEs256Key('kid_cookie')
    const headerToken = await mintToken(headerKey, payload({ sub: 'header_user' }))
    const cookieToken = await mintToken(cookieKey, payload({ sub: 'cookie_user' }))
    const request = new Request('https://app.example.com/api', {
      headers: { authorization: `Bearer ${headerToken}`, cookie: `__session=${cookieToken}` },
    })

    const state = await authenticateRequest(request, { jwtKey: headerKey.publicJwk, now: NOW })

    expect(state.isSignedIn).toBe(true)
    if (state.isSignedIn) {
      expect(state.userId).toBe('header_user')
    }
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
