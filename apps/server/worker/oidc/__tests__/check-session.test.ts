import { describe, expect, it } from 'vitest'
import { opSessionStateForClient, registerCheckSessionRoutes } from '../check-session'
import { computeOpSessionState } from '../session-state'
import { buildTestTenant, makeApp, makeEnv, makeFakeD1, type TableSet } from './helpers'

const session = {
  sessionId: 's_test_123',
  userId: 'u_1',
  status: 'active' as const,
  activeOrgId: null,
  authenticatedAt: new Date(),
  expiresAt: new Date(Date.now() + 3600_000),
  rememberMe: false,
  isImpersonation: false,
  impersonatorUserId: null,
  acr: null,
  amr: null,
  aal: null,
}

function applicationTables(): TableSet {
  return {
    applications: [
      {
        id: 'app_1',
        tenant_id: 't_1',
        client_id: 'rp_client',
        client_secret_hash: null,
        client_type: 'public',
        token_endpoint_auth_method: 'none',
        jwks: null,
        redirect_uris: JSON.stringify([
          'https://rp.example/callback',
          'https://rp-alt.example/callback',
        ]),
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
        custom_claims_config: JSON.stringify({}),
        registration_access_token_hash: null,
        project_id: null,
        backchannel_logout_uri: null,
        frontchannel_logout_uri: null,
        status: 'active',
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ],
  }
}

describe('/check_session', () => {
  it('returns OP iframe HTML with session_state comparison logic', async () => {
    const { ctx } = await buildTestTenant()
    const app = makeApp(ctx, registerCheckSessionRoutes, session)
    const res = await app.request(
      'https://acme.xid.dev/check_session?client_id=rp_client',
      {},
      makeEnv({ DB: makeFakeD1(applicationTables()) }),
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('computeOpSessionState')
    expect(html).toContain('unchanged')
    expect(html).toContain('changed')
    expect(html).toContain('s_test_123')
    expect(html).toContain('https://acme.xid.dev')
    expect(html).toContain('https://rp.example')
    expect(html).toContain('parts[0] !== clientId')
    expect(html).not.toContain("return '*'")
  })

  it('rejects missing or unknown client_id', async () => {
    const { ctx } = await buildTestTenant()
    const app = makeApp(ctx, registerCheckSessionRoutes, session)
    const env = makeEnv({ DB: makeFakeD1(applicationTables()) })
    const missing = await app.request('https://acme.xid.dev/check_session', {}, env)
    expect(missing.status).toBe(400)
    const unknown = await app.request(
      'https://acme.xid.dev/check_session?client_id=unknown',
      {},
      env,
    )
    expect(unknown.status).toBe(400)
  })

  it('computes deterministic OP session_state for known vectors', async () => {
    const { ctx } = await buildTestTenant()
    const opState = await opSessionStateForClient({
      clientId: 'rp_client',
      issuer: ctx.issuer,
      session,
      salt: 'salt-fixed',
    })
    expect(opState).toMatch(/^[A-Za-z0-9_-]+$/)
    const again = await opSessionStateForClient({
      clientId: 'rp_client',
      issuer: ctx.issuer,
      session,
      salt: 'salt-fixed',
    })
    expect(again).toBe(opState)
    const changed = await opSessionStateForClient({
      clientId: 'rp_client',
      issuer: ctx.issuer,
      session: null,
      salt: 'salt-fixed',
    })
    expect(changed).not.toBe(opState)
  })

  it('opSessionStateForClient matches computeOpSessionState (iframe algorithm)', async () => {
    const { ctx } = await buildTestTenant()
    const salt = 'salt-fixed'
    const fromHelper = await opSessionStateForClient({
      clientId: 'rp_client',
      issuer: ctx.issuer,
      session,
      salt,
    })
    const fromCore = await computeOpSessionState({
      clientId: 'rp_client',
      issuer: ctx.issuer,
      sessionKey: session.sessionId,
      salt,
    })
    expect(fromHelper).toBe(fromCore)
  })
})
