import { describe, it, expect } from 'vitest'
import { exportPublicJwk, sha256Hex, signJwt } from '@xid-kit/crypto'
import type { Context } from 'hono'

import { PRIVATE_KEY_JWT_ASSERTION_TYPE, authenticateClient, parseBasicAuth } from '../client-auth'
import type { XidHonoEnv } from '../../lib/types'
import type { ClientRow } from '../shared'
import { buildTestTenant, makeEnv, makeOauthStateNs } from './helpers'

const CLIENT_ID = 'cli_app'
const TOKEN_ENDPOINT = 'https://acme.xid.dev/token'

function makeClient(overrides: Partial<ClientRow> = {}): ClientRow {
  return {
    id: 'app_1',
    tenantId: 't_1',
    clientId: CLIENT_ID,
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

function asContext(ctx: Awaited<ReturnType<typeof buildTestTenant>>['ctx'], env: Env) {
  return {
    env,
    get: (key: string) => (key === 'tenant' ? ctx : undefined),
  } as Context<XidHonoEnv>
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

describe('parseBasicAuth', () => {
  it('parses valid Basic credentials', () => {
    const creds = btoa(`${CLIENT_ID}:secret_value`)
    expect(parseBasicAuth(`Basic ${creds}`)).toEqual({
      clientId: CLIENT_ID,
      secret: 'secret_value',
    })
  })

  it('returns null for missing or malformed Basic header', () => {
    expect(parseBasicAuth(undefined)).toBeNull()
    expect(parseBasicAuth('Bearer token')).toBeNull()
    expect(parseBasicAuth('Basic not-valid-base64%%%')).toBeNull()
  })
})

describe('authenticateClient', () => {
  it('accepts none auth for public clients', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({})
    const result = await authenticateClient({
      c: asContext(ctx, env),
      client: makeClient({ clientType: 'public', tokenEndpointAuthMethod: 'none' }),
      creds: {
        basic: null,
        postClientId: CLIENT_ID,
        postSecret: null,
        assertionType: null,
        assertion: null,
      },
      ctx,
      tokenEndpoint: TOKEN_ENDPOINT,
      now: Math.floor(Date.now() / 1000),
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.clientId).toBe(CLIENT_ID)
  })

  it.each([
    {
      name: 'secret',
      creds: {
        basic: null,
        postClientId: CLIENT_ID,
        postSecret: 'unexpected',
        assertionType: null,
        assertion: null,
      },
    },
    {
      name: 'assertion',
      creds: {
        basic: null,
        postClientId: CLIENT_ID,
        postSecret: null,
        assertionType: PRIVATE_KEY_JWT_ASSERTION_TYPE,
        assertion: 'unexpected',
      },
    },
  ])('rejects $name credentials attached to none auth', async ({ creds }) => {
    const { ctx } = await buildTestTenant()
    const result = await authenticateClient({
      c: asContext(ctx, makeEnv({})),
      client: makeClient({ clientType: 'public', tokenEndpointAuthMethod: 'none' }),
      creds,
      ctx,
      tokenEndpoint: TOKEN_ENDPOINT,
      now: Math.floor(Date.now() / 1000),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_client')
  })

  it('rejects Basic and body client_id mismatch before authentication', async () => {
    const { ctx } = await buildTestTenant()
    const result = await authenticateClient({
      c: asContext(ctx, makeEnv({})),
      client: makeClient({ tokenEndpointAuthMethod: 'client_secret_basic' }),
      creds: {
        basic: { clientId: CLIENT_ID, secret: 'secret' },
        postClientId: 'different-client',
        postSecret: null,
        assertionType: null,
        assertion: null,
      },
      ctx,
      tokenEndpoint: TOKEN_ENDPOINT,
      now: Math.floor(Date.now() / 1000),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_request')
  })

  it.each([
    {
      name: 'registered Basic with body secret',
      method: 'client_secret_basic' as const,
      creds: {
        basic: null,
        postClientId: CLIENT_ID,
        postSecret: 'secret',
        assertionType: null,
        assertion: null,
      },
    },
    {
      name: 'registered post with Basic credentials',
      method: 'client_secret_post' as const,
      creds: {
        basic: { clientId: CLIENT_ID, secret: 'secret' },
        postClientId: CLIENT_ID,
        postSecret: null,
        assertionType: null,
        assertion: null,
      },
    },
  ])('rejects auth method mismatch: $name', async ({ method, creds }) => {
    const { ctx } = await buildTestTenant()
    const result = await authenticateClient({
      c: asContext(ctx, makeEnv({})),
      client: makeClient({
        clientSecretHash: await sha256Hex('secret'),
        tokenEndpointAuthMethod: method,
      }),
      creds,
      ctx,
      tokenEndpoint: TOKEN_ENDPOINT,
      now: Math.floor(Date.now() / 1000),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_client')
  })

  it('rejects malformed or unsupported Authorization headers', async () => {
    const { ctx } = await buildTestTenant()
    const result = await authenticateClient({
      c: asContext(ctx, makeEnv({})),
      client: makeClient({ tokenEndpointAuthMethod: 'none' }),
      creds: {
        basic: null,
        postClientId: CLIENT_ID,
        postSecret: null,
        assertionType: null,
        assertion: null,
        authorizationHeaderPresent: true,
      },
      ctx,
      tokenEndpoint: TOKEN_ENDPOINT,
      now: Math.floor(Date.now() / 1000),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_client')
  })

  it('rejects multiple authentication methods', async () => {
    const { ctx } = await buildTestTenant()
    const secretHash = await sha256Hex('secret')
    const env = makeEnv({})
    const result = await authenticateClient({
      c: asContext(ctx, env),
      client: makeClient({
        clientSecretHash: secretHash,
        tokenEndpointAuthMethod: 'client_secret_basic',
      }),
      creds: {
        basic: { clientId: CLIENT_ID, secret: 'secret' },
        postClientId: CLIENT_ID,
        postSecret: 'secret',
        assertionType: null,
        assertion: null,
      },
      ctx,
      tokenEndpoint: TOKEN_ENDPOINT,
      now: Math.floor(Date.now() / 1000),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_request')
  })

  it('verifies client_secret_basic with constant-time hash compare', async () => {
    const { ctx } = await buildTestTenant()
    const secret = 'correct_secret'
    const env = makeEnv({})
    const ok = await authenticateClient({
      c: asContext(ctx, env),
      client: makeClient({
        clientSecretHash: await sha256Hex(secret),
        tokenEndpointAuthMethod: 'client_secret_basic',
      }),
      creds: {
        basic: { clientId: CLIENT_ID, secret },
        postClientId: CLIENT_ID,
        postSecret: null,
        assertionType: null,
        assertion: null,
      },
      ctx,
      tokenEndpoint: TOKEN_ENDPOINT,
      now: Math.floor(Date.now() / 1000),
    })
    expect(ok.ok).toBe(true)

    const bad = await authenticateClient({
      c: asContext(ctx, env),
      client: makeClient({
        clientSecretHash: await sha256Hex(secret),
        tokenEndpointAuthMethod: 'client_secret_basic',
      }),
      creds: {
        basic: { clientId: CLIENT_ID, secret: 'wrong_secret' },
        postClientId: CLIENT_ID,
        postSecret: null,
        assertionType: null,
        assertion: null,
      },
      ctx,
      tokenEndpoint: TOKEN_ENDPOINT,
      now: Math.floor(Date.now() / 1000),
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe('invalid_client')
  })

  it('verifies private_key_jwt and rejects jti replay', async () => {
    const { ctx } = await buildTestTenant()
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])
    const jwk = await exportPublicJwk(pair.publicKey, 'ckid', 'ES256')
    const now = Math.floor(Date.now() / 1000)
    const assertion = await signJwt(
      {
        header: { alg: 'ES256', kid: 'ckid' },
        payload: {
          iss: CLIENT_ID,
          sub: CLIENT_ID,
          aud: TOKEN_ENDPOINT,
          jti: 'pkjwt-jti-1',
          exp: now + 120,
          iat: now,
        },
      },
      pair.privateKey,
    )
    const env = makeEnv({ OAUTH_STATE: makeOauthStateNs() })
    const input = {
      c: asContext(ctx, env),
      client: makeClient({
        tokenEndpointAuthMethod: 'private_key_jwt',
        jwks: { keys: [jwk] },
      }),
      creds: {
        basic: null,
        postClientId: CLIENT_ID,
        postSecret: null,
        assertionType: PRIVATE_KEY_JWT_ASSERTION_TYPE,
        assertion,
      },
      ctx,
      tokenEndpoint: TOKEN_ENDPOINT,
      now,
    }
    const first = await authenticateClient(input)
    expect(first.ok).toBe(true)
    const second = await authenticateClient(input)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.message).toContain('replayed')
  })

  it('rejects private_key_jwt when the jti claim store is unavailable', async () => {
    const { ctx } = await buildTestTenant()
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])
    const jwk = await exportPublicJwk(pair.publicKey, 'ckid', 'ES256')
    const now = Math.floor(Date.now() / 1000)
    const assertion = await signJwt(
      {
        header: { alg: 'ES256', kid: 'ckid' },
        payload: {
          iss: CLIENT_ID,
          sub: CLIENT_ID,
          aud: TOKEN_ENDPOINT,
          jti: 'pkjwt-claim-fails',
          exp: now + 120,
          iat: now,
        },
      },
      pair.privateKey,
    )
    const env = makeEnv({ OAUTH_STATE: failingClaimNs() })

    const result = await authenticateClient({
      c: asContext(ctx, env),
      client: makeClient({
        tokenEndpointAuthMethod: 'private_key_jwt',
        jwks: { keys: [jwk] },
      }),
      creds: {
        basic: null,
        postClientId: CLIENT_ID,
        postSecret: null,
        assertionType: PRIVATE_KEY_JWT_ASSERTION_TYPE,
        assertion,
      },
      ctx,
      tokenEndpoint: TOKEN_ENDPOINT,
      now,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('server_error')
      expect(result.error.httpStatus).toBe(500)
    }
  })

  it('rejects private key material in a legacy stored client JWKS', async () => {
    const { ctx } = await buildTestTenant()
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])
    const publicJwk = await exportPublicJwk(pair.publicKey, 'ckid', 'ES256')
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
    const result = await authenticateClient({
      c: asContext(ctx, makeEnv({ OAUTH_STATE: makeOauthStateNs() })),
      client: makeClient({
        tokenEndpointAuthMethod: 'private_key_jwt',
        jwks: { keys: [{ ...publicJwk, d: privateJwk.d }] },
      }),
      creds: {
        basic: null,
        postClientId: CLIENT_ID,
        postSecret: null,
        assertionType: PRIVATE_KEY_JWT_ASSERTION_TYPE,
        assertion: 'not-reached',
      },
      ctx,
      tokenEndpoint: TOKEN_ENDPOINT,
      now: Math.floor(Date.now() / 1000),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('valid registered public jwks')
  })
})
