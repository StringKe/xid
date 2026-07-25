import { describe, it, expect } from 'vitest'
import { exportPublicJwk, signJwt } from '@xid-kit/crypto'

import { resolveRequestObject } from '../request-object'
import type { ClientRow } from '../shared'
import { buildTestTenant, makeEnv, makeOauthStateNs } from './helpers'

const CLIENT_ID = 'cli_app'

function makeClient(overrides: Partial<ClientRow> = {}): ClientRow {
  return {
    id: 'app_1',
    tenantId: 't_1',
    clientId: CLIENT_ID,
    clientSecretHash: null,
    clientType: 'public',
    tokenEndpointAuthMethod: 'none',
    jwks: null,
    redirectUris: ['https://rp.example/cb'],
    postLogoutRedirectUris: [],
    allowedGrantTypes: ['authorization_code'],
    allowedResponseTypes: ['code'],
    allowedScopes: ['openid', 'profile'],
    requirePkce: true,
    dpopBoundAccessTokens: false,
    accessTokenFormat: 'jwt',
    accessTokenTtlSec: 3600,
    idTokenSignedAlg: 'ES256',
    firstParty: true,
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

async function makeClientKeyPair(): Promise<{
  privateKey: CryptoKey
  jwk: Record<string, unknown>
}> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const jwk = await exportPublicJwk(pair.publicKey, 'ckid', 'ES256')
  return { privateKey: pair.privateKey, jwk: jwk as unknown as Record<string, unknown> }
}

function asContext(ctx: Awaited<ReturnType<typeof buildTestTenant>>['ctx'], env: Env) {
  return {
    env,
    get: (key: string) => (key === 'tenant' ? ctx : undefined),
  } as import('hono').Context<import('../../lib/types').XidHonoEnv>
}

// OAuthFlowDO /claim 故障:既不是 201(占用成功)也不是 409(重放)。
function failingClaimNs(): DurableObjectNamespace {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response('claim failed', { status: 500 }),
    }),
  } as unknown as DurableObjectNamespace
}

describe('resolveRequestObject', () => {
  it('passes through params when request is absent', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({})
    const params = { client_id: CLIENT_ID, scope: 'openid' }
    const result = await resolveRequestObject({
      c: asContext(ctx, env),
      params,
      client: makeClient(),
      now: Math.floor(Date.now() / 1000),
    })
    expect(result).toEqual({ ok: true, params })
  })

  it('verifies signed request object and merges OAuth parameters', async () => {
    const { ctx } = await buildTestTenant()
    const { privateKey, jwk } = await makeClientKeyPair()
    const env = makeEnv({ OAUTH_STATE: makeOauthStateNs() })
    const now = Math.floor(Date.now() / 1000)
    const request = await signJwt(
      {
        header: { alg: 'ES256', kid: 'ckid' },
        payload: {
          iss: CLIENT_ID,
          aud: ctx.issuer,
          exp: now + 120,
          nbf: now - 1,
          iat: now,
          jti: 'jar-jti-1',
          response_type: 'code',
          client_id: CLIENT_ID,
          redirect_uri: 'https://rp.example/cb',
          scope: 'openid profile',
          state: 'st_jar',
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          code_challenge_method: 'S256',
        },
      },
      privateKey,
    )
    const result = await resolveRequestObject({
      c: asContext(ctx, env),
      params: { client_id: CLIENT_ID, request },
      client: makeClient({ jwks: { keys: [jwk] } }),
      now,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.params['scope']).toBe('openid profile')
      expect(result.params['state']).toBe('st_jar')
      expect(result.params['code_challenge_method']).toBe('S256')
    }
  })

  it('rejects request object when client has no registered JWKS', async () => {
    const { ctx } = await buildTestTenant()
    const { privateKey } = await makeClientKeyPair()
    const env = makeEnv({})
    const now = Math.floor(Date.now() / 1000)
    const request = await signJwt(
      {
        header: { alg: 'ES256', kid: 'ckid' },
        payload: {
          iss: CLIENT_ID,
          aud: ctx.issuer,
          exp: now + 120,
          nbf: now - 1,
          jti: 'jar-no-jwks',
          client_id: CLIENT_ID,
        },
      },
      privateKey,
    )
    const result = await resolveRequestObject({
      c: asContext(ctx, env),
      params: { client_id: CLIENT_ID, request },
      client: makeClient(),
      now,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('invalid_request_object')
      expect(result.description).toContain('no registered jwks')
    }
  })

  it('rejects replayed request object jti', async () => {
    const { ctx } = await buildTestTenant()
    const { privateKey, jwk } = await makeClientKeyPair()
    const env = makeEnv({ OAUTH_STATE: makeOauthStateNs() })
    const now = Math.floor(Date.now() / 1000)
    const request = await signJwt(
      {
        header: { alg: 'ES256', kid: 'ckid' },
        payload: {
          iss: CLIENT_ID,
          aud: `${ctx.issuer}/authorize`,
          exp: now + 120,
          nbf: now - 1,
          jti: 'jar-replay',
          client_id: CLIENT_ID,
          response_type: 'code',
          redirect_uri: 'https://rp.example/cb',
        },
      },
      privateKey,
    )
    const input = {
      c: asContext(ctx, env),
      params: { client_id: CLIENT_ID, request },
      client: makeClient({ jwks: { keys: [jwk] } }),
      now,
    }
    const first = await resolveRequestObject(input)
    const second = await resolveRequestObject(input)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.description).toContain('jti replayed')
  })

  it('fails closed when the request object jti claim store is unavailable', async () => {
    const { ctx } = await buildTestTenant()
    const { privateKey, jwk } = await makeClientKeyPair()
    const env = makeEnv({ OAUTH_STATE: failingClaimNs() })
    const now = Math.floor(Date.now() / 1000)
    const request = await signJwt(
      {
        header: { alg: 'ES256', kid: 'ckid' },
        payload: {
          iss: CLIENT_ID,
          aud: `${ctx.issuer}/authorize`,
          exp: now + 120,
          nbf: now - 1,
          jti: 'jar-claim-fails',
          client_id: CLIENT_ID,
          response_type: 'code',
          redirect_uri: 'https://rp.example/cb',
        },
      },
      privateKey,
    )

    const result = await resolveRequestObject({
      c: asContext(ctx, env),
      params: { client_id: CLIENT_ID, request },
      client: makeClient({ jwks: { keys: [jwk] } }),
      now,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('server_error')
      expect(result.description).toContain('replay protection unavailable')
    }
  })

  it('rejects request object with missing nbf', async () => {
    const { ctx } = await buildTestTenant()
    const { privateKey, jwk } = await makeClientKeyPair()
    const env = makeEnv({ OAUTH_STATE: makeOauthStateNs() })
    const now = Math.floor(Date.now() / 1000)
    const request = await signJwt(
      {
        header: { alg: 'ES256', kid: 'ckid' },
        payload: {
          iss: CLIENT_ID,
          aud: ctx.issuer,
          exp: now + 120,
          jti: 'jar-no-nbf',
          client_id: CLIENT_ID,
        },
      },
      privateKey,
    )
    const result = await resolveRequestObject({
      c: asContext(ctx, env),
      params: { client_id: CLIENT_ID, request },
      client: makeClient({ jwks: { keys: [jwk] } }),
      now,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.description).toContain('nbf required')
  })
})
