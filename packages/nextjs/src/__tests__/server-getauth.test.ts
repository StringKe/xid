// getAuth(req) Pages adapter（含伪造头拒绝）。
import { describe, it, expect, afterEach } from 'vitest'
import { getAuth } from '../server'
import { serializeAuthHeader } from '../auth-header'
import type { AuthObject } from '../types'

const MOCK_CLAIMS = {
  iss: 'https://test.xid.dev',
  sub: 'user_abc',
  aud: 'client_xyz',
  exp: 9999999999,
  iat: 1000000000,
  jti: 'jti_xyz',
  nbf: 1000000000,
  azp: 'client_xyz',
  scope: 'openid',
  client_id: 'client_xyz',
}

const SIGNED_IN: AuthObject = {
  userId: 'user_abc',
  sessionId: 'sess_001',
  orgId: undefined,
  orgRole: undefined,
  orgPermissions: undefined,
  claims: MOCK_CLAIMS,
}

const SECRET = 'server-getauth-hmac-secret'

afterEach(() => {
  delete process.env['XID_AUTH_HMAC_SECRET']
})

describe('getAuth (unsigned, deployment-layer trust)', () => {
  it('parses auth from standard Request', async () => {
    const raw = await serializeAuthHeader(SIGNED_IN)
    const req = new Request('http://localhost/', { headers: { 'x-xid-auth': raw } })
    expect(await getAuth(req)).toEqual(SIGNED_IN)
  })

  it('returns unauthenticated when header absent (standard Request)', async () => {
    const result = await getAuth(new Request('http://localhost/'))
    expect(result.userId).toBeNull()
  })

  it('parses auth from Pages Router IncomingMessage-like object', async () => {
    const raw = await serializeAuthHeader(SIGNED_IN)
    const result = await getAuth({ headers: { 'x-xid-auth': raw } })
    expect(result).toEqual(SIGNED_IN)
  })

  it('returns unauthenticated for Pages Router req with no header', async () => {
    const result = await getAuth({ headers: {} })
    expect(result.userId).toBeNull()
  })
})

describe('getAuth (signed via XID_AUTH_HMAC_SECRET, forgery rejected)', () => {
  it('accepts a header signed by middleware with the same secret', async () => {
    process.env['XID_AUTH_HMAC_SECRET'] = SECRET
    const raw = await serializeAuthHeader(SIGNED_IN, SECRET)
    const req = new Request('http://localhost/', { headers: { 'x-xid-auth': raw } })
    expect(await getAuth(req)).toEqual(SIGNED_IN)
  })

  it('rejects an attacker-forged unsigned x-xid-auth header', async () => {
    process.env['XID_AUTH_HMAC_SECRET'] = SECRET
    // 绕过 middleware 注入的纯 JSON 无有效 HMAC，必须未认证。
    const forged = JSON.stringify(SIGNED_IN)
    const req = new Request('http://localhost/', { headers: { 'x-xid-auth': forged } })
    const result = await getAuth(req)
    expect(result.userId).toBeNull()
  })

  it('rejects a header signed with a different secret', async () => {
    process.env['XID_AUTH_HMAC_SECRET'] = SECRET
    const raw = await serializeAuthHeader(SIGNED_IN, 'wrong-secret')
    const req = new Request('http://localhost/', { headers: { 'x-xid-auth': raw } })
    const result = await getAuth(req)
    expect(result.userId).toBeNull()
  })
})
