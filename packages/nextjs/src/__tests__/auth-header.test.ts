// auth-header 序列化/反序列化单元测试(含 HMAC 签名纵深防御)。
import { describe, it, expect } from 'vitest'
import { serializeAuthHeader, parseAuthHeader, readAuthFromHeaders } from '../auth-header'
import type { AuthObject, UnauthenticatedAuthObject } from '../types'

const UNAUTHENTICATED: UnauthenticatedAuthObject = {
  userId: null,
  sessionId: null,
  orgId: null,
  orgRole: null,
  orgPermissions: null,
  claims: null,
}

const MOCK_CLAIMS = {
  iss: 'https://test.xid.dev',
  sub: 'user_123',
  aud: 'client_abc',
  exp: 9999999999,
  iat: 1000000000,
  jti: 'jti_abc',
  nbf: 1000000000,
  azp: 'client_abc',
  scope: 'openid profile',
  client_id: 'client_abc',
}

const AUTH_OBJ: AuthObject = {
  userId: 'user_123',
  sessionId: 'sess_456',
  orgId: 'org_789',
  orgRole: 'admin',
  orgPermissions: ['read', 'write'],
  claims: MOCK_CLAIMS,
}

const SECRET = 'test-hmac-secret-32-bytes-minimum-len'

describe('serializeAuthHeader / parseAuthHeader (unsigned)', () => {
  it('round-trips authenticated state', async () => {
    const raw = await serializeAuthHeader(AUTH_OBJ)
    expect(await parseAuthHeader(raw)).toEqual(AUTH_OBJ)
  })

  it('fails closed when the serialized Organization role is not a membership role', async () => {
    const raw = JSON.stringify({ ...AUTH_OBJ, orgRole: 'viewer' })

    expect(await parseAuthHeader(raw)).toEqual(UNAUTHENTICATED)
  })

  it('round-trips unauthenticated state', async () => {
    const raw = await serializeAuthHeader(UNAUTHENTICATED)
    expect(await parseAuthHeader(raw)).toEqual(UNAUTHENTICATED)
  })

  it('returns unauthenticated for null input', async () => {
    expect(await parseAuthHeader(null)).toEqual(UNAUTHENTICATED)
  })

  it('returns unauthenticated for invalid JSON', async () => {
    expect(await parseAuthHeader('not-json')).toEqual(UNAUTHENTICATED)
  })

  it('returns unauthenticated for empty string', async () => {
    expect(await parseAuthHeader('')).toEqual(UNAUTHENTICATED)
  })
})

describe('serializeAuthHeader / parseAuthHeader (signed, HMAC defense-in-depth)', () => {
  it('round-trips signed authenticated state with matching secret', async () => {
    const raw = await serializeAuthHeader(AUTH_OBJ, SECRET)
    expect(raw.startsWith('v1.')).toBe(true)
    expect(await parseAuthHeader(raw, SECRET)).toEqual(AUTH_OBJ)
  })

  it('rejects an unsigned (forged) header when secret is configured', async () => {
    // 攻击者伪造纯 JSON 头,server 配置了 secret -> 无有效签名,按未认证处理。
    const forged = JSON.stringify(AUTH_OBJ)
    expect(await parseAuthHeader(forged, SECRET)).toEqual(UNAUTHENTICATED)
  })

  it('rejects a tampered payload (signature mismatch)', async () => {
    const raw = await serializeAuthHeader(AUTH_OBJ, SECRET)
    // 篡改 payload 部分(替换 user id 的 base64 片段)使签名失配。
    const tampered = raw.replace('v1.', 'v1.AAAA')
    expect(await parseAuthHeader(tampered, SECRET)).toEqual(UNAUTHENTICATED)
  })

  it('rejects a header signed with a different secret', async () => {
    const raw = await serializeAuthHeader(AUTH_OBJ, 'attacker-secret')
    expect(await parseAuthHeader(raw, SECRET)).toEqual(UNAUTHENTICATED)
  })

  it('rejects a signed envelope with empty signature', async () => {
    const raw = await serializeAuthHeader(AUTH_OBJ, SECRET)
    const noSig = raw.slice(0, raw.lastIndexOf('.') + 1)
    expect(await parseAuthHeader(noSig, SECRET)).toEqual(UNAUTHENTICATED)
  })
})

describe('readAuthFromHeaders', () => {
  it('reads authenticated state from Headers', async () => {
    const raw = await serializeAuthHeader(AUTH_OBJ)
    const headers = new Headers({ 'x-xid-auth': raw })
    expect(await readAuthFromHeaders(headers)).toEqual(AUTH_OBJ)
  })

  it('reads signed authenticated state with secret', async () => {
    const raw = await serializeAuthHeader(AUTH_OBJ, SECRET)
    const headers = new Headers({ 'x-xid-auth': raw })
    expect(await readAuthFromHeaders(headers, SECRET)).toEqual(AUTH_OBJ)
  })

  it('returns unauthenticated when header missing', async () => {
    expect(await readAuthFromHeaders(new Headers())).toEqual(UNAUTHENTICATED)
  })
})
