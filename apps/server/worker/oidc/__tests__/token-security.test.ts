// /token 端点安全修复测试(对抗审查):
// - private_key_jwt jti 一次性防重放(同 assertion 二次提交被拒)
// - audience(RFC8707 resource)白名单:已注册放行,未注册 invalid_target
// - refresh 原子轮换:条件 UPDATE 受影响行=0(并发双花)-> invalid_grant + family 吊销

import { describe, it, expect } from 'vitest'
import { signJwt, exportPublicJwk } from '@xid-kit/crypto'
import { generateRefreshToken, hashRefreshToken } from '@xid-kit/protocol'
import type { TenantContext } from '@xid-kit/types'
import { registerTokenRoutes } from '../token'
import {
  buildTestTenant,
  makeApp,
  makeEnv,
  makeFakeD1,
  makeFakeKv,
  makeOauthStateNs,
  type TableSet,
} from './helpers'

const CLIENT_ID = 'cli_pkjwt'
const USER_ID = 'u_1'

// 生成 ES256 client 密钥对:私钥签 client_assertion,公钥入 client.jwks。
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

async function signAssertion(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
): Promise<string> {
  return signJwt({ header: { alg: 'ES256', kid: 'ckid' }, payload: claims }, privateKey)
}

async function pkJwtAppRow(jwk: Record<string, unknown>): Promise<Record<string, unknown>> {
  return {
    id: 'app_pk',
    tenant_id: 't_1',
    client_id: CLIENT_ID,
    client_secret_hash: null,
    client_type: 'confidential',
    token_endpoint_auth_method: 'private_key_jwt',
    jwks: JSON.stringify({ keys: [jwk] }),
    redirect_uris: JSON.stringify([]),
    post_logout_redirect_uris: JSON.stringify([]),
    allowed_grant_types: JSON.stringify(['client_credentials']),
    allowed_response_types: JSON.stringify(['code']),
    allowed_scopes: JSON.stringify(['api.read']),
    require_pkce: 0,
    dpop_bound_access_tokens: 0,
    access_token_format: 'jwt',
    access_token_ttl_sec: 3600,
    id_token_signed_alg: 'ES256',
    first_party: 0,
    require_org_context: 0,
    custom_claims_config: JSON.stringify({}),
    registration_access_token_hash: null,
    project_id: null,
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
  }
}

async function postForm(
  app: ReturnType<typeof makeApp>,
  env: Env,
  body: Record<string, string>,
): Promise<Response> {
  return app.request(
    'https://acme.xid.dev/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    },
    env,
  )
}

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

async function setupPkJwt(
  ctx: TenantContext,
  kekB64: string,
  jwk: Record<string, unknown>,
): Promise<{ app: ReturnType<typeof makeApp>; env: Env }> {
  const env = makeEnv({
    DB: makeFakeD1({ applications: [await pkJwtAppRow(jwk)] }),
    CACHE: makeFakeKv(),
    KEK: kekB64,
    OAUTH_STATE: makeOauthStateNs(),
  })
  return { app: makeApp(ctx, registerTokenRoutes), env }
}

describe('/token private_key_jwt jti 防重放', () => {
  it('首次 client_assertion 成功,相同 jti 二次提交 -> invalid_client', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const { privateKey, jwk } = await makeClientKeyPair()
    const { app, env } = await setupPkJwt(ctx, kekB64, jwk)
    const now = Math.floor(Date.now() / 1000)
    const assertion = await signAssertion(privateKey, {
      iss: CLIENT_ID,
      sub: CLIENT_ID,
      aud: 'https://acme.xid.dev/token',
      jti: 'jti-unique-1',
      exp: now + 120,
      iat: now,
    })
    const body = {
      grant_type: 'client_credentials',
      scope: 'api.read',
      client_id: CLIENT_ID,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: assertion,
    }
    const first = await postForm(app, env, body)
    expect(first.status).toBe(200)
    const second = await postForm(app, env, body)
    expect(second.status).toBe(401)
    expect(((await second.json()) as Record<string, string>)['error']).toBe('invalid_client')
  })

  it('缺 jti 的 client_assertion -> invalid_client', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const { privateKey, jwk } = await makeClientKeyPair()
    const { app, env } = await setupPkJwt(ctx, kekB64, jwk)
    const now = Math.floor(Date.now() / 1000)
    const assertion = await signAssertion(privateKey, {
      iss: CLIENT_ID,
      sub: CLIENT_ID,
      aud: 'https://acme.xid.dev/token',
      exp: now + 120,
      iat: now,
    })
    const res = await postForm(app, env, {
      grant_type: 'client_credentials',
      scope: 'api.read',
      client_id: CLIENT_ID,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: assertion,
    })
    expect(res.status).toBe(401)
  })
})

function ccAppRow(): Record<string, unknown> {
  return {
    id: 'app_cc',
    tenant_id: 't_1',
    client_id: 'cli_cc',
    client_secret_hash: null,
    client_type: 'confidential',
    token_endpoint_auth_method: 'client_secret_post',
    jwks: null,
    redirect_uris: JSON.stringify([]),
    post_logout_redirect_uris: JSON.stringify([]),
    allowed_grant_types: JSON.stringify(['client_credentials']),
    allowed_response_types: JSON.stringify(['code']),
    allowed_scopes: JSON.stringify(['api.read']),
    require_pkce: 0,
    dpop_bound_access_tokens: 0,
    access_token_format: 'jwt',
    access_token_ttl_sec: 3600,
    id_token_signed_alg: 'ES256',
    first_party: 0,
    require_org_context: 0,
    custom_claims_config: JSON.stringify({}),
    registration_access_token_hash: null,
    project_id: null,
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
  }
}

function resourceServerRow(audience: string): Record<string, unknown> {
  return {
    id: 'rs_1',
    tenant_id: 't_1',
    name: 'API',
    audience,
    scopes: JSON.stringify(['api.read']),
    access_token_format: 'jwt',
    signing_alg: 'ES256',
    created_at: Date.now(),
    updated_at: Date.now(),
  }
}

const CC_SECRET = 'cc_secret'

describe('/token client_credentials audience 白名单', () => {
  async function setupCc(
    tables: TableSet,
    ctx: TenantContext,
    kekB64: string,
  ): Promise<{ app: ReturnType<typeof makeApp>; env: Env }> {
    const env = makeEnv({ DB: makeFakeD1(tables), CACHE: makeFakeKv(), KEK: kekB64 })
    return { app: makeApp(ctx, registerTokenRoutes), env }
  }

  it('已注册 resource(audience)放行 200', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const { sha256Hex } = await import('@xid-kit/crypto')
    const row = ccAppRow()
    row['client_secret_hash'] = await sha256Hex(CC_SECRET)
    const tables: TableSet = {
      applications: [row],
      resource_servers: [resourceServerRow('https://api.example/v1')],
    }
    const { app, env } = await setupCc(tables, ctx, kekB64)
    const res = await postForm(app, env, {
      grant_type: 'client_credentials',
      scope: 'api.read',
      resource: 'https://api.example/v1',
      client_id: 'cli_cc',
      client_secret: CC_SECRET,
    })
    expect(res.status).toBe(200)
  })

  it('未注册 resource -> invalid_target', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const { sha256Hex } = await import('@xid-kit/crypto')
    const row = ccAppRow()
    row['client_secret_hash'] = await sha256Hex(CC_SECRET)
    const tables: TableSet = { applications: [row], resource_servers: [] }
    const { app, env } = await setupCc(tables, ctx, kekB64)
    const res = await postForm(app, env, {
      grant_type: 'client_credentials',
      scope: 'api.read',
      resource: 'https://unregistered.example/v1',
      client_id: 'cli_cc',
      client_secret: CC_SECRET,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as Record<string, string>)['error']).toBe('invalid_target')
  })
})

function refreshAppRow(): Record<string, unknown> {
  const row = ccAppRow()
  row['client_id'] = 'cli_rt'
  row['id'] = 'app_rt'
  row['allowed_grant_types'] = JSON.stringify(['refresh_token'])
  row['allowed_scopes'] = JSON.stringify(['openid', 'offline_access'])
  return row
}

// 模拟并发双花的 D1 fake:SELECT 返回 revoked_at=null 快照(过 detectReplay 初检),
// 但条件 UPDATE(token_hash AND revoked_at IS NULL)返回 0 行(已被并发请求抢先轮换)。
// 解耦读快照与写结果:appRow 用普通行;refreshRow 的 SELECT 永远 revoked_at=null,UPDATE 永远 0 行。
function makeDoubleSpendD1(
  appRow: Record<string, unknown>,
  refreshSnapshot: Record<string, unknown>,
): D1Database {
  const asUnknown = <T>(v: unknown): T => v as T
  const projCols = (sql: string): string[] => {
    const ret = /returning\s+(.+)$/i.exec(sql)
    const head = ret ? ret[1] : /^select\s+(.+?)\s+from\s/i.exec(sql)?.[1]
    if (!head) return []
    return [...head.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? '')
  }
  const toRaw = (sql: string, r: Record<string, unknown>): unknown[] =>
    projCols(sql).map((c) => r[c] ?? null)
  const match = (sql: string, params: unknown[]): Record<string, unknown>[] => {
    const l = sql.toLowerCase()
    const isApps = l.includes('applications')
    if (l.startsWith('update')) {
      // applications 不参与;refresh_tokens 条件 UPDATE 恒返回 0 行(模拟并发抢先)。
      return isApps ? [appRow] : []
    }
    if (l.startsWith('insert')) return []
    // SELECT:refresh_tokens 返回 revoked_at=null 快照(让 detectReplay 通过初检)。
    const rows = isApps ? [appRow] : [refreshSnapshot]
    const sp = params.filter((v): v is string => typeof v === 'string')
    return rows.filter((r) => sp.every((v) => Object.values(r).includes(v)))
  }
  const prepare = (sql: string): unknown => {
    let bound: unknown[] = []
    const stmt = {
      bind: (...p: unknown[]) => {
        bound = p
        return stmt
      },
      raw: async () => match(sql, bound).map((r) => toRaw(sql, r)),
      all: async () => ({ results: match(sql, bound), success: true, meta: {} }),
      run: async () => ({ results: [], success: true, meta: {} }),
    }
    return stmt
  }
  return asUnknown<D1Database>({ prepare, batch: async () => [] })
}

describe('/token refresh 原子轮换(双花)', () => {
  it('条件 UPDATE 0 行(并发已轮换)-> invalid_grant + 撤销 family', async () => {
    const { ctx, kekB64 } = await buildTestTenant()
    const { sha256Hex } = await import('@xid-kit/crypto')
    const token = generateRefreshToken()
    const hash = await hashRefreshToken(token)
    const appRow = refreshAppRow()
    appRow['client_secret_hash'] = await sha256Hex(CC_SECRET)
    // SELECT 快照:revoked_at=null(过 detectReplay 初检),但条件 UPDATE 因并发抢先返回 0 行。
    const refreshSnapshot: Record<string, unknown> = {
      id: 'rt_id_1',
      tenant_id: 't_1',
      token_hash: hash,
      family_id: 'fam_1',
      parent_token_id: null,
      user_id: USER_ID,
      client_id: 'cli_rt',
      scope: 'openid offline_access',
      jkt: null,
      revoked_at: null,
      expires_at: Date.now() + 30 * 24 * 3600 * 1000,
      absolute_expires_at: Date.now() + 7 * 24 * 3600 * 1000,
      created_at: Date.now(),
    }
    const env = makeEnv({
      DB: makeDoubleSpendD1(appRow, refreshSnapshot),
      CACHE: makeFakeKv(),
      KEK: kekB64,
    })
    const app = makeApp(ctx, registerTokenRoutes)
    const res = await postForm(app, env, {
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: 'cli_rt',
      client_secret: CC_SECRET,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as Record<string, string>)['error']).toBe('invalid_grant')
  })
})
