import { describe, expect, it } from 'vitest'
import { buildDiscoveryMetadata } from '@xid-kit/protocol'
import { registerAuthorizeRoutes } from '../authorize'
import { buildTestTenant, makeApp, makeEnv, makeFakeD1 } from './helpers'

function bbaClientRow() {
  return {
    id: 'app_1',
    tenant_id: 't_1',
    client_id: 'bba_client',
    client_secret_hash: null,
    client_type: 'public',
    token_endpoint_auth_method: 'none',
    jwks: null,
    redirect_uris: JSON.stringify(['https://rp.example/cb']),
    post_logout_redirect_uris: JSON.stringify([]),
    allowed_grant_types: JSON.stringify(['authorization_code']),
    allowed_response_types: JSON.stringify(['code']),
    allowed_scopes: JSON.stringify(['openid']),
    require_pkce: 1,
    dpop_bound_access_tokens: 0,
    access_token_format: 'jwt',
    access_token_ttl_sec: 3600,
    id_token_signed_alg: 'ES256',
    first_party: 0,
    require_org_context: 0,
    custom_claims_config: JSON.stringify({ bbaProfile: true }),
    registration_access_token_hash: null,
    project_id: null,
    backchannel_logout_uri: null,
    frontchannel_logout_uri: null,
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
  }
}

describe('Browser-Based Apps profile', () => {
  it('advertises browser_based_apps_profile_supported only when tenant policy enables it', async () => {
    const { ctx } = await buildTestTenant()
    const disabled = buildDiscoveryMetadata({ ctx })
    expect(disabled.browser_based_apps_profile_supported).toBe(false)
    const enabled = buildDiscoveryMetadata({
      ctx: {
        ...ctx,
        policy: { oidcProfiles: { browserBasedAppsProfileSupported: true } },
      },
      browserBasedAppsProfileSupported: true,
    })
    expect(enabled.browser_based_apps_profile_supported).toBe(true)
  })

  it('rejects authorize without PKCE for BBA clients', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({ DB: makeFakeD1({ applications: [bbaClientRow()] }) })
    const app = makeApp(ctx, registerAuthorizeRoutes)
    const url = `https://acme.xid.dev/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: 'bba_client',
      redirect_uri: 'https://rp.example/cb',
      scope: 'openid',
    }).toString()}`
    const res = await app.request(url, {}, env)
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('PKCE')
  })
})
