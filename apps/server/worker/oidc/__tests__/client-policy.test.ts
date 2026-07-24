// client-policy 单元测试:FAPI/BBA/mTLS profile 与 sender-constraint 门控。
import { describe, expect, it } from 'vitest'
import type { ClientRow } from '../shared'
import type { TokenContext } from '../token-issue'
import {
  clientAllowsMtlsTokenBinding,
  clientPolicyConfig,
  clientRequiresBba,
  clientRequiresFapi,
  fapiRequiresSenderConstraint,
  hasSenderConstraint,
} from '../client-policy'

function makeClient(overrides: Partial<ClientRow> = {}): ClientRow {
  return {
    id: 'app_1',
    tenantId: 't_1',
    clientId: 'cli_app',
    clientSecretHash: null,
    clientType: 'confidential',
    tokenEndpointAuthMethod: 'none',
    jwks: null,
    redirectUris: ['https://rp.example/cb'],
    postLogoutRedirectUris: [],
    allowedGrantTypes: ['authorization_code'],
    allowedResponseTypes: ['code'],
    allowedScopes: ['openid'],
    requirePkce: true,
    dpopBoundAccessTokens: false,
    accessTokenFormat: 'jwt',
    accessTokenTtlSec: 3600,
    idTokenSignedAlg: 'ES256',
    firstParty: false,
    requireOrgContext: false,
    customClaimsConfig: {},
    registrationAccessTokenHash: null,
    projectId: null,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ClientRow
}

function makeTokenContext(over: Partial<TokenContext> = {}): TokenContext {
  return {
    c: {} as TokenContext['c'],
    signer: {} as TokenContext['signer'],
    client: makeClient(),
    clientId: 'cli_app',
    dpopJkt: null,
    mtlsCertThumbprint: null,
    form: {},
    now: 1_700_000_000_000,
    ...over,
  }
}

describe('clientPolicyConfig', () => {
  it('returns empty object for non-object customClaimsConfig', () => {
    expect(clientPolicyConfig(makeClient({ customClaimsConfig: null }))).toEqual({})
    expect(clientPolicyConfig(makeClient({ customClaimsConfig: 'bad' as never }))).toEqual({})
  })

  it('parses fapi and bba flags from customClaimsConfig', () => {
    const cfg = clientPolicyConfig(
      makeClient({ customClaimsConfig: { fapiProfile: true, bbaProfile: true } }),
    )
    expect(cfg.fapiProfile).toBe(true)
    expect(cfg.bbaProfile).toBe(true)
  })
})

describe('clientRequiresFapi / clientRequiresBba', () => {
  it('reads profile flags from client config', () => {
    expect(clientRequiresFapi(makeClient())).toBe(false)
    expect(clientRequiresFapi(makeClient({ customClaimsConfig: { fapiProfile: true } }))).toBe(true)
    expect(clientRequiresBba(makeClient({ customClaimsConfig: { bbaProfile: true } }))).toBe(true)
  })
})

describe('clientAllowsMtlsTokenBinding', () => {
  it('allows binding when auth method is tls_client_auth', () => {
    expect(
      clientAllowsMtlsTokenBinding(makeClient({ tokenEndpointAuthMethod: 'tls_client_auth' })),
    ).toBe(true)
  })

  it('allows binding when mtlsBoundTokens flag is set', () => {
    expect(
      clientAllowsMtlsTokenBinding(makeClient({ customClaimsConfig: { mtlsBoundTokens: true } })),
    ).toBe(true)
  })
})

describe('hasSenderConstraint', () => {
  it('is true when DPoP JKT or mTLS thumbprint is present', () => {
    expect(hasSenderConstraint({ dpopJkt: 'jkt1', mtlsCertThumbprint: null })).toBe(true)
    expect(hasSenderConstraint({ dpopJkt: null, mtlsCertThumbprint: 'thumb' })).toBe(true)
    expect(hasSenderConstraint({ dpopJkt: null, mtlsCertThumbprint: null })).toBe(false)
  })
})

describe('fapiRequiresSenderConstraint', () => {
  it('requires sender constraint for FAPI clients without DPoP or mTLS', () => {
    const client = makeClient({ customClaimsConfig: { fapiProfile: true } })
    expect(fapiRequiresSenderConstraint(makeTokenContext({ client }))).toBe(true)
    expect(fapiRequiresSenderConstraint(makeTokenContext({ client, dpopJkt: 'jkt_present' }))).toBe(
      false,
    )
    expect(
      fapiRequiresSenderConstraint(makeTokenContext({ client, mtlsCertThumbprint: 'cert_thumb' })),
    ).toBe(false)
  })

  it('does not require constraint for non-FAPI clients', () => {
    expect(fapiRequiresSenderConstraint(makeTokenContext())).toBe(false)
  })
})
