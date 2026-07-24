import { describe, expect, it } from 'vitest'
import { sha256Hex } from '@xid-kit/crypto'
import { registerAuthorizeRoutes } from '../authorize'
import { registerTokenRoutes } from '../token'
import { buildTestTenant, makeApp, makeEnv, makeFakeD1 } from './helpers'

function clientRow(over: Record<string, unknown> = {}) {
  return {
    id: 'app_1',
    tenant_id: 't_1',
    client_id: 'fapi_client',
    client_secret_hash: null,
    client_type: 'public',
    token_endpoint_auth_method: 'none',
    jwks: null,
    redirect_uris: JSON.stringify(['https://rp.example/cb']),
    post_logout_redirect_uris: JSON.stringify([]),
    allowed_grant_types: JSON.stringify(['authorization_code', 'client_credentials']),
    allowed_response_types: JSON.stringify(['code']),
    allowed_scopes: JSON.stringify(['openid']),
    require_pkce: 1,
    dpop_bound_access_tokens: 0,
    access_token_format: 'jwt',
    access_token_ttl_sec: 3600,
    id_token_signed_alg: 'ES256',
    first_party: 0,
    require_org_context: 0,
    custom_claims_config: JSON.stringify({ fapiProfile: true }),
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

describe('FAPI profile gate', () => {
  it('rejects authorize without PAR request_uri for FAPI clients', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({ DB: makeFakeD1({ applications: [clientRow()] }) })
    const app = makeApp(ctx, registerAuthorizeRoutes)
    const url = `https://acme.xid.dev/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: 'fapi_client',
      redirect_uri: 'https://rp.example/cb',
      scope: 'openid',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
    }).toString()}`
    const res = await app.request(url, {}, env)
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('PAR')
  })

  it('rejects authorize with non-S256 PKCE for FAPI clients', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({ DB: makeFakeD1({ applications: [clientRow()] }) })
    const app = makeApp(ctx, registerAuthorizeRoutes)
    const url = `https://acme.xid.dev/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: 'fapi_client',
      redirect_uri: 'https://rp.example/cb',
      scope: 'openid',
      code_challenge: 'challenge',
      code_challenge_method: 'plain',
    }).toString()}`
    const res = await app.request(url, {}, env)
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('S256')
  })

  it('rejects /token without DPoP or mTLS sender constraint for FAPI clients', async () => {
    const secret = 'fapi_secret'
    const { ctx, kekB64 } = await buildTestTenant()
    const env = makeEnv({
      KEK: kekB64,
      DB: makeFakeD1({
        applications: [
          clientRow({
            client_type: 'confidential',
            client_secret_hash: await sha256Hex(secret),
            token_endpoint_auth_method: 'client_secret_post',
            allowed_grant_types: JSON.stringify(['client_credentials']),
          }),
        ],
      }),
    })
    const app = makeApp(ctx, registerTokenRoutes)
    const res = await app.request(
      'https://acme.xid.dev/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: 'fapi_client',
          client_secret: secret,
          scope: 'openid',
        }).toString(),
      },
      env,
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, string>
    expect(body['error_description']).toContain('sender constraint')
  })
})
