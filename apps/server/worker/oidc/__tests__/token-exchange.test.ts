import { describe, it, expect } from 'vitest'
import {
  buildAccessTokenClaims,
  buildIdTokenClaims,
  signAccessTokenClaims,
  signClaims,
} from '@xid-kit/protocol'
import { loadSigningKey } from '@xid-kit/crypto'
import { decodeKek, loadActiveSigner } from '../shared'
import { grantDeviceCode, grantTokenExchange } from '../token-exchange'
import type { TokenContext } from '../token-issue'
import { buildTestTenant, makeEnv, makeFakeD1, makeFakeDoNs } from './helpers'

const CLIENT_ID = 'cli_app'
const USER_ID = 'u_1'
const SUBJECT_ACCESS = 'urn:ietf:params:oauth:token-type:access_token'
const SUBJECT_ID = 'urn:ietf:params:oauth:token-type:id_token'

function asContext(value: unknown) {
  return value as TokenContext['c']
}

type TestTenant = Awaited<ReturnType<typeof buildTestTenant>>

async function makeGrantContext(
  over: Partial<TokenContext> = {},
  tenant?: TestTenant,
): Promise<TokenContext> {
  const { ctx, kekB64 } = tenant ?? (await buildTestTenant())
  const signer = await loadActiveSigner(ctx, kekB64)
  const now = over.now ?? Math.floor(Date.now() / 1000)
  const c = {
    env: makeEnv({
      DB: makeFakeD1({ users: [activeUserRow()] }),
      KEK: kekB64,
      ...(over.c ? { DEVICE_FLOW: over.c.env.DEVICE_FLOW } : {}),
    }),
    get: (key: string) => (key === 'tenant' ? ctx : undefined),
  }
  return {
    c: over.c ?? asContext(c),
    signer,
    client: {
      clientType: 'confidential',
      allowedScopes: ['openid', 'profile', 'offline_access'],
      allowedGrantTypes: [
        'authorization_code',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:token-exchange',
      ],
      accessTokenTtlSec: 3600,
      requirePkce: false,
      clientId: CLIENT_ID,
      redirectUris: ['https://rp.example/cb'],
      firstParty: true,
    } as TokenContext['client'],
    clientId: CLIENT_ID,
    dpopJkt: null,
    mtlsCertThumbprint: null,
    form: {},
    now,
    ...over,
  }
}

function activeUserRow(): Record<string, unknown> {
  return {
    id: USER_ID,
    tenant_id: 't_1',
    public_metadata: '{}',
    unsafe_metadata: '{}',
    status: 'active',
    deleted_at: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  }
}

async function mintSubjectAccessToken(
  ctx: TestTenant['ctx'],
  kekB64: string,
  scope = 'openid profile',
  now = Math.floor(Date.now() / 1000),
) {
  const material = ctx.signingKeys.keys[0]!
  const key = await loadSigningKey(material.encryptedPrivateKey, decodeKek(kekB64))
  const claims = buildAccessTokenClaims({
    ctx,
    subject: { userId: USER_ID },
    clientId: CLIENT_ID,
    scope,
    audience: CLIENT_ID,
    now,
    ttlSec: 3600,
  })
  return signAccessTokenClaims(ctx, key, claims)
}

describe('grantDeviceCode', () => {
  it('requires device_code parameter', async () => {
    const tc = await makeGrantContext()
    const result = await grantDeviceCode(tc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_request')
  })

  it('rejects device_code bound to another client', async () => {
    const { ctx } = await buildTestTenant()
    const deviceNs = makeFakeDoNs((path) => {
      if (path === '/poll') {
        return Response.json({
          approved: true,
          userId: USER_ID,
          scopes: ['openid'],
          clientId: 'other_client',
        })
      }
      return new Response('{}', { status: 404 })
    })
    const tc = await makeGrantContext({
      c: asContext({
        env: makeEnv({
          DB: makeFakeD1({ users: [activeUserRow()] }),
          DEVICE_FLOW: deviceNs,
        }),
        get: (key: string) => (key === 'tenant' ? ctx : undefined),
      }),
      form: { device_code: 'dev_1' },
    })
    const result = await grantDeviceCode(tc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_grant')
  })

  it('issues tokens when device flow poll approves', async () => {
    const { ctx } = await buildTestTenant()
    const deviceNs = makeFakeDoNs((path) => {
      if (path === '/poll') {
        return Response.json({
          approved: true,
          userId: USER_ID,
          scopes: ['openid', 'profile'],
          clientId: CLIENT_ID,
        })
      }
      return new Response('{}', { status: 404 })
    })
    const tc = await makeGrantContext({
      c: asContext({
        env: makeEnv({
          DB: makeFakeD1({ users: [activeUserRow()] }),
          DEVICE_FLOW: deviceNs,
        }),
        get: (key: string) => (key === 'tenant' ? ctx : undefined),
      }),
      form: { device_code: 'dev_approved' },
    })
    const result = await grantDeviceCode(tc)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value['access_token']).toBeTypeOf('string')
      expect(result.value['id_token']).toBeTypeOf('string')
      expect(result.value['scope']).toBe('openid profile')
    }
  })

  it('keeps well-formed DeviceFlowStore poll errors as protocol errors', async () => {
    const { ctx } = await buildTestTenant()
    const deviceNs = makeFakeDoNs((path) => {
      if (path === '/poll') {
        return Response.json(
          {
            error: 'authorization_pending',
            error_description: 'User has not yet authorized the request',
          },
          { status: 400 },
        )
      }
      return new Response('{}', { status: 404 })
    })
    const tc = await makeGrantContext({
      c: asContext({
        env: makeEnv({
          DB: makeFakeD1({ users: [activeUserRow()] }),
          DEVICE_FLOW: deviceNs,
        }),
        get: (key: string) => (key === 'tenant' ? ctx : undefined),
      }),
      form: { device_code: 'dev_pending' },
    })

    const result = await grantDeviceCode(tc)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('authorization_pending')
      expect(result.error.message).toBe('User has not yet authorized the request')
    }
  })

  it('fails closed when the DeviceFlowStore poll error body is malformed', async () => {
    const { ctx } = await buildTestTenant()
    const deviceNs = makeFakeDoNs((path) => {
      if (path === '/poll') return Response.json({}, { status: 500 })
      return new Response('{}', { status: 404 })
    })
    const tc = await makeGrantContext({
      c: asContext({
        env: makeEnv({
          DB: makeFakeD1({ users: [activeUserRow()] }),
          DEVICE_FLOW: deviceNs,
        }),
        get: (key: string) => (key === 'tenant' ? ctx : undefined),
      }),
      form: { device_code: 'dev_broken_error' },
    })

    const result = await grantDeviceCode(tc)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('server_error')
      expect(result.error.httpStatus).toBe(500)
    }
  })

  it('fails closed when the DeviceFlowStore approval body is malformed', async () => {
    const { ctx } = await buildTestTenant()
    const deviceNs = makeFakeDoNs((path) => {
      if (path === '/poll') {
        return Response.json({
          approved: true,
          userId: USER_ID,
          scopes: [1],
          clientId: CLIENT_ID,
        })
      }
      return new Response('{}', { status: 404 })
    })
    const tc = await makeGrantContext({
      c: asContext({
        env: makeEnv({
          DB: makeFakeD1({ users: [activeUserRow()] }),
          DEVICE_FLOW: deviceNs,
        }),
        get: (key: string) => (key === 'tenant' ? ctx : undefined),
      }),
      form: { device_code: 'dev_malformed_approval' },
    })

    const result = await grantDeviceCode(tc)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('server_error')
  })

  it('fails closed when the DeviceFlowStore 200 response is not an approval', async () => {
    const { ctx } = await buildTestTenant()
    const deviceNs = makeFakeDoNs((path) => {
      if (path === '/poll') return Response.json({ scopes: ['openid'], clientId: CLIENT_ID })
      return new Response('{}', { status: 404 })
    })
    const tc = await makeGrantContext({
      c: asContext({
        env: makeEnv({
          DB: makeFakeD1({ users: [activeUserRow()] }),
          DEVICE_FLOW: deviceNs,
        }),
        get: (key: string) => (key === 'tenant' ? ctx : undefined),
      }),
      form: { device_code: 'dev_not_approved' },
    })

    const result = await grantDeviceCode(tc)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('server_error')
  })
})

describe('grantTokenExchange', () => {
  it('rejects public clients', async () => {
    const tc = await makeGrantContext({
      client: { clientType: 'public', firstParty: true } as TokenContext['client'],
      form: {
        subject_token: 'tok',
        subject_token_type: SUBJECT_ACCESS,
      },
    })
    const result = await grantTokenExchange(tc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_client')
  })

  it('rejects non first-party clients', async () => {
    const tc = await makeGrantContext({
      client: { clientType: 'confidential', firstParty: false } as TokenContext['client'],
      form: {
        subject_token: 'tok',
        subject_token_type: SUBJECT_ACCESS,
      },
    })
    const result = await grantTokenExchange(tc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_grant')
  })

  it('requires subject_token and subject_token_type', async () => {
    const tc = await makeGrantContext({ form: {} })
    const result = await grantTokenExchange(tc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_request')
  })

  it('exchanges valid subject access token for narrowed access token', async () => {
    const tenant = await buildTestTenant()
    const now = Math.floor(Date.now() / 1000)
    const subjectToken = await mintSubjectAccessToken(
      tenant.ctx,
      tenant.kekB64,
      'openid profile',
      now,
    )
    const tc = await makeGrantContext(
      {
        form: {
          subject_token: subjectToken,
          subject_token_type: SUBJECT_ACCESS,
          scope: 'openid',
        },
        now,
      },
      tenant,
    )
    const result = await grantTokenExchange(tc)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value['issued_token_type']).toBe(SUBJECT_ACCESS)
      expect(result.value['scope']).toBe('openid')
      expect(result.value['access_token']).toBeTypeOf('string')
    }
  })

  it('rejects scope expansion beyond subject token', async () => {
    const tenant = await buildTestTenant()
    const now = Math.floor(Date.now() / 1000)
    const subjectToken = await mintSubjectAccessToken(
      tenant.ctx,
      tenant.kekB64,
      'openid profile',
      now,
    )
    const tc = await makeGrantContext(
      {
        form: {
          subject_token: subjectToken,
          subject_token_type: SUBJECT_ACCESS,
          scope: 'openid admin',
        },
        now,
      },
      tenant,
    )
    const result = await grantTokenExchange(tc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_scope')
  })

  it('rejects subject_token_type mismatch for access token claims', async () => {
    const tenant = await buildTestTenant()
    const now = Math.floor(Date.now() / 1000)
    const subjectToken = await mintSubjectAccessToken(
      tenant.ctx,
      tenant.kekB64,
      'openid profile',
      now,
    )
    const tc = await makeGrantContext(
      {
        form: {
          subject_token: subjectToken,
          subject_token_type: SUBJECT_ID,
        },
        now,
      },
      tenant,
    )
    const result = await grantTokenExchange(tc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_grant')
  })

  it('subject access token jti 已撤销 -> invalid_grant', async () => {
    const tenant = await buildTestTenant()
    const now = Math.floor(Date.now() / 1000)
    const subjectToken = await mintSubjectAccessToken(
      tenant.ctx,
      tenant.kekB64,
      'openid profile',
      now,
    )
    const payload = JSON.parse(
      Buffer.from(subjectToken.split('.')[1] ?? '', 'base64url').toString(),
    ) as { jti: string }
    const tc = await makeGrantContext(
      {
        c: asContext({
          env: makeEnv({
            DB: makeFakeD1({
              users: [activeUserRow()],
              access_token_revocations: [
                { id: 'rev_1', tenant_id: 't_1', jti: payload.jti, revoked_at: now * 1000 },
              ],
            }),
            KEK: tenant.kekB64,
          }),
          get: (key: string) => (key === 'tenant' ? tenant.ctx : undefined),
        }),
        form: {
          subject_token: subjectToken,
          subject_token_type: SUBJECT_ACCESS,
        },
        now,
      },
      tenant,
    )
    const result = await grantTokenExchange(tc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_grant')
  })

  it('exchanges subject access token for refresh token when offline_access allowed', async () => {
    const tenant = await buildTestTenant()
    const now = Math.floor(Date.now() / 1000)
    const subjectToken = await mintSubjectAccessToken(
      tenant.ctx,
      tenant.kekB64,
      'openid offline_access',
      now,
    )
    const tc = await makeGrantContext(
      {
        form: {
          subject_token: subjectToken,
          subject_token_type: SUBJECT_ACCESS,
          requested_token_type: 'urn:ietf:params:oauth:token-type:refresh_token',
        },
        now,
      },
      tenant,
    )
    const result = await grantTokenExchange(tc)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value['issued_token_type']).toBe(
        'urn:ietf:params:oauth:token-type:refresh_token',
      )
      expect(result.value['token_type']).toBe('N/A')
      // 无策略覆盖时回退内置默认 idle 30d
      expect(result.value['expires_in']).toBe(30 * 86400)
    }
  })

  it('refresh exchange 的 expires_in 走租户 token 策略 idle', async () => {
    const tenant = await buildTestTenant()
    tenant.ctx.policy.token = {
      accessTokenTtlSec: 3600,
      sessionTokenTtlSec: 60,
      refreshIdleTimeoutDays: 2,
      refreshAbsoluteTimeoutDays: 3,
    }
    const now = Math.floor(Date.now() / 1000)
    const subjectToken = await mintSubjectAccessToken(
      tenant.ctx,
      tenant.kekB64,
      'openid offline_access',
      now,
    )
    const tc = await makeGrantContext(
      {
        form: {
          subject_token: subjectToken,
          subject_token_type: SUBJECT_ACCESS,
          requested_token_type: 'urn:ietf:params:oauth:token-type:refresh_token',
        },
        now,
      },
      tenant,
    )
    const result = await grantTokenExchange(tc)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value['expires_in']).toBe(2 * 86400)
  })

  it('exchanges subject access token for id token with act claim', async () => {
    const tenant = await buildTestTenant()
    const now = Math.floor(Date.now() / 1000)
    const subjectToken = await mintSubjectAccessToken(
      tenant.ctx,
      tenant.kekB64,
      'openid profile',
      now,
    )
    const tc = await makeGrantContext(
      {
        form: {
          subject_token: subjectToken,
          subject_token_type: SUBJECT_ACCESS,
          requested_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        },
        now,
      },
      tenant,
    )
    const result = await grantTokenExchange(tc)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value['issued_token_type']).toBe('urn:ietf:params:oauth:token-type:id_token')
      expect(result.value['token_type']).toBe('N/A')
    }
  })

  it('writes act claim for delegation with actor id token', async () => {
    const tenant = await buildTestTenant()
    const { ctx, kekB64 } = tenant
    const now = Math.floor(Date.now() / 1000)
    const subjectToken = await mintSubjectAccessToken(ctx, kekB64, 'openid profile', now)
    const material = ctx.signingKeys.keys[0]!
    const key = await loadSigningKey(material.encryptedPrivateKey, decodeKek(kekB64))
    const actorClaims = buildIdTokenClaims({
      ctx,
      subject: { userId: 'actor_1' },
      clientId: CLIENT_ID,
      authContext: {},
      scope: 'openid',
      now,
      ttlSec: 3600,
    })
    const actorToken = await signClaims(ctx, key, actorClaims)
    const tc = await makeGrantContext(
      {
        form: {
          subject_token: subjectToken,
          subject_token_type: SUBJECT_ACCESS,
          actor_token: actorToken,
          actor_token_type: SUBJECT_ID,
        },
        now,
      },
      tenant,
    )
    const result = await grantTokenExchange(tc)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value['access_token']).toBeTypeOf('string')
    }
  })
})
