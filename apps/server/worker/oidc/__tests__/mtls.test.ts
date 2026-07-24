import { describe, expect, it } from 'vitest'
import { importJwkForVerify, verifyJwt } from '@xid-kit/crypto'
import { authenticateClient } from '../client-auth'
import { registerTokenRoutes } from '../token'
import { readTlsClientAuth } from '../mtls'
import { buildTestTenant, makeApp, makeEnv, makeFakeD1 } from './helpers'

const TLS_HEADER = JSON.stringify({
  certVerified: 'SUCCESS',
  certSubjectDN: 'CN=client.example.com',
  certIssuerDN: 'CN=Test CA',
  certFingerprintSHA256: 'AB:CD:EF:12',
})

const SELF_SIGNED_HEADER = JSON.stringify({
  certVerified: 'SUCCESS',
  certSubjectDN: 'CN=client.example.com',
  certIssuerDN: '',
  certFingerprintSHA256: 'AB:CD:EF:12',
})

function tlsClientRow(method: string, over: Record<string, unknown> = {}) {
  return {
    id: 'app_1',
    tenant_id: 't_1',
    client_id: 'mtls_client',
    client_secret_hash: null,
    client_type: 'confidential',
    token_endpoint_auth_method: method,
    jwks: null,
    redirect_uris: JSON.stringify([]),
    post_logout_redirect_uris: JSON.stringify([]),
    allowed_grant_types: JSON.stringify(['client_credentials']),
    allowed_response_types: JSON.stringify(['code']),
    allowed_scopes: JSON.stringify(['openid']),
    require_pkce: 0,
    dpop_bound_access_tokens: 0,
    access_token_format: 'jwt',
    access_token_ttl_sec: 3600,
    id_token_signed_alg: 'ES256',
    first_party: 0,
    require_org_context: 0,
    custom_claims_config: JSON.stringify({
      tlsClientAuthSubjectDn: 'CN=client.example.com',
    }),
    registration_access_token_hash: null,
    project_id: null,
    backchannel_logout_uri: null,
    frontchannel_logout_uri: null,
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
    ...over,
  }
}

describe('mTLS client authentication', () => {
  it('accepts matching tls_client_auth certificate metadata', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({ DB: makeFakeD1({ applications: [tlsClientRow('tls_client_auth')] }) })
    const c = {
      env,
      req: {
        header: (name: string) =>
          name.toLowerCase() === 'x-mock-tls-client-auth' ? TLS_HEADER : undefined,
      },
      get: (key: string) => (key === 'tenant' ? ctx : undefined),
    }
    const result = await authenticateClient({
      c: c as never,
      client: {
        clientId: 'mtls_client',
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'tls_client_auth',
        clientSecretHash: null,
        jwks: null,
        customClaimsConfig: { tlsClientAuthSubjectDn: 'CN=client.example.com' },
      } as never,
      creds: {
        basic: null,
        postClientId: 'mtls_client',
        postSecret: null,
        assertionType: null,
        assertion: null,
      },
      ctx,
      tokenEndpoint: `${ctx.issuer}/token`,
      now: Math.floor(Date.now() / 1000),
    })
    expect(result.ok).toBe(true)
  })

  it('rejects self-signed metadata for tls_client_auth', async () => {
    const { ctx } = await buildTestTenant()
    const result = await authenticateClient({
      c: {
        env: makeEnv({ DB: makeFakeD1({ applications: [] }) }),
        req: {
          header: (name: string) =>
            name.toLowerCase() === 'x-mock-tls-client-auth' ? SELF_SIGNED_HEADER : undefined,
        },
        get: (key: string) => (key === 'tenant' ? ctx : undefined),
      } as never,
      client: {
        clientId: 'mtls_client',
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'tls_client_auth',
        clientSecretHash: null,
        jwks: null,
        customClaimsConfig: { tlsClientAuthSubjectDn: 'CN=client.example.com' },
      } as never,
      creds: {
        basic: null,
        postClientId: 'mtls_client',
        postSecret: null,
        assertionType: null,
        assertion: null,
      },
      ctx,
      tokenEndpoint: `${ctx.issuer}/token`,
      now: Math.floor(Date.now() / 1000),
    })
    expect(result.ok).toBe(false)
  })

  it('accepts self_signed_tls_client_auth without CA issuer', async () => {
    const { ctx } = await buildTestTenant()
    const result = await authenticateClient({
      c: {
        env: makeEnv({ DB: makeFakeD1({ applications: [] }) }),
        req: {
          header: (name: string) =>
            name.toLowerCase() === 'x-mock-tls-client-auth' ? SELF_SIGNED_HEADER : undefined,
        },
        get: (key: string) => (key === 'tenant' ? ctx : undefined),
      } as never,
      client: {
        clientId: 'mtls_client',
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'self_signed_tls_client_auth',
        clientSecretHash: null,
        jwks: null,
        customClaimsConfig: { tlsClientAuthSubjectDn: 'CN=client.example.com' },
      } as never,
      creds: {
        basic: null,
        postClientId: 'mtls_client',
        postSecret: null,
        assertionType: null,
        assertion: null,
      },
      ctx,
      tokenEndpoint: `${ctx.issuer}/token`,
      now: Math.floor(Date.now() / 1000),
    })
    expect(result.ok).toBe(true)
  })

  it('ignores x-mock-tls-client-auth in production', async () => {
    const { ctx } = await buildTestTenant()
    const c = {
      env: makeEnv({ ENVIRONMENT: 'production' }),
      req: {
        header: (name: string) =>
          name.toLowerCase() === 'x-mock-tls-client-auth' ? TLS_HEADER : undefined,
        raw: { cf: undefined },
      },
      get: (key: string) => (key === 'tenant' ? ctx : undefined),
    }
    expect(readTlsClientAuth(c as never)).toBeNull()
  })

  it('binds cnf.x5t#S256 on /token for mTLS-authenticated clients', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const env = makeEnv({
      KEK: kekB64,
      DB: makeFakeD1({ applications: [tlsClientRow('tls_client_auth')] }),
    })
    const app = makeApp(ctx, registerTokenRoutes)
    const res = await app.request(
      'https://acme.xid.dev/token',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-mock-tls-client-auth': TLS_HEADER,
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: 'mtls_client',
          scope: 'openid',
        }).toString(),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const accessToken = body['access_token']
    expect(typeof accessToken).toBe('string')
    const jwk = ctx.signingKeys.keys[0]!
    const publicKey = await importJwkForVerify({
      ...jwk.publicKeyJwk,
      kid: jwk.kid,
      use: 'sig',
      alg: jwk.alg,
    })
    const verified = await verifyJwt(accessToken as string, {
      keys: [{ kid: jwk.kid, alg: jwk.alg, publicKey }],
    })
    expect(verified.ok).toBe(true)
    if (verified.ok) {
      expect(verified.value.payload.cnf).toEqual({ 'x5t#S256': 'abcdef12' })
    }
  })
})
