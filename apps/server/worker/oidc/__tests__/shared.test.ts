import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'

import type { XidHonoEnv } from '../../lib/types'
import {
  decodeKek,
  endpointUrl,
  findClient,
  handlePublicClientOptions,
  oauthError,
  refreshTtlSecOf,
  resolveAccessTtlSec,
  tokenJson,
  tokenPolicyOf,
} from '../shared'
import { DEFAULT_TOKEN_POLICY } from '@xid-kit/types'
import type { TenantContext, TokenPolicy } from '@xid-kit/types'
import { buildTestTenant, makeApp, makeEnv, makeFakeD1 } from './helpers'

describe('decodeKek', () => {
  it('decodes base64 KEK to 32 bytes', () => {
    const raw = crypto.getRandomValues(new Uint8Array(32))
    let binary = ''
    for (const b of raw) binary += String.fromCharCode(b)
    const decoded = decodeKek(btoa(binary))
    expect(decoded).toEqual(raw)
  })
})

describe('endpointUrl', () => {
  it('joins issuer and path without duplicate slashes', () => {
    const ctx = { issuer: 'https://xid.dev' } as TenantContext
    expect(endpointUrl(ctx, '/token')).toBe('https://xid.dev/token')
    expect(endpointUrl(ctx, 'jwks')).toBe('https://xid.devjwks')
  })
})

describe('oauthError', () => {
  it('returns RFC6749 JSON with no-store headers', async () => {
    const app = new Hono<XidHonoEnv>()
    app.get('/err', (c) =>
      oauthError(c, {
        status: 400,
        error: 'invalid_request',
        description: 'missing client_id',
        extraHeaders: { 'www-authenticate': 'Bearer' },
      }),
    )
    const res = await app.request('/err')
    expect(res.status).toBe(400)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
    const body = (await res.json()) as { error: string; error_description: string }
    expect(body.error).toBe('invalid_request')
    expect(body.error_description).toBe('missing client_id')
  })
})

describe('tokenJson', () => {
  it('returns token response with no-store', async () => {
    const app = new Hono<XidHonoEnv>()
    app.get('/ok', (c) => tokenJson(c, { access_token: 'at', token_type: 'Bearer' }))
    const res = await app.request('/ok')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ access_token: 'at', token_type: 'Bearer' })
  })
})

describe('token policy helpers', () => {
  const customPolicy: TokenPolicy = {
    accessTokenTtlSec: 7200,
    sessionTokenTtlSec: 90,
    refreshIdleTimeoutDays: 2,
    refreshAbsoluteTimeoutDays: 3,
  }

  function ctxWithToken(token?: TokenPolicy): TenantContext {
    return { policy: token === undefined ? {} : { token } } as TenantContext
  }

  it('tokenPolicyOf 缺省回退内置默认', () => {
    expect(tokenPolicyOf(ctxWithToken())).toEqual(DEFAULT_TOKEN_POLICY)
    expect(tokenPolicyOf(ctxWithToken(customPolicy))).toEqual(customPolicy)
  })

  it('resolveAccessTtlSec: client 覆盖 > 租户策略 > 内置默认', () => {
    expect(resolveAccessTtlSec(ctxWithToken(customPolicy), 120)).toBe(120)
    expect(resolveAccessTtlSec(ctxWithToken(customPolicy), null)).toBe(7200)
    expect(resolveAccessTtlSec(ctxWithToken(), null)).toBe(DEFAULT_TOKEN_POLICY.accessTokenTtlSec)
  })

  it('refreshTtlSecOf 天换算秒', () => {
    expect(refreshTtlSecOf(ctxWithToken(customPolicy))).toEqual({
      idleTtlSec: 2 * 86400,
      absoluteTtlSec: 3 * 86400,
    })
    expect(refreshTtlSecOf(ctxWithToken())).toEqual({
      idleTtlSec: 30 * 86400,
      absoluteTtlSec: 7 * 86400,
    })
  })
})

describe('findClient Project lifecycle', () => {
  async function lookup(projectStatus: 'active' | 'deleted'): Promise<Response> {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({
      DB: makeFakeD1({
        applications: [
          {
            id: 'app_1',
            tenant_id: 't_1',
            client_id: 'cli_project',
            project_id: 'proj_1',
            client_secret_hash: null,
            client_type: 'public',
            token_endpoint_auth_method: 'none',
            jwks: null,
            status: 'active',
            redirect_uris: '[]',
            post_logout_redirect_uris: '[]',
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
            custom_claims_config: '{}',
            registration_access_token_hash: null,
            backchannel_logout_uri: null,
            frontchannel_logout_uri: null,
            created_at: Date.now(),
            updated_at: Date.now(),
          },
        ],
        projects: [
          {
            id: 'proj_1',
            tenant_id: 't_1',
            org_id: 'org_1',
            name: 'Project',
            description: null,
            status: projectStatus,
            deleted_at: projectStatus === 'deleted' ? Date.now() : null,
            created_at: Date.now(),
            updated_at: Date.now(),
          },
        ],
      }),
    })
    const app = makeApp(ctx, (honoApp) => {
      honoApp.get('/client', async (c) => {
        const client = await findClient(c, 'cli_project')
        return c.json({ id: client?.id ?? null })
      })
    })
    return app.request('/client', undefined, env)
  }

  it('returns a Project-linked client only while the Project is active', async () => {
    expect(await (await lookup('active')).json()).toEqual({ id: 'app_1' })
    expect(await (await lookup('deleted')).json()).toEqual({ id: null })
  })
})

// OPTIONS 预检必须按 query client_id 校验 origin 白名单:不在白名单/未知 client 均不回 ACAO。
describe('handlePublicClientOptions', () => {
  const CLIENT_ID = 'cli_pub'
  const CORS_OPTS = { methods: ['POST'], allowHeaders: 'authorization,content-type' } as const

  function publicClientRow(): Record<string, unknown> {
    return {
      id: 'app_1',
      tenant_id: 't_1',
      client_id: CLIENT_ID,
      client_secret_hash: null,
      client_type: 'public',
      token_endpoint_auth_method: 'none',
      jwks: null,
      status: 'active',
      redirect_uris: JSON.stringify(['https://spa.example/cb']),
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
      created_at: Date.now(),
      updated_at: Date.now(),
    }
  }

  async function preflight(input: {
    clientId?: string
    origin: string
    applications?: Record<string, unknown>[]
  }): Promise<Response> {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({
      DB: makeFakeD1({ applications: input.applications ?? [publicClientRow()] }),
    })
    const app = makeApp(ctx, (honoApp) => {
      honoApp.options('/token', (c) => handlePublicClientOptions(c, CORS_OPTS))
    })
    const query = input.clientId === undefined ? '' : `?client_id=${input.clientId}`
    return app.request(
      `/token${query}`,
      {
        method: 'OPTIONS',
        headers: { origin: input.origin, 'access-control-request-method': 'POST' },
      },
      env,
    )
  }

  it('origin 在 client redirectUris origin 白名单 -> 204 回 ACAO', async () => {
    const res = await preflight({ clientId: CLIENT_ID, origin: 'https://spa.example' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://spa.example')
  })

  it('origin 不在白名单 -> 204 不回 ACAO', async () => {
    const res = await preflight({ clientId: CLIENT_ID, origin: 'https://evil.example' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('client_id 未知 -> 204 不回 ACAO', async () => {
    const res = await preflight({ clientId: 'cli_unknown', origin: 'https://spa.example' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('缺 client_id -> 204 不回 ACAO', async () => {
    const res = await preflight({ origin: 'https://spa.example' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})
