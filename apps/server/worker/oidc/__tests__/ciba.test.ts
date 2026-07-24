import { describe, expect, it } from 'vitest'
import { sha256Hex } from '@xid-kit/crypto'
import { registerCibaRoutes } from '../ciba'
import { registerTokenRoutes } from '../token'
import { approveCibaRequest, CIBA_GRANT } from '../ciba'
import { handleCibaActivation } from '../../me-auth/ciba-activation'
import { testErrorHandler } from '../../me-auth/__tests__/helpers'
import { buildTestTenant, makeApp, makeEnv, makeFakeD1, makeFakeKv } from './helpers'

async function makeClientRow() {
  const secret = 'sec_mtls'
  return {
    id: 'app_1',
    tenant_id: 't_1',
    client_id: 'ciba_client',
    client_secret_hash: await sha256Hex(secret),
    client_type: 'confidential',
    token_endpoint_auth_method: 'client_secret_post',
    jwks: null,
    redirect_uris: JSON.stringify(['https://rp.example/cb']),
    post_logout_redirect_uris: JSON.stringify([]),
    allowed_grant_types: JSON.stringify(['authorization_code', CIBA_GRANT]),
    allowed_response_types: JSON.stringify(['code']),
    allowed_scopes: JSON.stringify(['openid', 'offline_access']),
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
  }
}

const session = {
  sessionId: 's_1',
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

describe('CIBA', () => {
  it('issues auth_req_id then tokens after approval', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const kv = makeFakeKv()
    const env = makeEnv({
      CACHE: kv,
      KEK: kekB64,
      DB: makeFakeD1({
        applications: [await makeClientRow()],
        users: [
          {
            id: 'u_1',
            tenant_id: 't_1',
            primary_email_id: 'eml_1',
            public_metadata: '{}',
            unsafe_metadata: '{}',
            status: 'active',
            deleted_at: null,
            created_at: Date.now(),
            updated_at: Date.now(),
          },
        ],
        user_emails: [
          {
            id: 'eml_1',
            tenant_id: 't_1',
            user_id: 'u_1',
            email: 'user@example.com',
          },
        ],
      }),
    })
    const app = makeApp(
      ctx,
      (a) => {
        registerCibaRoutes(a)
        registerTokenRoutes(a)
        a.post('/auth/ciba-activation', handleCibaActivation)
      },
      session,
    )
    const backchannel = await app.request(
      'https://acme.xid.dev/backchannel_authentication',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'ciba_client',
          client_secret: 'sec_mtls',
          scope: 'openid',
          login_hint: 'user@example.com',
        }).toString(),
      },
      env,
    )
    expect(backchannel.status).toBe(200)
    expect(backchannel.headers.get('pragma')).toBe('no-cache')
    const body = (await backchannel.json()) as { auth_req_id: string }

    const activation = await app.request(
      'https://acme.xid.dev/auth/ciba-activation',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authReqId: body.auth_req_id, approved: true }),
      },
      env,
    )
    expect(activation.status).toBe(200)

    const token = await app.request(
      'https://acme.xid.dev/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: CIBA_GRANT,
          client_id: 'ciba_client',
          client_secret: 'sec_mtls',
          auth_req_id: body.auth_req_id,
        }).toString(),
      },
      env,
    )
    expect(token.status).toBe(200)
    const tokenBody = (await token.json()) as Record<string, unknown>
    expect(tokenBody['access_token']).toBeTypeOf('string')
    expect(tokenBody['id_token']).toBeTypeOf('string')
  })

  it('rejects double redemption of the same auth_req_id', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const kv = makeFakeKv()
    const env = makeEnv({
      CACHE: kv,
      KEK: kekB64,
      DB: makeFakeD1({
        applications: [await makeClientRow()],
        users: [
          {
            id: 'u_1',
            tenant_id: 't_1',
            primary_email_id: 'eml_1',
            public_metadata: '{}',
            unsafe_metadata: '{}',
            status: 'active',
            deleted_at: null,
            created_at: Date.now(),
            updated_at: Date.now(),
          },
        ],
        user_emails: [
          {
            id: 'eml_1',
            tenant_id: 't_1',
            user_id: 'u_1',
            email: 'user@example.com',
          },
        ],
      }),
    })
    const app = makeApp(ctx, (a) => {
      registerCibaRoutes(a)
      registerTokenRoutes(a)
    })
    const backchannel = await app.request(
      'https://acme.xid.dev/backchannel_authentication',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'ciba_client',
          client_secret: 'sec_mtls',
          scope: 'openid',
          login_hint: 'user@example.com',
        }).toString(),
      },
      env,
    )
    const body = (await backchannel.json()) as { auth_req_id: string }
    const approved = await approveCibaRequest({
      env,
      ctx,
      authReqId: body.auth_req_id,
      userId: 'u_1',
    })
    expect(approved).toBe(true)

    const first = await app.request(
      'https://acme.xid.dev/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: CIBA_GRANT,
          client_id: 'ciba_client',
          client_secret: 'sec_mtls',
          auth_req_id: body.auth_req_id,
        }).toString(),
      },
      env,
    )
    expect(first.status).toBe(200)

    const second = await app.request(
      'https://acme.xid.dev/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: CIBA_GRANT,
          client_id: 'ciba_client',
          client_secret: 'sec_mtls',
          auth_req_id: body.auth_req_id,
        }).toString(),
      },
      env,
    )
    expect(second.status).toBe(400)
    const err = (await second.json()) as Record<string, string>
    expect(err['error']).toBe('invalid_grant')
  })

  it('pending 期间快速连 poll 两次,第二次返回 slow_down', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const kv = makeFakeKv()
    const env = makeEnv({
      CACHE: kv,
      KEK: kekB64,
      DB: makeFakeD1({ applications: [await makeClientRow()] }),
    })
    const app = makeApp(ctx, (a) => {
      registerCibaRoutes(a)
      registerTokenRoutes(a)
    })
    const backchannel = await app.request(
      'https://acme.xid.dev/backchannel_authentication',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'ciba_client',
          client_secret: 'sec_mtls',
          scope: 'openid',
          login_hint: 'user@example.com',
        }).toString(),
      },
      env,
    )
    expect(backchannel.status).toBe(200)
    const body = (await backchannel.json()) as { auth_req_id: string }

    const poll = () =>
      app.request(
        'https://acme.xid.dev/token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: CIBA_GRANT,
            client_id: 'ciba_client',
            client_secret: 'sec_mtls',
            auth_req_id: body.auth_req_id,
          }).toString(),
        },
        env,
      )

    const first = await poll()
    expect(((await first.json()) as Record<string, string>)['error']).toBe('authorization_pending')

    const second = await poll()
    expect(second.status).toBe(400)
    expect(((await second.json()) as Record<string, string>)['error']).toBe('slow_down')
  })

  it('rejects approval when login_hint does not match the authenticated user', async () => {
    const { ctx } = await buildTestTenant()
    const kv = makeFakeKv()
    const env = makeEnv({
      CACHE: kv,
      DB: makeFakeD1({
        applications: [await makeClientRow()],
        users: [
          {
            id: 'u_1',
            tenant_id: 't_1',
            primary_email_id: 'eml_1',
            public_metadata: '{}',
            unsafe_metadata: '{}',
            status: 'active',
            deleted_at: null,
            created_at: Date.now(),
            updated_at: Date.now(),
          },
        ],
        user_emails: [
          {
            id: 'eml_1',
            tenant_id: 't_1',
            user_id: 'u_1',
            email: 'user@example.com',
          },
        ],
      }),
    })
    const app = makeApp(ctx, registerCibaRoutes)
    const backchannel = await app.request(
      'https://acme.xid.dev/backchannel_authentication',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'ciba_client',
          client_secret: 'sec_mtls',
          scope: 'openid',
          login_hint: 'other@example.com',
        }).toString(),
      },
      env,
    )
    const body = (await backchannel.json()) as { auth_req_id: string }
    const approved = await approveCibaRequest({
      env,
      ctx,
      authReqId: body.auth_req_id,
      userId: 'u_1',
    })
    expect(approved).toBe(false)
  })

  it('rejects activation approval with pending_mfa session(MFA 未完成不得批准)', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({})
    const app = makeApp(
      ctx,
      (a) => {
        a.onError(testErrorHandler)
        a.post('/auth/ciba-activation', handleCibaActivation)
      },
      { ...session, status: 'pending_mfa' as const },
    )
    const res = await app.request(
      'https://acme.xid.dev/auth/ciba-activation',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authReqId: 'arq_pending', approved: true }),
      },
      env,
    )
    expect(res.status).toBe(401)
  })

  it('scope 越 client.allowedScopes 白名单 -> invalid_scope', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({
      CACHE: makeFakeKv(),
      DB: makeFakeD1({ applications: [await makeClientRow()] }),
    })
    const app = makeApp(ctx, registerCibaRoutes)
    const backchannel = await app.request(
      'https://acme.xid.dev/backchannel_authentication',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'ciba_client',
          client_secret: 'sec_mtls',
          scope: 'openid admin',
          login_hint: 'user@example.com',
        }).toString(),
      },
      env,
    )
    expect(backchannel.status).toBe(400)
    const body = (await backchannel.json()) as Record<string, string>
    expect(body['error']).toBe('invalid_scope')
  })
})
