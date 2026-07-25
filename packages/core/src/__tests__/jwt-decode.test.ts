import { describe, expect, it } from 'vitest'

import { decodeTokenClaims, isTokenExpiring } from '../jwt-decode'

function makeToken(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown): string =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64url({ alg: 'ES256', kid: 'k1' })}.${b64url(payload)}.${b64url('sig')}`
}

describe('decodeTokenClaims', () => {
  it('decodes exp and sub from a well-formed token payload', () => {
    const token = makeToken({ exp: 1700, sub: 'user_1', sid: 'sess_1' })

    const claims = decodeTokenClaims(token)

    expect(claims).toEqual({ exp: 1700, sub: 'user_1', sid: 'sess_1' })
  })

  it('returns null for a token without three segments', () => {
    const claims = decodeTokenClaims('not-a-jwt')

    expect(claims).toBeNull()
  })

  it('returns null when the payload is not valid base64url json', () => {
    const claims = decodeTokenClaims('h.@@@.s')

    expect(claims).toBeNull()
  })
})

describe('isTokenExpiring', () => {
  it('reports expiring when now plus leeway crosses exp', () => {
    const token = makeToken({ exp: 1000 })

    expect(isTokenExpiring(token, 991, 10)).toBe(true)
  })

  it('reports not expiring when comfortably before exp', () => {
    const token = makeToken({ exp: 1000 })

    expect(isTokenExpiring(token, 900, 10)).toBe(false)
  })

  it('treats a token without exp as expiring', () => {
    const token = makeToken({ sub: 'user_1' })

    expect(isTokenExpiring(token, 0, 10)).toBe(true)
  })
})
