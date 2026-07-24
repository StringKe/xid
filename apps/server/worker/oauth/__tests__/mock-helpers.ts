// 测试用共享 mock 辅助:Env / TenantContext / D1 fake / DO fake。
// 不导出 vitest 断言,只导出 factory 函数。

import type { ErrorHandler } from 'hono'
import type { TenantContext } from '@xid-kit/types'
import type { XidHonoEnv } from '../../lib/types'
import { isAppError } from '../../lib/errors'

// 轻量 error handler(测试专用,不依赖 lingui):AppError -> RFC6749 形状 { error, error_description }。
// oauth 四端点已改端点内直接回 RFC 错误,这里只兜未预期的 AppError(rate_limited / server_error)。
export const testErrorHandler: ErrorHandler<XidHonoEnv> = (err, c) => {
  if (isAppError(err)) {
    return c.json({ error: err.code, error_description: err.code }, err.httpStatus as 400)
  }
  return c.json({ error: 'server_error', error_description: 'server_error' }, 500)
}

export type AppRow = {
  id: string
  tenant_id: string
  client_id: string
  client_secret_hash: string | null
  client_type: string
  token_endpoint_auth_method: string
  jwks: null
  redirect_uris: string
  post_logout_redirect_uris: string
  allowed_grant_types: string
  allowed_response_types: string
  allowed_scopes: string
  require_pkce: number
  dpop_bound_access_tokens: number
  access_token_format: string
  access_token_ttl_sec: number | null
  id_token_signed_alg: string
  first_party: number
  require_org_context: number
  custom_claims_config: string
  registration_access_token_hash: string | null
  project_id: string | null
  frontchannel_logout_uri: string | null
  backchannel_logout_uri: string | null
  status: string
  created_at: number
  updated_at: number
}

export type RefreshRow = {
  id: string
  tenant_id: string
  token_hash: string
  family_id: string
  parent_token_id: string | null
  user_id: string
  client_id: string
  scope: string
  jkt: string | null
  revoked_at: number | null
  expires_at: number
  absolute_expires_at: number
  created_at: number
}

export type AccessTokenRevocationRow = {
  id: string
  tenant_id: string
  jti: string
  client_id: string
  subject: string | null
  expires_at: number
  revoked_at: number
  created_at: number
}

export type ResourceServerRow = {
  id: string
  tenant_id: string
  name: string
  audience: string
  scopes: string
  access_token_format: string
  signing_alg: string
  created_at: number
  updated_at: number
}

function asUnknown<T>(v: unknown): T {
  return v as T
}

function projectionColumns(sql: string): string[] {
  const ret = /returning\s+(.+)$/i.exec(sql)
  const head = ret ? ret[1] : /^select\s+(.+?)\s+from\s/i.exec(sql)?.[1]
  if (!head) return []
  return [...head.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? '')
}

function rowToRaw<T extends Record<string, unknown>>(sql: string, row: T): unknown[] {
  const cols = projectionColumns(sql)
  return cols.map((c) => (row as Record<string, unknown>)[c] ?? null)
}

type FakeD1Options = {
  apps?: AppRow[]
  refreshTokens?: RefreshRow[]
  accessTokenRevocations?: AccessTokenRevocationRow[]
  resourceServers?: ResourceServerRow[]
  onUpdate?: (table: string, values: Record<string, unknown>) => void
  onInsert?: (table: string, values: Record<string, unknown>) => void
}

function isUpdateSql(lower: string): boolean {
  return /^\s*update\s/.test(lower)
}

function isInsertSql(lower: string): boolean {
  return /^\s*insert\s/.test(lower)
}

function applyAppUpdate(row: AppRow, sql: string, params: unknown[]): void {
  const lower = sql.toLowerCase()
  // drizzle SET 顺序与 patchValues 对象序一致:updated_at 恒在前;ttl 参数是 null(清回继承)或小整数(覆盖)。
  if (lower.includes('access_token_ttl_sec')) {
    const ttl = params.find((v) => v === null || (typeof v === 'number' && v <= 86400))
    if (ttl === null || typeof ttl === 'number') row.access_token_ttl_sec = ttl
  }
  for (const value of params) {
    if (typeof value !== 'string') continue
    if (lower.includes('post_logout_redirect_uris') && value.startsWith('[')) {
      row.post_logout_redirect_uris = value
    }
    if (lower.includes('backchannel_logout_uri') && value.startsWith('https://')) {
      row.backchannel_logout_uri = value
    }
    if (lower.includes('id_token_signed_alg') && value === 'ES256') {
      row.id_token_signed_alg = value
    }
    if (lower.includes('allowed_response_types') && value.startsWith('[')) {
      row.allowed_response_types = value
    }
  }
}

function matchApps(apps: AppRow[], sql: string, params: unknown[], opts: FakeD1Options): AppRow[] {
  const lower = sql.toLowerCase()
  if (isInsertSql(lower)) {
    // INSERT: return empty to avoid JSON-mapping errors; callers should not rely on returning().
    return []
  }
  if (isUpdateSql(lower)) {
    if (opts.onUpdate) opts.onUpdate('applications', {})
    if (params.includes('revoked')) {
      for (const r of apps) r.status = 'revoked'
      return apps.slice(-1)
    }
    for (const r of apps) applyAppUpdate(r, sql, params)
    return apps.slice(-1)
  }
  const sp = params.filter((v): v is string => typeof v === 'string')
  return apps.filter((r) =>
    sp.every((v) => v === r.tenant_id || v === r.client_id || v === r.id || v === r.status),
  )
}

function matchTokens(
  tokens: RefreshRow[],
  sql: string,
  params: unknown[],
  opts: FakeD1Options,
): RefreshRow[] {
  const lower = sql.toLowerCase()
  if (isUpdateSql(lower)) {
    if (opts.onUpdate) opts.onUpdate('refresh_tokens', {})
    for (const r of tokens) r.revoked_at = Date.now()
    return []
  }
  const sp = params.filter((v): v is string => typeof v === 'string')
  return tokens.filter((r) =>
    sp.every((v) => v === r.tenant_id || v === r.token_hash || v === r.family_id),
  )
}

// resource_servers 只读:按 tenant_id 收窄(scope catalog 查询)。
function matchResourceServers(rows: ResourceServerRow[], params: unknown[]): ResourceServerRow[] {
  const sp = params.filter((v): v is string => typeof v === 'string')
  return rows.filter((r) => sp.every((v) => v === r.tenant_id))
}

function matchAccessRevocations(
  rows: AccessTokenRevocationRow[],
  sql: string,
  params: unknown[],
  opts: FakeD1Options,
): AccessTokenRevocationRow[] {
  const lower = sql.toLowerCase()
  if (isInsertSql(lower)) {
    const values = {
      id: params[0] as string,
      tenant_id: params[1] as string,
      jti: params[2] as string,
      client_id: params[3] as string,
      subject: (params[4] as string | null) ?? null,
      expires_at: params[5] as number,
      revoked_at: params[6] as number,
      created_at: params[7] as number,
    }
    rows.push(values)
    opts.onInsert?.('access_token_revocations', values)
    return [values]
  }
  const sp = params.filter((v): v is string => typeof v === 'string')
  return rows.filter((r) => sp.every((v) => v === r.tenant_id || v === r.jti))
}

export function makeFakeD1(options: FakeD1Options): D1Database {
  const apps = options.apps ?? []
  const tokens = options.refreshTokens ?? []
  const accessTokenRevocations = options.accessTokenRevocations ?? []
  const resourceServers = options.resourceServers ?? []

  const prepare = (sql: string): unknown => {
    let bound: unknown[] = []
    const table = (
      s: string,
    ): 'applications' | 'refresh_tokens' | 'access_token_revocations' | 'resource_servers' => {
      const lower = s.toLowerCase()
      if (lower.includes('access_token_revocations')) return 'access_token_revocations'
      if (lower.includes('resource_servers')) return 'resource_servers'
      if (lower.includes('applications')) return 'applications'
      return 'refresh_tokens'
    }
    const rowsFor = (s: string) => {
      const t = table(s)
      if (t === 'applications') return matchApps(apps, s, bound, options)
      if (t === 'resource_servers') return matchResourceServers(resourceServers, bound)
      if (t === 'access_token_revocations') {
        return matchAccessRevocations(accessTokenRevocations, s, bound, options)
      }
      return matchTokens(tokens, s, bound, options)
    }
    const stmt = {
      bind: (...p: unknown[]) => {
        bound = p
        return stmt
      },
      raw: async () => {
        const rows = rowsFor(sql)
        return rows.map((r) => rowToRaw(sql, r as unknown as Record<string, unknown>))
      },
      all: async () => {
        const rows = rowsFor(sql)
        return { results: rows, success: true, meta: {} }
      },
      run: async () => ({ results: [], success: true, meta: {} }),
    }
    return stmt
  }

  return asUnknown<D1Database>({ prepare, batch: async () => [] })
}

export type RateLimitNsOptions = {
  // 设 false 模拟超限(check 返回 allowed=false)。
  allowed?: boolean
  // 覆盖整个 check 响应,用于模拟 DO 不可用(非 200 / 坏响应体)的 fail-closed 路径。
  response?: Response
}

// OAUTH_STATE DO fake:claim 首次 201,同 key 重放 409。
function makeOauthStateNs(): DurableObjectNamespace {
  const seen = new Set<string>()
  const stub = {
    fetch: async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname
      const body = init?.body
        ? (JSON.parse(init.body as string) as { state: string })
        : { state: '' }
      if (path !== '/claim') return new Response('{}', { status: 404 })
      if (seen.has(body.state))
        return new Response(JSON.stringify({ code: 'replay_detected' }), { status: 409 })
      seen.add(body.state)
      return new Response(null, { status: 201 })
    },
  }
  return asUnknown<DurableObjectNamespace>({ idFromName: (n: string) => n, get: () => stub })
}

function makeRateLimiterNs(opts: RateLimitNsOptions): DurableObjectNamespace {
  const stub = {
    fetch: async () => opts.response ?? Response.json({ allowed: opts.allowed ?? true }),
  }
  return asUnknown<DurableObjectNamespace>({ idFromName: (n: string) => n, get: () => stub })
}

export function makeEnv(
  db: D1Database,
  parDoNs?: DurableObjectNamespace,
  deviceDoNs?: DurableObjectNamespace,
  rlOpts: RateLimitNsOptions = {},
): Env {
  const stubNs = (response: unknown): DurableObjectNamespace => {
    const stub = { fetch: async () => Response.json(response ?? { ok: true }) }
    return asUnknown<DurableObjectNamespace>({
      idFromName: (name: string) => name,
      get: () => stub,
    })
  }
  return asUnknown<Env>({
    ENVIRONMENT: 'test',
    DB: db,
    PAR_STORE: parDoNs ?? stubNs({ stored: true }),
    DEVICE_FLOW: deviceDoNs ?? stubNs({ created: true }),
    OAUTH_STATE: makeOauthStateNs(),
    RATE_LIMITER: makeRateLimiterNs(rlOpts),
  })
}

export function makeTenant(override?: Partial<TenantContext>): TenantContext {
  return {
    tenantId: 't_test',
    issuer: 'https://test.idx.dev',
    rpId: 'test.idx.dev',
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: {},
    ...override,
  }
}

export function makeAppRow(override?: Partial<AppRow>): AppRow {
  const now = Date.now()
  return {
    id: 'app_1',
    tenant_id: 't_test',
    client_id: 'client_abc',
    client_secret_hash: null,
    client_type: 'confidential',
    token_endpoint_auth_method: 'client_secret_basic',
    jwks: null,
    redirect_uris: JSON.stringify(['https://app.example.com/callback']),
    post_logout_redirect_uris: JSON.stringify([]),
    allowed_grant_types: JSON.stringify(['authorization_code', 'refresh_token']),
    allowed_response_types: JSON.stringify(['code']),
    allowed_scopes: JSON.stringify(['openid', 'profile', 'email']),
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
    frontchannel_logout_uri: null,
    backchannel_logout_uri: null,
    status: 'active',
    created_at: now,
    updated_at: now,
    ...override,
  }
}

export function makeRefreshRow(override?: Partial<RefreshRow>): RefreshRow {
  const now = Date.now()
  return {
    id: 'rt_1',
    tenant_id: 't_test',
    token_hash: 'PLACEHOLDER_HASH',
    family_id: 'fam_1',
    parent_token_id: null,
    user_id: 'u_1',
    client_id: 'client_abc',
    scope: 'openid profile',
    jkt: null,
    revoked_at: null,
    expires_at: now + 3600_000,
    absolute_expires_at: now + 86400_000,
    created_at: now,
    ...override,
  }
}
