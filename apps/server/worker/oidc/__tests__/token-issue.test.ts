import { describe, it, expect } from 'vitest'
import { DEFAULT_TOKEN_POLICY } from '@xid-kit/types'
import type { TenantContext, TokenPolicy } from '@xid-kit/types'

import {
  accessOptions,
  accessTtl,
  fail,
  tokenResponseBody,
  tokenType,
  type TokenContext,
} from '../token-issue'

function makeTenant(token?: TokenPolicy): TenantContext {
  return {
    tenantId: 't_1',
    issuer: 'https://acme.xid.dev',
    rpId: 'acme.xid.dev',
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: token === undefined ? {} : { token },
  }
}

function makeTokenContext(over: Partial<TokenContext> = {}, token?: TokenPolicy): TokenContext {
  const tenant = makeTenant(token)
  return {
    c: {
      get: (key: string) => (key === 'tenant' ? tenant : undefined),
    } as unknown as TokenContext['c'],
    signer: {} as TokenContext['signer'],
    client: { accessTokenTtlSec: null } as unknown as TokenContext['client'],
    clientId: 'client_1',
    dpopJkt: null,
    mtlsCertThumbprint: null,
    form: {},
    now: 1_700_000_000_000,
    ...over,
  }
}

describe('token-issue helpers', () => {
  it('tokenType selects DPoP when jkt is present', () => {
    expect(tokenType('thumbprint')).toBe('DPoP')
    expect(tokenType(null)).toBe('Bearer')
  })

  it('accessTtl: client 覆盖 > 租户 token 策略 > 内置默认', () => {
    const policy: TokenPolicy = { ...DEFAULT_TOKEN_POLICY, accessTokenTtlSec: 7200 }
    // client 未覆盖 -> 走租户 token 策略
    expect(accessTtl(makeTokenContext({}, policy))).toBe(7200)
    // client 覆盖优先于租户策略
    expect(
      accessTtl(
        makeTokenContext({ client: { accessTokenTtlSec: 120 } as TokenContext['client'] }, policy),
      ),
    ).toBe(120)
    // 两层都未设 -> 内置默认
    expect(accessTtl(makeTokenContext())).toBe(DEFAULT_TOKEN_POLICY.accessTokenTtlSec)
  })

  it('fail returns structured XidError result', () => {
    expect(fail('invalid_grant', 'bad token', 401)).toEqual({
      ok: false,
      error: { code: 'invalid_grant', message: 'bad token', httpStatus: 401 },
    })
  })

  it('accessOptions maps DPoP cnf, sid, and auth context', () => {
    const opts = accessOptions({
      tc: makeTokenContext({ dpopJkt: 'jkt_abc' }),
      sid: 'sess_1',
      authContext: { acr: 'urn:mfa', amr: ['pwd'], authTime: 100 },
      extraClaims: { org_id: 'org_1' },
      authorizationDetails: [
        { type: 'resource_access', locations: ['https://api.example'], actions: ['read'] },
      ],
    })
    expect(opts.cnf).toEqual({ jkt: 'jkt_abc' })
    expect(opts.sid).toBe('sess_1')
    expect(opts.authContext).toEqual({ acr: 'urn:mfa', amr: ['pwd'], authTime: 100 })
    expect(opts.extraClaims).toEqual({ org_id: 'org_1' })
    expect(opts.authorizationDetails).toHaveLength(1)
  })

  it('accessOptions never re-issues the unsupported XID AAL3 mapping', () => {
    const opts = accessOptions({
      tc: makeTokenContext(),
      authContext: {
        acr: 'urn:xid:aal3',
        amr: ['phr', 'mfa'],
        authTime: 100,
      },
    })
    expect(opts.authContext).toEqual({
      acr: 'urn:xid:aal2',
      amr: ['phr', 'mfa'],
      authTime: 100,
    })
  })

  it('tokenResponseBody includes optional refresh and id tokens', () => {
    const body = tokenResponseBody({
      accessToken: 'at',
      jkt: 'jkt',
      ttlSec: 3600,
      scope: 'openid profile',
      refreshToken: 'rt',
      idToken: 'idt',
    })
    expect(body).toMatchObject({
      access_token: 'at',
      token_type: 'DPoP',
      expires_in: 3600,
      scope: 'openid profile',
      refresh_token: 'rt',
      id_token: 'idt',
    })
  })
})
