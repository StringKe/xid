import { describe, expect, it, vi } from 'vitest'
import { base64UrlDecode, sha256Hex } from '@xid-kit/crypto'
import { registerCibaRoutes } from '../ciba'
import { registerTokenRoutes } from '../token'
import { approveCibaRequest, CIBA_GRANT } from '../ciba'
import { handleCibaActivation } from '../../me-auth/ciba-activation'
import { testErrorHandler } from '../../me-auth/__tests__/helpers'
import {
  buildTestTenant,
  makeApp,
  makeCibaStateNs,
  makeEnv,
  makeFakeD1,
  makeFakeKv,
} from './helpers'
import type { D1Capture } from './helpers'

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
    allowed_grant_types: JSON.stringify(['authorization_code', 'refresh_token', CIBA_GRANT]),
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

// CibaStore poll 故障:创建与批准成功,最终原子消费不可用。
function failingCibaStateNs(): DurableObjectNamespace {
  const backing = makeCibaStateNs()
  return {
    idFromName: (name: string) => backing.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = backing.get(id)
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          if (
            new URL(input instanceof Request ? input.url : input.toString()).pathname === '/poll'
          ) {
            return new Response('poll failed', { status: 500 })
          }
          return stub.fetch(input, init)
        },
      } as DurableObjectStub
    },
  } as unknown as DurableObjectNamespace
}

function loseFinalizeResponsesNs(): DurableObjectNamespace {
  const backing = makeCibaStateNs()
  let responsesToLose = 2
  return {
    idFromName: (name: string) => backing.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = backing.get(id)
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const response = await stub.fetch(input, init)
          const path = new URL(input instanceof Request ? input.url : input.toString()).pathname
          if (path === '/finalize' && responsesToLose > 0) {
            responsesToLose -= 1
            throw new Error('injected finalize response loss after commit')
          }
          return response
        },
      } as DurableObjectStub
    },
  } as unknown as DurableObjectNamespace
}

function failFirstRefreshInsert(database: D1Database): {
  database: D1Database
  failureCount: () => number
} {
  let remainingFailures = 1
  const databaseWithFailure = {
    prepare: (query: string) => {
      let statement = database.prepare(query)
      const shouldFail = /^\s*insert\s+into\s+["`]?refresh_tokens["`]?/iu.test(query)
      const failOnce = (): void => {
        if (!shouldFail || remainingFailures === 0) return
        remainingFailures -= 1
        throw new Error('injected refresh persistence failure')
      }
      const wrapped = {
        bind: (...values: unknown[]) => {
          statement = statement.bind(...values)
          return wrapped
        },
        all: async () => {
          failOnce()
          return statement.all()
        },
        raw: async () => {
          failOnce()
          return statement.raw()
        },
        run: async () => {
          failOnce()
          return statement.run()
        },
        first: async (column?: string) => {
          failOnce()
          return statement.first(column)
        },
      }
      return wrapped
    },
    batch: (statements: D1PreparedStatement[]) => database.batch(statements),
  } as unknown as D1Database
  return { database: databaseWithFailure, failureCount: () => 1 - remainingFailures }
}

async function createApprovedRequest(input: {
  app: ReturnType<typeof makeApp>
  env: Env
  ctx: Awaited<ReturnType<typeof buildTestTenant>>['ctx']
  scope?: string
}): Promise<string> {
  const backchannel = await input.app.request(
    'https://acme.xid.dev/backchannel_authentication',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'ciba_client',
        client_secret: 'sec_mtls',
        scope: input.scope ?? 'openid',
        login_hint: 'user@example.com',
      }).toString(),
    },
    input.env,
  )
  expect(backchannel.status).toBe(200)
  const body = (await backchannel.json()) as { auth_req_id: string }
  await expect(
    approveCibaRequest({
      env: input.env,
      ctx: input.ctx,
      authReqId: body.auth_req_id,
      userId: 'u_1',
    }),
  ).resolves.toBe(true)
  return body.auth_req_id
}

function redeemRequest(authReqId: string): Request {
  return new Request('https://acme.xid.dev/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: CIBA_GRANT,
      client_id: 'ciba_client',
      client_secret: 'sec_mtls',
      auth_req_id: authReqId,
    }).toString(),
  })
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
    expect(body.auth_req_id).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(base64UrlDecode(body.auth_req_id)).toHaveLength(32)

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

  it('allows exactly one concurrent redemption of the same auth_req_id', async () => {
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

    const redeem = () =>
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
    const responses = await Promise.all([redeem(), redeem()])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400])
    const rejected = responses.find((response) => response.status === 400)
    const err = (await rejected?.json()) as Record<string, string>
    expect(err['error']).toBe('authorization_pending')
  })

  it('releases the reservation when signing fails after poll so redemption can retry', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const env = makeEnv({
      CACHE: makeFakeKv(),
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
      a.onError(testErrorHandler)
      registerCibaRoutes(a)
      registerTokenRoutes(a)
    })
    const authReqId = await createApprovedRequest({ app, env, ctx })
    const sign = vi
      .spyOn(crypto.subtle, 'sign')
      .mockRejectedValueOnce(new Error('injected signing failure'))
    try {
      const failed = await app.request(redeemRequest(authReqId), undefined, env)
      expect(failed.status).toBe(500)

      const retry = await app.request(redeemRequest(authReqId), undefined, env)
      expect(retry.status).toBe(200)
      expect((await retry.json())['access_token']).toBeTypeOf('string')

      const replay = await app.request(redeemRequest(authReqId), undefined, env)
      expect(replay.status).toBe(400)
      expect(((await replay.json()) as Record<string, string>)['error']).toBe('invalid_grant')
    } finally {
      sign.mockRestore()
    }
  })

  it('rolls back a failed refresh persistence attempt and retries the same auth_req_id', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const capture: D1Capture = { inserts: [], updates: [] }
    const injected = failFirstRefreshInsert(
      makeFakeD1(
        {
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
        },
        capture,
      ),
    )
    const env = makeEnv({
      CACHE: makeFakeKv(),
      KEK: kekB64,
      DB: injected.database,
    })
    const app = makeApp(ctx, (a) => {
      a.onError(testErrorHandler)
      registerCibaRoutes(a)
      registerTokenRoutes(a)
    })
    const authReqId = await createApprovedRequest({
      app,
      env,
      ctx,
      scope: 'openid offline_access',
    })

    const failed = await app.request(redeemRequest(authReqId), undefined, env)
    expect(failed.status).toBe(500)
    expect(injected.failureCount()).toBe(1)

    const retry = await app.request(redeemRequest(authReqId), undefined, env)
    expect(retry.status).toBe(200)
    const tokens = (await retry.json()) as Record<string, unknown>
    expect(tokens['access_token']).toBeTypeOf('string')
    expect(tokens['refresh_token']).toBeTypeOf('string')
    expect(capture.inserts.filter((entry) => entry.table === 'refresh_tokens')).toHaveLength(1)

    const replay = await app.request(redeemRequest(authReqId), undefined, env)
    expect(replay.status).toBe(400)
    expect(((await replay.json()) as Record<string, string>)['error']).toBe('invalid_grant')
  })

  it('confirms finalize idempotently when committed responses are lost', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const env = makeEnv({
      CACHE: makeFakeKv(),
      KEK: kekB64,
      CIBA_STATE: loseFinalizeResponsesNs(),
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
      a.onError(testErrorHandler)
      registerCibaRoutes(a)
      registerTokenRoutes(a)
    })
    const authReqId = await createApprovedRequest({ app, env, ctx })

    const token = await app.request(redeemRequest(authReqId), undefined, env)
    expect(token.status).toBe(200)
    expect(((await token.json()) as Record<string, unknown>)['access_token']).toBeTypeOf('string')

    const replay = await app.request(redeemRequest(authReqId), undefined, env)
    expect(replay.status).toBe(400)
    expect(((await replay.json()) as Record<string, string>)['error']).toBe('invalid_grant')
  })

  it('fails closed when the auth_req_id redemption claim store is unavailable', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const kv = makeFakeKv()
    const env = makeEnv({
      CACHE: kv,
      KEK: kekB64,
      CIBA_STATE: failingCibaStateNs(),
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

    expect(token.status).toBe(500)
    const failure = (await token.json()) as Record<string, string>
    expect(failure['error']).toBe('server_error')
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
