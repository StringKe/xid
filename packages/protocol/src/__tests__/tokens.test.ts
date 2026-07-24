// buildIdTokenClaims / buildAccessTokenClaims / signClaims 正例 + claims 条件组合。
// issuer/签名 kid 从 TenantContext 取(tenant-context rule);amr passkey=phr / OTP=otp。
import { describe, it, expect } from 'vitest'
import { importJwkForVerify, verifyJwt } from '@xid-kit/crypto'

import {
  buildIdTokenClaims,
  buildAccessTokenClaims,
  signClaims,
  signAccessTokenClaims,
  leftHalfHash,
} from '../tokens'
import { buildTestTenant } from './fixtures/tenant'

const NOW = 1_900_000_000

describe('buildIdTokenClaims', () => {
  it('uses TenantContext issuer and required claims', async () => {
    const { ctx } = await buildTestTenant({ issuer: 'https://acme.xid.dev' })
    const claims = buildIdTokenClaims({
      ctx,
      subject: { userId: 'user_1' },
      clientId: 'client_1',
      authContext: { amr: ['phr'], authTime: NOW - 10, nonce: 'n1' },
      scope: 'openid',
      now: NOW,
      ttlSec: 3600,
    })
    expect(claims.iss).toBe('https://acme.xid.dev')
    expect(claims.sub).toBe('user_1')
    expect(claims.aud).toBe('client_1')
    expect(claims.exp).toBe(NOW + 3600)
    expect(claims.iat).toBe(NOW)
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/)
    expect(claims.amr).toEqual(['phr'])
    expect(claims.nonce).toBe('n1')
    expect(claims.auth_time).toBe(NOW - 10)
  })

  it('omits email/name when scope does not grant them', async () => {
    const { ctx } = await buildTestTenant()
    const claims = buildIdTokenClaims({
      ctx,
      subject: { userId: 'u', email: 'a@b.c', name: 'A B' },
      clientId: 'c',
      authContext: { amr: ['otp'] },
      scope: 'openid',
      now: NOW,
      ttlSec: 600,
    })
    expect(claims.email).toBeUndefined()
    expect(claims.name).toBeUndefined()
    expect(claims.amr).toEqual(['otp'])
  })

  it('includes email/name when scopes present', async () => {
    const { ctx } = await buildTestTenant()
    const claims = buildIdTokenClaims({
      ctx,
      subject: { userId: 'u', email: 'a@b.c', emailVerified: true, name: 'A B' },
      clientId: 'c',
      authContext: {},
      scope: 'openid email profile',
      now: NOW,
      ttlSec: 600,
    })
    expect(claims.email).toBe('a@b.c')
    expect(claims.email_verified).toBe(true)
    expect(claims.name).toBe('A B')
  })

  it('writes sid only when authContext carries a session id', async () => {
    const { ctx } = await buildTestTenant()
    const withSid = buildIdTokenClaims({
      ctx,
      subject: { userId: 'u' },
      clientId: 'c',
      authContext: { sid: 's_1' },
      scope: 'openid',
      now: NOW,
      ttlSec: 600,
    })
    expect(withSid.sid).toBe('s_1')
    const withoutSid = buildIdTokenClaims({
      ctx,
      subject: { userId: 'u' },
      clientId: 'c',
      authContext: {},
      scope: 'openid',
      now: NOW,
      ttlSec: 600,
    })
    expect(withoutSid.sid).toBeUndefined()
  })
})

describe('buildAccessTokenClaims', () => {
  it('binds tenant_id from TenantContext', async () => {
    const { ctx } = await buildTestTenant({ tenantId: 'tenant_a' })
    const claims = buildAccessTokenClaims({
      ctx,
      subject: { userId: 'u1' },
      clientId: 'c1',
      scope: 'openid',
      audience: 'c1',
      now: NOW,
      ttlSec: 3600,
    })
    expect(claims.tenant_id).toBe('tenant_a')
  })

  it('sets nbf/azp/scope/client_id and cnf.jkt when DPoP bound', async () => {
    const { ctx } = await buildTestTenant()
    const claims = buildAccessTokenClaims({
      ctx,
      subject: { userId: 'u1' },
      clientId: 'c1',
      scope: 'openid profile',
      audience: 'c1',
      now: NOW,
      ttlSec: 3600,
      options: { cnf: { jkt: 'thumb123' } },
    })
    expect(claims.nbf).toBe(NOW)
    expect(claims.azp).toBe('c1')
    expect(claims.scope).toBe('openid profile')
    expect(claims.client_id).toBe('c1')
    expect(claims.cnf?.jkt).toBe('thumb123')
  })

  it('sets RFC9396 authorization_details when provided', async () => {
    const { ctx } = await buildTestTenant()
    const authorizationDetails = [
      {
        type: 'resource_access' as const,
        locations: ['https://api.example/v1'],
        actions: ['read'],
      },
    ]
    const claims = buildAccessTokenClaims({
      ctx,
      subject: { userId: 'u1' },
      clientId: 'c1',
      scope: 'openid read',
      audience: 'https://api.example/v1',
      now: NOW,
      ttlSec: 3600,
      options: { authorizationDetails },
    })
    expect(claims.authorization_details).toEqual(authorizationDetails)
  })
})

describe('signClaims round-trip', () => {
  it('signs with TenantContext active kid and default JWT typ', async () => {
    const { ctx, signingKey } = await buildTestTenant()
    const claims = buildAccessTokenClaims({
      ctx,
      subject: { userId: 'u1' },
      clientId: 'c1',
      scope: 'openid',
      audience: 'c1',
      now: Math.floor(Date.now() / 1000),
      ttlSec: 3600,
    })
    const token = await signClaims(ctx, signingKey, claims)
    const material = ctx.signingKeys.keys[0]!
    const publicKey = await importJwkForVerify({
      ...material.publicKeyJwk,
      kid: material.kid,
      use: 'sig',
      alg: material.alg,
    })
    const result = await verifyJwt(
      token,
      { alg: 'ES256', publicKey },
      { expectedIssuer: ctx.issuer, expectedAudience: 'c1' },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.header.kid).toBe(ctx.signingKeys.activeKid)
      expect(result.value.header.typ).toBe('JWT')
      expect(result.value.payload.scope).toBe('openid')
    }
  })

  it('signs access token claims with RFC9068 typ', async () => {
    const { ctx, signingKey } = await buildTestTenant()
    const claims = buildAccessTokenClaims({
      ctx,
      subject: { userId: 'u1' },
      clientId: 'c1',
      scope: 'openid profile',
      audience: 'https://api.example.com',
      now: Math.floor(Date.now() / 1000),
      ttlSec: 3600,
    })

    const token = await signAccessTokenClaims(ctx, signingKey, claims)

    const material = ctx.signingKeys.keys[0]!
    const publicKey = await importJwkForVerify({
      ...material.publicKeyJwk,
      kid: material.kid,
      use: 'sig',
      alg: material.alg,
    })
    const result = await verifyJwt(
      token,
      { alg: 'ES256', publicKey },
      { expectedIssuer: ctx.issuer, expectedAudience: 'https://api.example.com' },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.header.typ).toBe('at+jwt')
      expect(result.value.payload.client_id).toBe('c1')
    }
  })
})

describe('leftHalfHash', () => {
  it('produces base64url without padding', async () => {
    const h = await leftHalfHash('some-access-token')
    expect(h).not.toContain('=')
    expect(h).not.toContain('+')
    expect(h).not.toContain('/')
  })
})
