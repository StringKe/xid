// Management API v1 越权与一致性测试:
//   - connections/directories 创建时跨租户 org_id 拒绝(requireOrg 走查询层注入 tenant_id -> 404)。
//   - sessions revoke / revoke_all 命中与签发相同的 per-user SessionDO 实例(idFromName=session:{userId})。
// node 池无 Workers binding,用最小 D1 / DO namespace fake(按 SQL 关键字 + 字符串参数路由)。
// 见 tenant-isolation rule、cloudflare-bindings rule 会话存储、对抗审查 P1/P2 修复。

import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { sha256Hex } from '@xid-kit/crypto'
import type { TenantContext } from '@xid-kit/types'
import type { XidHonoEnv } from '../../lib/types'
import { registerApplications } from '../applications'
import { registerConnections } from '../connections'
import { registerDirectories } from '../directories'
import { registerWebhooks } from '../webhooks'
import { registerApiKeys } from '../api-keys'
import { registerOrganizationsRoutes } from '../organizations'
import { registerProjectGrants } from '../project-grants'
import { registerMembershipsRoutes } from '../memberships'
import { registerInvitationsRoutes } from '../invitations'
import { registerRoles } from '../roles'
import { registerPermissions } from '../permissions'
import { registerSessionsRoutes } from '../sessions'
import { registerUsersRoutes } from '../users'
import { isAppError } from '../../lib/errors'
import { rtCookieName } from '../../lib/cookies'
import { checkInvitationRateLimit, emitWebhookAsync } from '../shared'

const TENANT: TenantContext = {
  tenantId: 't_1',
  issuer: 'https://acme.xid.dev',
  rpId: 'acme.xid.dev',
  signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
  policy: {},
}

function asUnknown<T>(v: unknown): T {
  return v as T
}

type TableSet = {
  api_keys?: Record<string, unknown>[]
  organizations?: Record<string, unknown>[]
  organization_domains?: Record<string, unknown>[]
  org_policies?: Record<string, unknown>[]
  memberships?: Record<string, unknown>[]
  invitations?: Record<string, unknown>[]
  manager_assignments?: Record<string, unknown>[]
  audit_events?: Record<string, unknown>[]
  usage_daily?: Record<string, unknown>[]
  usage_monthly?: Record<string, unknown>[]
  mfa_factors?: Record<string, unknown>[]
  projects?: Record<string, unknown>[]
  applications?: Record<string, unknown>[]
  project_grants?: Record<string, unknown>[]
  roles?: Record<string, unknown>[]
  permissions?: Record<string, unknown>[]
  sso_connections?: Record<string, unknown>[]
  scim_targets?: Record<string, unknown>[]
  saml_service_providers?: Record<string, unknown>[]
  directories?: Record<string, unknown>[]
  webhooks?: Record<string, unknown>[]
  sessions?: Record<string, unknown>[]
  user_grants?: Record<string, unknown>[]
  user_emails?: Record<string, unknown>[]
  users?: Record<string, unknown>[]
}

function tableNameForSql(sql: string): string {
  const l = sql.toLowerCase()
  if (l.includes('api_keys')) return 'api_keys'
  if (l.includes('manager_assignments')) return 'manager_assignments'
  if (l.includes('audit_events')) return 'audit_events'
  if (l.includes('usage_daily')) return 'usage_daily'
  if (l.includes('usage_monthly')) return 'usage_monthly'
  if (l.includes('mfa_factors')) return 'mfa_factors'
  if (l.includes('organization_domains')) return 'organization_domains'
  if (l.includes('org_policies')) return 'org_policies'
  if (l.includes('organizations')) return 'organizations'
  if (l.includes('memberships')) return 'memberships'
  if (l.includes('invitations')) return 'invitations'
  if (l.includes('project_grants')) return 'project_grants'
  if (l.includes('projects')) return 'projects'
  if (l.includes('applications')) return 'applications'
  if (l.includes('roles')) return 'roles'
  if (l.includes('permissions')) return 'permissions'
  if (l.includes('sso_connections')) return 'sso_connections'
  if (l.includes('scim_targets')) return 'scim_targets'
  if (l.includes('saml_service_providers')) return 'saml_service_providers'
  if (l.includes('directories')) return 'directories'
  if (l.includes('webhooks')) return 'webhooks'
  if (l.includes('sessions')) return 'sessions'
  if (l.includes('user_grants')) return 'user_grants'
  if (l.includes('user_emails')) return 'user_emails'
  if (l.includes('users')) return 'users'
  return 'unknown'
}

function projectionColumns(sql: string): string[] {
  const ret = /returning\s+(.+)$/i.exec(sql)
  const head = ret ? ret[1] : /^select\s+(.+?)\s+from\s/i.exec(sql)?.[1]
  if (!head) return []
  return [...head.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? '')
}

function insertColumns(sql: string): string[] {
  const match = /insert\s+into\s+"[a-z_]+"\s*\(([^)]*)\)/i.exec(sql)
  if (!match?.[1]) return []
  return [...match[1].matchAll(/"([a-z_]+)"/g)].map((item) => item[1] ?? '')
}

function insertValueTokens(sql: string): string[] {
  const match = /values\s*\(([\s\S]*?)\)\s*(?:returning|$)/i.exec(sql)
  if (!match?.[1]) return []
  return match[1].split(',').map((token) => token.trim())
}

function rowToRaw(sql: string, row: Record<string, unknown>): unknown[] {
  return projectionColumns(sql).map((c) => {
    const value = row[c]
    if (Array.isArray(value)) return JSON.stringify(value)
    if (value && typeof value === 'object' && !(value instanceof Date)) return JSON.stringify(value)
    return value ?? null
  })
}

function updateSetColumns(sql: string): string[] {
  const match = /^update\s+"?[a-z_]+"?\s+set\s+(.+?)\s+where\s/i.exec(sql.toLowerCase())
  const setClause = match?.[1]
  if (!setClause) return []
  return [...setClause.matchAll(/"([a-z_]+)"\s*=/g)].map((m) => m[1] ?? '')
}

function requiresNull(sql: string, column: string): boolean {
  return new RegExp(`"${column}"\\s+is\\s+null`, 'i').test(sql)
}

function requiresNotNull(sql: string, column: string): boolean {
  return new RegExp(`"${column}"\\s+is\\s+not\\s+null`, 'i').test(sql)
}

function hasSqlLiteral(sql: string, column: string, value: string): boolean {
  return new RegExp(`"${column}"\\s*=\\s*'${value}'`, 'i').test(sql)
}

function matchesSqlLiterals(sql: string, row: Record<string, unknown>): boolean {
  if (hasSqlLiteral(sql, 'status', 'active') && row['status'] !== 'active') return false
  if (hasSqlLiteral(sql, 'status', 'pending') && row['status'] !== 'pending') return false
  if (hasSqlLiteral(sql, 'status', 'deleted') && row['status'] !== 'deleted') return false
  if (hasSqlLiteral(sql, 'manager_role', 'org_manager') && row['manager_role'] !== 'org_manager')
    return false
  if (
    hasSqlLiteral(sql, 'manager_role', 'instance_manager') &&
    row['manager_role'] !== 'instance_manager'
  )
    return false
  if (hasSqlLiteral(sql, 'scope_type', 'org') && row['scope_type'] !== 'org') return false
  if (hasSqlLiteral(sql, 'scope_type', 'instance') && row['scope_type'] !== 'instance') return false
  return true
}

function matchesParameterizedStatus(
  sql: string,
  params: unknown[],
  row: Record<string, unknown>,
): { ok: boolean; remaining: unknown[] } {
  const remaining = [...params]
  if (/"status"\s*(<>|!=)\s*\?/i.test(sql)) {
    const idx = remaining.indexOf('deleted')
    if (idx >= 0) {
      remaining.splice(idx, 1)
      if (row['status'] === 'deleted') return { ok: false, remaining }
    }
  }
  if (/"status"\s*=\s*\?/i.test(sql)) {
    for (const value of ['active', 'deleted', 'pending', 'revoked', 'inactive']) {
      const idx = remaining.indexOf(value)
      if (idx >= 0) {
        remaining.splice(idx, 1)
        if (row['status'] !== value) return { ok: false, remaining }
        break
      }
    }
  }
  return { ok: true, remaining }
}

// 最小 D1 fake:按表名取行,字符串绑定参数全部命中行内某列值才算匹配(模拟 WHERE 收窄)。
function makeFakeD1(tables: TableSet): D1Database {
  const get = (t: string): Record<string, unknown>[] =>
    (tables as Record<string, Record<string, unknown>[]>)[t] ?? []

  const match = (
    sql: string,
    params: unknown[],
    opts: { skipParams?: number } = {},
  ): Record<string, unknown>[] => {
    const rows = get(tableNameForSql(sql))
    const lower = sql.toLowerCase()
    if (lower.startsWith('insert') || lower.startsWith('with')) {
      const cols = insertColumns(sql)
      const tokens = insertValueTokens(sql)
      const row: Record<string, unknown> = {}
      let paramIndex = 0
      cols.forEach((col, index) => {
        const token = tokens[index]
        if (token === '?') row[col] = params[paramIndex++] ?? null
        else if (token === undefined || token.toLowerCase() === 'null') row[col] = null
        else row[col] = token.replace(/^'|'$/g, '')
      })
      rows.push(row)
      return [row]
    }
    if (lower.startsWith('delete')) return []
    const activeParams = opts.skipParams ? params.slice(opts.skipParams) : params
    const sp = activeParams.filter((v): v is string => typeof v === 'string')
    if (sp.length === 0) return rows
    return rows.filter((r) => {
      if (requiresNull(sql, 'revoked_at') && r['revoked_at'] != null) return false
      if (requiresNull(sql, 'deleted_at') && r['deleted_at'] != null) return false
      if (requiresNotNull(sql, 'revoked_at') && r['revoked_at'] == null) return false
      if (requiresNotNull(sql, 'deleted_at') && r['deleted_at'] == null) return false
      if (!matchesSqlLiterals(sql, r)) return false
      const eventTypes = sp.filter(
        (value) => value.startsWith('authentication.') || value.startsWith('user.'),
      )
      if (eventTypes.length > 0 && !eventTypes.includes(String(r['event_type']))) return false
      const userIds =
        lower.includes('mfa_factors') && /"user_id"\s+in\s*\(/i.test(sql)
          ? sp.filter((value) => value.startsWith('user_'))
          : []
      if (userIds.length > 0 && !userIds.includes(String(r['user_id']))) return false
      const status = matchesParameterizedStatus(
        sql,
        sp.filter((value) => !eventTypes.includes(value) && !userIds.includes(value)),
        r,
      )
      if (!status.ok) return false
      return status.remaining.every((v) => Object.values(r).includes(v))
    })
  }

  const applyUpdate = (sql: string, params: unknown[]): Record<string, unknown>[] => {
    const cols = updateSetColumns(sql)
    const rows = match(sql, params, { skipParams: cols.length })
    for (const row of rows) {
      cols.forEach((col, i) => {
        row[col] = params[i]
      })
    }
    return rows
  }

  const prepare = (sql: string): unknown => {
    let bound: unknown[] = []
    const stmt = {
      bind: (...p: unknown[]) => {
        bound = p
        return stmt
      },
      raw: async () => {
        const rows = sql.toLowerCase().startsWith('update')
          ? applyUpdate(sql, bound)
          : match(sql, bound)
        if (/select\s+count\s*\(\s*distinct\s+/i.test(sql)) {
          return [[new Set(rows.map((row) => row['user_id'])).size]]
        }
        if (/select\s+count\(\*\)/i.test(sql)) return [[rows.length]]
        return rows.map((r) => rowToRaw(sql, r))
      },
      all: async () => ({ results: match(sql, bound), success: true, meta: {} }),
      run: async () => {
        const rows = sql.toLowerCase().startsWith('update')
          ? applyUpdate(sql, bound)
          : match(sql, bound)
        return { results: rows, success: true, meta: {} }
      },
      first: async () => match(sql, bound)[0] ?? null,
    }
    return stmt
  }
  return asUnknown<D1Database>({ prepare, batch: async () => [] })
}

// SessionDO namespace fake:记录 idFromName 的入参(用于断言命中正确实例)。
function makeFakeSessionNs(names: string[]): DurableObjectNamespace {
  const stub = {
    fetch: async () => new Response(JSON.stringify({ active: true }), { status: 200 }),
  }
  return asUnknown<DurableObjectNamespace>({
    idFromName: (n: string) => {
      names.push(n)
      return n
    },
    get: () => stub,
  })
}

function makeFakeKv(): KVNamespace {
  const store = new Map<string, string>()
  return asUnknown<KVNamespace>({
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
  })
}

function makeFakeQueue(): Queue<unknown> {
  return asUnknown<Queue<unknown>>({ send: async () => undefined })
}

async function makeApiKeyRow(
  tenantId: string,
  scopes: string[] = ['*'],
): Promise<{ token: string; row: Record<string, unknown> }> {
  const token = 'sk_live_testkey123'
  const row = {
    id: 'ak_1',
    tenant_id: tenantId,
    key_hash: await sha256Hex(token),
    name: 'test',
    scopes,
    expires_at: null,
    revoked_at: null,
    created_at: Date.now(),
  }
  return { token, row }
}

async function makeSessionRow(opts: {
  tenantId: string
  userId: string
  activeOrgId?: string | null
}): Promise<{ token: string; cookieName: string; row: Record<string, unknown> }> {
  const sessionId = `sess_${opts.userId}`
  const token = `rt_${opts.userId}_token`
  const row = {
    id: sessionId,
    tenant_id: opts.tenantId,
    user_id: opts.userId,
    refresh_token_hash: await sha256Hex(token),
    active_org_id: opts.activeOrgId ?? null,
    status: 'active',
    remember_me: 0,
    is_impersonation: 0,
    impersonator_user_id: null,
    authenticated_at: Date.now(),
    expires_at: Date.now() + 3_600_000,
  }
  return { token, cookieName: rtCookieName(sessionId), row }
}

function activeUserRow(userId: string, tenantId = 't_1'): Record<string, unknown> {
  return {
    id: userId,
    tenant_id: tenantId,
    status: 'active',
    deleted_at: null,
  }
}

// 测试用最小 onError:直接读 AppError.code/httpStatus,避免 import middleware/error 触发 i18n lingui macro。
function buildApp(
  register: (app: Hono<XidHonoEnv>) => void,
  tenant: TenantContext = TENANT,
): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError((err, c) => {
    if (isAppError(err)) return c.json({ code: err.code }, err.httpStatus as 400)
    return c.json({ code: 'server_error' }, 500)
  })
  app.use('*', async (c: Context<XidHonoEnv>, next) => {
    if (!c.env.WEBHOOK_QUEUE) {
      c.env.WEBHOOK_QUEUE = { send: async () => undefined } as Queue<
        import('@xid-kit/types').WebhookQueueMessage
      >
    }
    c.set('tenant', tenant)
    c.set('session', null)
    await next()
  })
  register(app)
  return app
}

describe('v1 shared asynchronous work', () => {
  it('reserves invitation quota through one tenant RateLimitStore instance', async () => {
    let reserved = 0
    const idFromName = vi.fn((name: string) => name as unknown as DurableObjectId)
    const fetch = vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { count: number }
      const allowed = reserved + body.count <= 50
      if (allowed) reserved += body.count
      return Response.json({ allowed })
    })
    const env = {
      RATE_LIMITER: {
        idFromName,
        get: vi.fn(() => ({ fetch })),
      },
    } as unknown as Env
    const c = {
      env,
      get: (key: string) => (key === 'tenant' ? TENANT : undefined),
    } as unknown as Context<XidHonoEnv>

    await checkInvitationRateLimit(c, 30)
    await expect(checkInvitationRateLimit(c, 21)).rejects.toMatchObject({ code: 'rate_limited' })

    expect(idFromName).toHaveBeenCalledWith('invitations:t_1')
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ count: 30 })
  })

  it('registers webhook queue rejection through waitUntil', async () => {
    const rejection = Promise.resolve().then(() => {
      throw new Error('queue unavailable')
    })
    const waitUntil = vi.fn()
    const c = {
      env: { WEBHOOK_QUEUE: { send: vi.fn(() => rejection) } },
      executionCtx: { waitUntil },
    } as unknown as Context<XidHonoEnv>

    emitWebhookAsync(c, { tenantId: 't_1', event: 'user.updated', payload: {} })

    expect(waitUntil).toHaveBeenCalledWith(rejection)
    await expect(rejection).rejects.toThrow('queue unavailable')
  })
})

describe('v1 connections 创建:跨租户 org_id 越权拒绝', () => {
  it('org_id 属于别的租户 -> 404 org_not_found(查询层注入 tenant_id 查不到)', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    // org_victim 归属 t_other,当前 API key 是 t_1。
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [{ id: 'org_victim', tenant_id: 't_other', status: 'active' }],
    })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerConnections)
    const res = await app.request(
      'https://acme.xid.dev/v1/connections',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: 'org_victim', protocol: 'oidc' }),
      },
      env,
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('org_not_found')
  })

  it('org_id 属于本租户 -> 创建成功 201', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    // 不预置 sso_connections:存在性检查返回空(无 409),insert returning 合成行。
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
    })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerConnections)
    const res = await app.request(
      'https://acme.xid.dev/v1/connections',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: 'org_1', protocol: 'oidc' }),
      },
      env,
    )
    expect(res.status).toBe(201)
  })

  it('legacy ldap protocol is accepted', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
    })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerConnections)
    const res = await app.request(
      'https://acme.xid.dev/v1/connections',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_id: 'org_1',
          protocol: 'ldap',
          attribute_mapping: { _legacy: { ldapGatewayUrl: 'https://ldap.example.com/bind' } },
        }),
      },
      env,
    )
    expect(res.status).toBe(201)
  })

  it('unsupported protocol is rejected with validation_failed', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
    })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerConnections)
    const res = await app.request(
      'https://acme.xid.dev/v1/connections',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: 'org_1', protocol: 'kerberos' }),
      },
      env,
    )
    expect(res.status).toBe(422)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('validation_failed')
  })

  it('header protocol requires trusted proxy secret in attribute mapping', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
    })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerConnections)
    const res = await app.request(
      'https://acme.xid.dev/v1/connections',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_id: 'org_1',
          protocol: 'header',
          attribute_mapping: { _legacy: {} },
        }),
      },
      env,
    )
    expect(res.status).toBe(422)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('validation_failed')
  })
})

describe('v1 directories 创建:跨租户 org_id 越权拒绝', () => {
  it('org_id 属于别的租户 -> 404 org_not_found', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [{ id: 'org_victim', tenant_id: 't_other', status: 'active' }],
    })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerDirectories)
    const res = await app.request(
      'https://acme.xid.dev/v1/directories',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: 'org_victim', provider: 'okta' }),
      },
      env,
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('org_not_found')
  })
})

describe('v1 applications 软删除', () => {
  it('POST restore -> 恢复 deleted application,普通详情重新可读且不返回 client_secret', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const application = {
      id: 'app_1',
      tenant_id: 't_1',
      client_id: 'client_1',
      client_secret_hash: 'hash',
      client_type: 'confidential',
      token_endpoint_auth_method: 'client_secret_basic',
      redirect_uris: ['https://app.example.com/callback'],
      post_logout_redirect_uris: [],
      allowed_grant_types: ['authorization_code', 'refresh_token'],
      allowed_scopes: ['openid', 'profile', 'email'],
      require_pkce: 1,
      dpop_bound_access_tokens: 0,
      access_token_format: 'jwt',
      access_token_ttl_sec: 3600,
      id_token_signed_alg: 'ES256',
      first_party: 0,
      status: 'deleted',
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], applications: [application] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerApplications)

    const restore = await app.request(
      'https://acme.xid.dev/v1/applications/app_1/restore',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(restore.status).toBe(200)
    expect(application['status']).toBe('active')
    const restored = (await restore.json()) as Record<string, unknown>
    expect(restored['client_secret']).toBeUndefined()
    expect(restored['client_secret_hash']).toBeUndefined()

    const get = await app.request(
      'https://acme.xid.dev/v1/applications/app_1',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(get.status).toBe(200)
  })

  it('POST restore 跨租户 application -> 404 且不修改受害租户行', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const victim = {
      id: 'app_victim',
      tenant_id: 't_other',
      client_id: 'client_victim',
      client_secret_hash: 'hash',
      client_type: 'confidential',
      token_endpoint_auth_method: 'client_secret_basic',
      redirect_uris: [],
      post_logout_redirect_uris: [],
      allowed_grant_types: ['authorization_code'],
      allowed_scopes: ['openid'],
      require_pkce: 1,
      status: 'deleted',
    }
    const db = makeFakeD1({ api_keys: [apiKey], applications: [victim] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerApplications)

    const restore = await app.request(
      'https://acme.xid.dev/v1/applications/app_victim/restore',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(restore.status).toBe(404)
    expect(victim['status']).toBe('deleted')
  })
})

describe('v1 applications PATCH access_token_ttl_sec 边界', () => {
  function activeAppRow(): Record<string, unknown> {
    return {
      id: 'app_1',
      tenant_id: 't_1',
      client_id: 'client_1',
      client_secret_hash: 'hash',
      client_type: 'confidential',
      token_endpoint_auth_method: 'client_secret_basic',
      redirect_uris: [],
      post_logout_redirect_uris: [],
      allowed_grant_types: ['authorization_code'],
      allowed_scopes: ['openid'],
      require_pkce: 1,
      dpop_bound_access_tokens: 0,
      access_token_format: 'jwt',
      access_token_ttl_sec: 3600,
      id_token_signed_alg: 'ES256',
      first_party: 0,
      status: 'active',
      created_at: Date.now(),
      updated_at: Date.now(),
    }
  }

  it('59/86401 -> 422 validation_failed,60/86400 -> 200 且生效', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({ api_keys: [apiKey], applications: [activeAppRow()] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerApplications)
    const patch = (ttl: unknown) =>
      app.request(
        'https://acme.xid.dev/v1/applications/app_1',
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token_ttl_sec: ttl }),
        },
        env,
      )
    for (const bad of [59, 86401]) {
      const res = await patch(bad)
      expect(res.status).toBe(422)
      const body = (await res.json()) as Record<string, unknown>
      expect(body['code']).toBe('validation_failed')
    }
    for (const good of [60, 86400]) {
      const res = await patch(good)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body['access_token_ttl_sec']).toBe(good)
    }
  })

  it('显式 null -> 200 且清回继承(存 NULL)', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const appRow = activeAppRow()
    const db = makeFakeD1({ api_keys: [apiKey], applications: [appRow] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerApplications)

    const res = await app.request(
      'https://acme.xid.dev/v1/applications/app_1',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token_ttl_sec: null }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['access_token_ttl_sec']).toBeNull()
    expect(appRow['access_token_ttl_sec']).toBeNull()
  })
})

describe('v1 applications redirect_uris 注册校验', () => {
  it('POST:http 明文 / fragment -> 422;https -> 201', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({ api_keys: [apiKey] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerApplications)
    const post = (uris: string[]) =>
      app.request(
        'https://acme.xid.dev/v1/applications',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ redirect_uris: uris }),
        },
        env,
      )
    for (const uris of [['http://app.example.com/cb'], ['https://app.example.com/cb#frag']]) {
      const res = await post(uris)
      expect(res.status).toBe(422)
      const body = (await res.json()) as Record<string, unknown>
      expect(body['code']).toBe('validation_failed')
    }
    const ok = await post(['https://app.example.com/cb'])
    expect(ok.status).toBe(201)
  })

  it('POST:authorization_code grant 空 redirect_uris -> 422;纯 client_credentials 放行', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({ api_keys: [apiKey] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerApplications)
    const post = (body: Record<string, unknown>) =>
      app.request(
        'https://acme.xid.dev/v1/applications',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        env,
      )
    const empty = await post({ redirect_uris: [] })
    expect(empty.status).toBe(422)
    const m2m = await post({ redirect_uris: [], allowed_grant_types: ['client_credentials'] })
    expect(m2m.status).toBe(201)
  })

  it('PATCH:http redirect_uri -> 422;native loopback http -> 200', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const application = {
      id: 'app_1',
      tenant_id: 't_1',
      client_id: 'client_1',
      client_secret_hash: 'hash',
      client_type: 'public',
      token_endpoint_auth_method: 'none',
      redirect_uris: ['https://app.example.com/callback'],
      post_logout_redirect_uris: [],
      allowed_grant_types: ['authorization_code'],
      allowed_scopes: ['openid'],
      require_pkce: 1,
      status: 'active',
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], applications: [application] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerApplications)
    const patch = (body: Record<string, unknown>) =>
      app.request(
        'https://acme.xid.dev/v1/applications/app_1',
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        env,
      )
    const bad = await patch({ redirect_uris: ['http://app.example.com/cb'] })
    expect(bad.status).toBe(422)
    const native = await patch({
      application_type: 'native',
      redirect_uris: ['http://127.0.0.1:3000/cb'],
    })
    expect(native.status).toBe(200)
  })
})

describe('v1 webhooks 软删除', () => {
  it('POST restore -> 恢复 deleted webhook,普通详情重新可读且不返回 signing_secret', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const webhook = {
      id: 'wh_1',
      tenant_id: 't_1',
      url: 'https://hooks.example.com/xid',
      event_types: ['user.created'],
      signing_secret_hash: 'v2:envelope_encrypted',
      signing_secret_iv: 'iv',
      signing_secret_ciphertext: 'ciphertext',
      signing_secret_tag: 'tag',
      status: 'deleted',
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], webhooks: [webhook] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerWebhooks)

    const restore = await app.request(
      'https://acme.xid.dev/v1/webhooks/wh_1/restore',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(restore.status).toBe(200)
    expect(webhook['status']).toBe('active')
    const restored = (await restore.json()) as Record<string, unknown>
    expect(restored['signing_secret']).toBeUndefined()
    expect(restored['signing_secret_hash']).toBeUndefined()

    const get = await app.request(
      'https://acme.xid.dev/v1/webhooks/wh_1',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(get.status).toBe(200)
  })

  it('POST restore 跨租户 webhook -> 404 且不修改受害租户行', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const victim = {
      id: 'wh_victim',
      tenant_id: 't_other',
      url: 'https://hooks.example.com/xid',
      event_types: [],
      signing_secret_hash: 'v2:envelope_encrypted',
      status: 'deleted',
    }
    const db = makeFakeD1({ api_keys: [apiKey], webhooks: [victim] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerWebhooks)

    const restore = await app.request(
      'https://acme.xid.dev/v1/webhooks/wh_victim/restore',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(restore.status).toBe(404)
    expect(victim['status']).toBe('deleted')
  })
})

describe('v1 webhooks URL SSRF 防护', () => {
  function activeWebhookRow(): Record<string, unknown> {
    return {
      id: 'wh_1',
      tenant_id: 't_1',
      url: 'https://hooks.example.com/xid',
      event_types: ['user.created'],
      signing_secret_hash: 'v2:envelope_encrypted',
      signing_secret_iv: 'iv',
      signing_secret_ciphertext: 'ciphertext',
      signing_secret_tag: 'tag',
      status: 'active',
      created_at: Date.now(),
      updated_at: Date.now(),
    }
  }

  it('POST create:http 与内网 IP -> 422 validation_failed', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({ api_keys: [apiKey] })
    const env = asUnknown<Env>({ DB: db, KEK: btoa('0'.repeat(32)) })
    const app = buildApp(registerWebhooks)
    for (const url of ['http://hooks.example.com/x', 'https://169.254.169.254/latest']) {
      const res = await app.request(
        'https://acme.xid.dev/v1/webhooks',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        },
        env,
      )
      expect(res.status).toBe(422)
      const body = (await res.json()) as Record<string, unknown>
      expect(body['code']).toBe('validation_failed')
    }
  })

  it('PATCH url:http 与内网 IP -> 422;公网 https -> 200 生效', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const webhook = activeWebhookRow()
    const db = makeFakeD1({ api_keys: [apiKey], webhooks: [webhook] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerWebhooks)
    const patch = (url: string) =>
      app.request(
        'https://acme.xid.dev/v1/webhooks/wh_1',
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        },
        env,
      )
    for (const bad of ['http://hooks.example.com/x', 'https://192.168.1.1/hook', 'not-a-url']) {
      const res = await patch(bad)
      expect(res.status).toBe(422)
      const body = (await res.json()) as Record<string, unknown>
      expect(body['code']).toBe('validation_failed')
    }
    const ok = await patch('https://hooks2.example.com/y')
    expect(ok.status).toBe(200)
    expect(webhook['url']).toBe('https://hooks2.example.com/y')
  })
})

describe('v1 connections:SSO URL 校验与内部 attribute_mapping 剔除', () => {
  it('POST:idp_metadata_url / oidc_discovery_url 为 http 或内网 IP -> 422', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
    })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerConnections)
    const post = (extra: Record<string, unknown>) =>
      app.request(
        'https://acme.xid.dev/v1/connections',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ org_id: 'org_1', protocol: 'oidc', ...extra }),
        },
        env,
      )
    for (const extra of [
      { idp_metadata_url: 'http://idp.example.com/meta.xml' },
      { idp_metadata_url: 'https://169.254.169.254/latest/meta-data' },
      { oidc_discovery_url: 'http://idp.example.com/.well-known/openid-configuration' },
      { oidc_discovery_url: 'https://10.0.0.1/.well-known/openid-configuration' },
    ]) {
      const res = await post(extra)
      expect(res.status).toBe(422)
      const body = (await res.json()) as Record<string, unknown>
      expect(body['code']).toBe('validation_failed')
    }
  })

  it('POST:公网 https metadata/discovery URL 接受,201 响应不下发 _ 前缀内部键', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
    })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerConnections)
    const res = await app.request(
      'https://acme.xid.dev/v1/connections',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_id: 'org_1',
          protocol: 'oidc',
          oidc_discovery_url: 'https://idp.example.com/.well-known/openid-configuration',
          attribute_mapping: {
            email: 'mail',
            _swaVault: { cred: 'sealed' },
            _swaVaultEnvelope: { ciphertext: 'x' },
          },
        }),
      },
      env,
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    const mapping = body['attribute_mapping'] as Record<string, unknown>
    expect(mapping).toEqual({ email: 'mail' })
  })

  it('GET:响应 attribute_mapping 剔除 _swaVault 等 _ 前缀键', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const connection = {
      id: 'conn_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      protocol: 'swa',
      attribute_mapping: {
        email: 'mail',
        _swaVault: { cred: 'sealed' },
        _swaVaultEnvelope: { ciphertext: 'x' },
      },
      role_mapping: {},
      status: 'active',
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], sso_connections: [connection] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerConnections)
    const res = await app.request(
      'https://acme.xid.dev/v1/connections/conn_1',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const mapping = body['attribute_mapping'] as Record<string, unknown>
    expect(mapping).toEqual({ email: 'mail' })
    expect(JSON.stringify(mapping)).not.toContain('_swaVault')
  })
})

describe('v1 connections 软删除', () => {
  it('POST restore -> 恢复 deleted connection,普通详情重新可读', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const connection = {
      id: 'conn_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      protocol: 'saml',
      idp_entity_id: 'https://idp.example.com/entity',
      idp_sso_url: 'https://idp.example.com/sso',
      idp_metadata_url: null,
      idp_certificates: [],
      oidc_client_id: null,
      oidc_discovery_url: null,
      want_authn_response_signed: 1,
      want_assertions_signed: 1,
      attribute_mapping: {},
      role_mapping: {},
      jit_enabled: 1,
      status: 'deleted',
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], sso_connections: [connection] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerConnections)

    const restore = await app.request(
      'https://acme.xid.dev/v1/connections/conn_1/restore',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(restore.status).toBe(200)
    expect(connection['status']).toBe('active')

    const get = await app.request(
      'https://acme.xid.dev/v1/connections/conn_1',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(get.status).toBe(200)
  })

  it('POST restore 跨租户 connection -> 404 且不修改受害租户行', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const victim = {
      id: 'conn_victim',
      tenant_id: 't_other',
      org_id: 'org_victim',
      protocol: 'saml',
      idp_entity_id: 'https://idp.example.com/entity',
      idp_sso_url: 'https://idp.example.com/sso',
      status: 'deleted',
    }
    const db = makeFakeD1({ api_keys: [apiKey], sso_connections: [victim] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerConnections)

    const restore = await app.request(
      'https://acme.xid.dev/v1/connections/conn_victim/restore',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(restore.status).toBe(404)
    expect(victim['status']).toBe('deleted')
  })
})

describe('v1 directories 软删除', () => {
  it('POST restore -> 恢复 deleted directory 并只返回一次新 SCIM token', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const directory = {
      id: 'dir_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      provider: 'okta',
      sync_status: 'disabled',
      status: 'deleted',
      scim_token_hash: 'old_hash',
      scim_token_hash_prev: 'older_hash',
      scim_token_prev_expires: Date.now() + 30_000,
      deleted_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], directories: [directory] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerDirectories)

    const restore = await app.request(
      'https://acme.xid.dev/v1/directories/dir_1/restore',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(restore.status).toBe(200)
    const body = (await restore.json()) as Record<string, unknown>
    expect(typeof body['scim_token']).toBe('string')
    expect(directory['status']).toBe('active')
    expect(directory['sync_status']).toBe('idle')
    expect(directory['deleted_at']).toBeNull()
    expect(directory['scim_token_hash']).not.toBe('old_hash')
    expect(directory['scim_token_hash_prev']).toBeNull()
    expect(directory['scim_token_prev_expires']).toBeNull()

    const get = await app.request(
      'https://acme.xid.dev/v1/directories/dir_1',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(get.status).toBe(200)
  })

  it('POST restore 跨租户 directory -> 404 且不修改受害租户行', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const victim = {
      id: 'dir_victim',
      tenant_id: 't_other',
      org_id: 'org_victim',
      provider: 'okta',
      sync_status: 'disabled',
      status: 'deleted',
      scim_token_hash: 'old_hash',
      deleted_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], directories: [victim] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerDirectories)

    const restore = await app.request(
      'https://acme.xid.dev/v1/directories/dir_victim/restore',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(restore.status).toBe(404)
    expect(victim['status']).toBe('deleted')
    expect(victim['deleted_at']).toBeTypeOf('number')
  })
})

describe('v1 roles 软删除', () => {
  it('非空 API key scopes 不允许越权写操作', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1', ['roles:read'])
    const db = makeFakeD1({ api_keys: [apiKey] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerRoles)

    const res = await app.request(
      'https://acme.xid.dev/v1/roles',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 'proj_1',
          key: 'admin',
          display_name: 'Admin',
        }),
      },
      env,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('insufficient_permission')
  })

  it('resource wildcard scope 允许同资源写操作', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1', ['roles:*'])
    const db = makeFakeD1({ api_keys: [apiKey] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerRoles)

    const res = await app.request(
      'https://acme.xid.dev/v1/roles',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 'proj_1',
          key: 'admin',
          display_name: 'Admin',
        }),
      },
      env,
    )
    expect(res.status).toBe(201)
  })

  it('空 scopes 不允许资源写操作', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1', [])
    const db = makeFakeD1({ api_keys: [apiKey] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerRoles)

    const res = await app.request(
      'https://acme.xid.dev/v1/roles',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 'proj_1',
          key: 'admin',
          display_name: 'Admin',
        }),
      },
      env,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('insufficient_permission')
  })

  it('DELETE -> 标记 deleted,普通列表不再返回', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const role = {
      id: 'role_1',
      tenant_id: 't_1',
      project_id: 'proj_1',
      key: 'admin',
      display_name: 'Admin',
      group: null,
      status: 'active',
      deleted_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], roles: [role] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerRoles)

    const del = await app.request(
      'https://acme.xid.dev/v1/roles/role_1',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(del.status).toBe(204)
    expect(role['status']).toBe('deleted')
    expect(role['deleted_at']).toBeTypeOf('number')

    const list = await app.request(
      'https://acme.xid.dev/v1/roles',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(list.status).toBe(200)
    const body = (await list.json()) as { data: unknown[] }
    expect(body.data).toEqual([])
  })

  it('POST restore -> 恢复 deleted role,普通详情重新可读', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const role = {
      id: 'role_1',
      tenant_id: 't_1',
      project_id: 'proj_1',
      key: 'admin',
      display_name: 'Admin',
      group: null,
      status: 'deleted',
      deleted_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], roles: [role] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerRoles)

    const restore = await app.request(
      'https://acme.xid.dev/v1/roles/role_1/restore',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(restore.status).toBe(200)
    expect(role['status']).toBe('active')
    expect(role['deleted_at']).toBeNull()

    const get = await app.request(
      'https://acme.xid.dev/v1/roles/role_1',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(get.status).toBe(200)
    const body = (await get.json()) as Record<string, unknown>
    expect(body['id']).toBe('role_1')
  })

  it('POST restore 跨租户 role -> 404 且不修改受害租户行', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const victim = {
      id: 'role_victim',
      tenant_id: 't_other',
      project_id: 'proj_1',
      key: 'admin',
      display_name: 'Admin',
      group: null,
      status: 'deleted',
      deleted_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], roles: [victim] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerRoles)

    const restore = await app.request(
      'https://acme.xid.dev/v1/roles/role_victim/restore',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(restore.status).toBe(404)
    expect(victim['status']).toBe('deleted')
    expect(victim['deleted_at']).toBeTypeOf('number')
  })
})

describe('v1 permissions 软删除', () => {
  it('POST restore -> 恢复 deleted permission,普通详情重新可读', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const permission = {
      id: 'perm_1',
      tenant_id: 't_1',
      project_id: 'proj_1',
      key: 'documents:read',
      description: 'Read documents',
      status: 'deleted',
      deleted_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], permissions: [permission] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerPermissions)

    const restore = await app.request(
      'https://acme.xid.dev/v1/permissions/perm_1/restore',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(restore.status).toBe(200)
    expect(permission['status']).toBe('active')
    expect(permission['deleted_at']).toBeNull()

    const get = await app.request(
      'https://acme.xid.dev/v1/permissions/perm_1',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(get.status).toBe(200)
    const body = (await get.json()) as Record<string, unknown>
    expect(body['id']).toBe('perm_1')
  })

  it('POST restore 跨租户 permission -> 404 且不修改受害租户行', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const victim = {
      id: 'perm_victim',
      tenant_id: 't_other',
      project_id: 'proj_1',
      key: 'documents:read',
      description: 'Read documents',
      status: 'deleted',
      deleted_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], permissions: [victim] })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerPermissions)

    const restore = await app.request(
      'https://acme.xid.dev/v1/permissions/perm_victim/restore',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(restore.status).toBe(404)
    expect(victim['status']).toBe('deleted')
    expect(victim['deleted_at']).toBeTypeOf('number')
  })
})

describe('v1 api keys:cookie session + top-level organization manager 门控', () => {
  it('GET /v1/api-keys 无 session 且无 Bearer -> 401', async () => {
    const env = asUnknown<Env>({
      DB: makeFakeD1({}),
      SESSION_REVOCATION: makeFakeSessionNs([]),
    })
    const app = buildApp(registerApiKeys)

    const res = await app.request('https://acme.xid.dev/v1/api-keys', {}, env)

    expect(res.status).toBe(401)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('unauthorized')
  })

  it('有效 session 但非 instance_manager -> 403', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({ tenantId: 't_1', userId: 'user_member' })
    const env = asUnknown<Env>({
      DB: makeFakeD1({
        sessions: [session],
        users: [activeUserRow('user_member')],
        organizations: [{ id: 't_1', tenant_id: 't_1', status: 'active' }],
        manager_assignments: [],
      }),
      SESSION_REVOCATION: makeFakeSessionNs([]),
    })
    const app = buildApp(registerApiKeys)

    const res = await app.request(
      'https://acme.xid.dev/v1/api-keys',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )

    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('forbidden')
  })

  it('instance_manager 没有顶层组织管理权限时不能创建 api key', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({ tenantId: 't_1', userId: 'user_manager' })
    const created = {
      id: 'ak_created',
      tenant_id: 't_1',
      name: 'SDK',
      key_hash: 'hash',
      key_prefix: 'sk_live_created',
      environment: 'live',
      scopes: ['users:read'],
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
      created_at: Date.now(),
    }
    const env = asUnknown<Env>({
      DB: makeFakeD1({
        sessions: [session],
        users: [activeUserRow('user_manager')],
        organizations: [{ id: 't_1', tenant_id: 't_1', status: 'active' }],
        manager_assignments: [
          {
            id: 'ma_1',
            tenant_id: 't_1',
            user_id: 'user_manager',
            manager_role: 'instance_manager',
            scope_type: 'instance',
            scope_id: null,
          },
        ],
        api_keys: [created],
      }),
      SESSION_REVOCATION: makeFakeSessionNs([]),
    })
    const app = buildApp(registerApiKeys)

    const res = await app.request(
      'https://acme.xid.dev/v1/api-keys',
      {
        method: 'POST',
        headers: { Cookie: `${cookieName}=${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'SDK', scopes: ['users:read'] }),
      },
      env,
    )

    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('forbidden')
  })

  it('DELETE -> 标记 revoked,普通列表和详情不再返回,revoked key 不能认证', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({ api_keys: [apiKey] })
    const env = asUnknown<Env>({ DB: db, SESSION_REVOCATION: makeFakeSessionNs([]) })
    const app = buildApp(registerApiKeys)

    const del = await app.request(
      'https://acme.xid.dev/v1/api-keys/ak_1',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      env,
    )

    expect(del.status).toBe(200)
    expect(apiKey['revoked_at']).toBeTypeOf('number')

    const list = await app.request(
      'https://acme.xid.dev/v1/api-keys',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(list.status).toBe(401)

    const {
      token: managerToken,
      cookieName,
      row: session,
    } = await makeSessionRow({ tenantId: 't_1', userId: 'user_manager' })
    const dbWithManager = makeFakeD1({
      api_keys: [apiKey],
      sessions: [session],
      users: [activeUserRow('user_manager')],
      organizations: [{ id: 't_1', tenant_id: 't_1', status: 'active' }],
      manager_assignments: [
        {
          id: 'ma_1',
          tenant_id: 't_1',
          user_id: 'user_manager',
          manager_role: 'instance_manager',
          scope_type: 'instance',
          scope_id: null,
        },
      ],
    })
    const envWithManager = asUnknown<Env>({
      DB: dbWithManager,
      SESSION_REVOCATION: makeFakeSessionNs([]),
    })

    const managerList = await app.request(
      'https://acme.xid.dev/v1/api-keys',
      { headers: { Cookie: `${cookieName}=${managerToken}` } },
      envWithManager,
    )
    expect(managerList.status).toBe(403)

    const managerGet = await app.request(
      'https://acme.xid.dev/v1/api-keys/ak_1',
      { headers: { Cookie: `${cookieName}=${managerToken}` } },
      envWithManager,
    )
    expect(managerGet.status).toBe(403)
  })
})

describe('v1 api keys 铸 key 防提权(scope 白名单 + sk 子集校验)', () => {
  function postApiKey(
    app: Hono<XidHonoEnv>,
    env: Env,
    token: string,
    scopes: string[],
  ): Promise<Response> {
    return app.request(
      'https://acme.xid.dev/v1/api-keys',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'new key', scopes }),
      },
      env,
    )
  }

  it('窄 key(api_keys:write)铸 * -> 422 validation_failed', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1', ['api_keys:write'])
    const env = asUnknown<Env>({ DB: makeFakeD1({ api_keys: [apiKey] }) })
    const app = buildApp(registerApiKeys)

    const res = await postApiKey(app, env, token, ['*'])

    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('validation_failed')
  })

  it('窄 key 铸超出 caller 的 users:read -> 422 validation_failed', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1', ['api_keys:write'])
    const env = asUnknown<Env>({ DB: makeFakeD1({ api_keys: [apiKey] }) })
    const app = buildApp(registerApiKeys)

    const res = await postApiKey(app, env, token, ['users:read'])

    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('validation_failed')
  })

  it('caller api_keys:* 铸合法子集 api_keys:read -> 201', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1', ['api_keys:*'])
    const env = asUnknown<Env>({ DB: makeFakeD1({ api_keys: [apiKey] }) })
    const app = buildApp(registerApiKeys)

    const res = await postApiKey(app, env, token, ['api_keys:read'])

    expect(res.status).toBe(201)
    const body = (await res.json()) as { scopes: string[]; key: string }
    expect(body.scopes).toEqual(['api_keys:read'])
    expect(body.key.startsWith('sk_live_')).toBe(true)
  })

  it('caller * 铸乱码 scope -> 422 validation_failed(白名单拒绝入库)', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1', ['*'])
    const env = asUnknown<Env>({ DB: makeFakeD1({ api_keys: [apiKey] }) })
    const app = buildApp(registerApiKeys)

    const res = await postApiKey(app, env, token, ['foo:bar'])

    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('validation_failed')
  })

  it('cookie 顶层 org owner 铸 * -> 201(console 语义不变)', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({ tenantId: 't_1', userId: 'user_owner' })
    const env = asUnknown<Env>({
      DB: makeFakeD1({
        sessions: [session],
        users: [activeUserRow('user_owner')],
        organizations: [{ id: 't_1', tenant_id: 't_1', status: 'active' }],
        memberships: [
          {
            id: 'mem_owner',
            tenant_id: 't_1',
            org_id: 't_1',
            user_id: 'user_owner',
            role: 'owner',
            status: 'active',
          },
        ],
        manager_assignments: [],
      }),
      SESSION_REVOCATION: makeFakeSessionNs([]),
    })
    const app = buildApp(registerApiKeys)

    const res = await app.request(
      'https://acme.xid.dev/v1/api-keys',
      {
        method: 'POST',
        headers: { Cookie: `${cookieName}=${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'console key', scopes: ['*'] }),
      },
      env,
    )

    expect(res.status).toBe(201)
  })
})

// 租户级资源(applications/webhooks/api-keys)的 cookie 双认证:
// 顶层 org(id=tenantId)的 owner/admin/org_manager 可经 cookie 访问;非成员 403;无认证 401。
describe('v1 租户级资源 cookie 双认证(requireApiKeyOrTopLevelOrgManager)', () => {
  const TOP_ORG = { id: 't_1', tenant_id: 't_1', status: 'active' }

  function membershipRow(userId: string, role: string): Record<string, unknown> {
    return {
      id: `m_${userId}`,
      tenant_id: 't_1',
      org_id: 't_1',
      user_id: userId,
      role,
      status: 'active',
    }
  }

  it('顶层 org admin(cookie membership)-> GET /v1/applications 200', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
    })
    const env = asUnknown<Env>({
      DB: makeFakeD1({
        sessions: [session],
        users: [activeUserRow('user_admin')],
        organizations: [TOP_ORG],
        memberships: [membershipRow('user_admin', 'admin')],
        manager_assignments: [],
      }),
      SESSION_REVOCATION: makeFakeSessionNs([]),
    })
    const app = buildApp(registerApplications)
    const res = await app.request(
      'https://acme.xid.dev/v1/applications',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )
    expect(res.status).toBe(200)
  })

  it('顶层 org owner(cookie membership)-> POST /v1/applications 201', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_owner',
    })
    const env = asUnknown<Env>({
      DB: makeFakeD1({
        sessions: [session],
        users: [activeUserRow('user_owner')],
        organizations: [TOP_ORG],
        memberships: [membershipRow('user_owner', 'owner')],
        manager_assignments: [],
      }),
      SESSION_REVOCATION: makeFakeSessionNs([]),
    })
    const app = buildApp(registerApplications)
    const res = await app.request(
      'https://acme.xid.dev/v1/applications',
      {
        method: 'POST',
        headers: { Cookie: `${cookieName}=${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['https://app.example.com/cb'] }),
      },
      env,
    )
    expect(res.status).toBe(201)
  })

  it('session 非顶层 org 成员 -> GET /v1/applications 403', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_outsider',
    })
    const env = asUnknown<Env>({
      DB: makeFakeD1({
        sessions: [session],
        users: [activeUserRow('user_outsider')],
        organizations: [TOP_ORG],
        memberships: [],
        manager_assignments: [],
      }),
      SESSION_REVOCATION: makeFakeSessionNs([]),
    })
    const app = buildApp(registerApplications)
    const res = await app.request(
      'https://acme.xid.dev/v1/applications',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )
    expect(res.status).toBe(403)
  })

  it('无 session 无 Bearer -> GET /v1/webhooks 401', async () => {
    const env = asUnknown<Env>({
      DB: makeFakeD1({}),
      SESSION_REVOCATION: makeFakeSessionNs([]),
    })
    const app = buildApp(registerWebhooks)
    const res = await app.request('https://acme.xid.dev/v1/webhooks', {}, env)
    expect(res.status).toBe(401)
  })
})

// org 级审计 endpoint 的归属过滤与跨租户隔离(createTenantDb 注入 tenant_id)。
describe('v1 org audit-events 归属与跨租户隔离', () => {
  const TOP_ORG = { id: 't_1', tenant_id: 't_1', status: 'active' }

  function auditRow(
    id: string,
    tenantId: string,
    occurredAt: string,
    orgId: string | null = null,
  ): Record<string, unknown> {
    return {
      id,
      seq: 1,
      tenant_id: tenantId,
      org_id: orgId,
      event_type: 'user.created',
      actor_id: null,
      actor_ip: null,
      target_type: null,
      target_id: null,
      occurred_at: occurredAt,
    }
  }

  it('org admin(cookie)-> 200,不见 orgId=null 租户级事件与他 org 事件', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_1',
    })
    const env = asUnknown<Env>({
      DB: makeFakeD1({
        sessions: [session],
        users: [activeUserRow('user_admin')],
        organizations: [
          { id: 'org_1', tenant_id: 't_1', status: 'active' },
          { id: 'org_2', tenant_id: 't_1', status: 'active' },
        ],
        memberships: [
          {
            id: 'm_1',
            tenant_id: 't_1',
            org_id: 'org_1',
            user_id: 'user_admin',
            role: 'admin',
            status: 'active',
          },
        ],
        manager_assignments: [],
        audit_events: [
          auditRow('ae_org', 't_1', '2024-01-02T00:00:00Z', 'org_1'),
          // 登录类/租户级事件 org_id 为 null:org admin 不可见(含他 org 用户登录 IP/时间)。
          auditRow('ae_tenant_wide', 't_1', '2024-01-03T00:00:00Z'),
          auditRow('ae_other_org', 't_1', '2024-01-04T00:00:00Z', 'org_2'),
          auditRow('ae_other_tenant', 't_other', '2024-01-05T00:00:00Z'),
        ],
      }),
      SESSION_REVOCATION: makeFakeSessionNs([]),
    })
    const app = buildApp(registerOrganizationsRoutes)
    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/audit-events',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { id: string }[] }
    expect(body.data.map((e) => e.id)).toEqual(['ae_org'])
  })

  it('sk key(Management API 信任域)-> 可见 orgId=null 租户级事件', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const env = asUnknown<Env>({
      DB: makeFakeD1({
        api_keys: [apiKey],
        organizations: [TOP_ORG],
        audit_events: [
          auditRow('ae_org', 't_1', '2024-01-02T00:00:00Z', 't_1'),
          auditRow('ae_tenant_wide', 't_1', '2024-01-03T00:00:00Z'),
          auditRow('ae_other_tenant', 't_other', '2024-01-04T00:00:00Z'),
        ],
      }),
    })
    const app = buildApp(registerOrganizationsRoutes)
    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/t_1/audit-events',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { id: string }[] }
    // fake D1 不实现 ORDER BY,只断言可见集合(orgId=null + 本 org 可见,他租户不可见)。
    expect(body.data.map((e) => e.id).sort()).toEqual(['ae_org', 'ae_tenant_wide'])
  })

  it('org admin + instance_manager 分配 -> 可见 orgId=null 租户级事件', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
    })
    const env = asUnknown<Env>({
      DB: makeFakeD1({
        sessions: [session],
        users: [activeUserRow('user_admin')],
        organizations: [TOP_ORG],
        memberships: [
          {
            id: 'm_1',
            tenant_id: 't_1',
            org_id: 't_1',
            user_id: 'user_admin',
            role: 'admin',
            status: 'active',
          },
        ],
        manager_assignments: [
          {
            id: 'mgr_1',
            tenant_id: 't_1',
            user_id: 'user_admin',
            manager_role: 'instance_manager',
            scope_type: 'instance',
            scope_id: null,
          },
        ],
        audit_events: [
          auditRow('ae_org', 't_1', '2024-01-02T00:00:00Z', 't_1'),
          auditRow('ae_tenant_wide', 't_1', '2024-01-03T00:00:00Z'),
        ],
      }),
      SESSION_REVOCATION: makeFakeSessionNs([]),
    })
    const app = buildApp(registerOrganizationsRoutes)
    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/t_1/audit-events',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { id: string }[] }
    expect(body.data.map((e) => e.id).sort()).toEqual(['ae_org', 'ae_tenant_wide'])
  })

  it('session 非成员 -> 403', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_outsider',
    })
    const env = asUnknown<Env>({
      DB: makeFakeD1({
        sessions: [session],
        users: [activeUserRow('user_outsider')],
        organizations: [TOP_ORG],
        memberships: [],
        manager_assignments: [],
        audit_events: [],
      }),
      SESSION_REVOCATION: makeFakeSessionNs([]),
    })
    const app = buildApp(registerOrganizationsRoutes)
    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/t_1/audit-events',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )
    expect(res.status).toBe(403)
  })
})

describe('v1 org scim-targets 归属与跨租户隔离', () => {
  const ORG_A = { id: 'org_a', tenant_id: 't_1', status: 'active' }
  const ORG_B = { id: 'org_b', tenant_id: 't_1', status: 'active' }

  it('org admin -> 200,只返回本 org 的 scim targets', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_a',
    })
    const env = asUnknown<Env>({
      DB: makeFakeD1({
        sessions: [session],
        users: [activeUserRow('user_admin')],
        organizations: [ORG_A, ORG_B],
        memberships: [
          {
            id: 'mem_a',
            tenant_id: 't_1',
            org_id: 'org_a',
            user_id: 'user_admin',
            role: 'admin',
            status: 'active',
          },
        ],
        scim_targets: [
          {
            id: 'target_a',
            tenant_id: 't_1',
            org_id: 'org_a',
            provider: 'slack',
            base_url: 'https://example.com/scim/v2',
            token_secret_ref: 'SCIM_TOKEN',
            user_filter: '{}',
            status: 'active',
          },
          {
            id: 'target_b',
            tenant_id: 't_1',
            org_id: 'org_b',
            provider: 'slack',
            base_url: 'https://other.example.com/scim/v2',
            token_secret_ref: 'SCIM_TOKEN',
            user_filter: '{}',
            status: 'active',
          },
        ],
      }),
      SESSION_REVOCATION: makeFakeSessionNs([]),
      SCIM_TOKEN: 'secret',
    })
    const app = buildApp(registerOrganizationsRoutes)
    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_a/scim-targets',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string }[]
    expect(body.map((row) => row.id)).toEqual(['target_a'])
  })

  it('session 非成员 -> 403', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_outsider',
      activeOrgId: 'org_a',
    })
    const env = asUnknown<Env>({
      DB: makeFakeD1({
        sessions: [session],
        users: [activeUserRow('user_outsider')],
        organizations: [ORG_A],
        memberships: [],
        scim_targets: [],
      }),
      SESSION_REVOCATION: makeFakeSessionNs([]),
    })
    const app = buildApp(registerOrganizationsRoutes)
    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_a/scim-targets',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )
    expect(res.status).toBe(403)
  })
})

describe('v1 org outbound-saml-apps 归属与跨租户隔离', () => {
  const ORG_A = { id: 'org_a', tenant_id: 't_1', status: 'active' }
  const ORG_B = { id: 'org_b', tenant_id: 't_1', status: 'active' }

  it('org admin -> 200,只返回本 org 的 outbound SAML apps', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_a',
    })
    const env = asUnknown<Env>({
      DB: makeFakeD1({
        sessions: [session],
        users: [activeUserRow('user_admin')],
        organizations: [ORG_A, ORG_B],
        memberships: [
          {
            id: 'mem_a',
            tenant_id: 't_1',
            org_id: 'org_a',
            user_id: 'user_admin',
            role: 'admin',
            status: 'active',
          },
        ],
        saml_service_providers: [
          {
            id: 'app_a',
            tenant_id: 't_1',
            org_id: 'org_a',
            sp_entity_id: 'https://slack.com',
            acs_url: 'https://example.com/acs',
            attribute_mapping: '{}',
            name_id_format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
          },
          {
            id: 'app_b',
            tenant_id: 't_1',
            org_id: 'org_b',
            sp_entity_id: 'https://slack.com',
            acs_url: 'https://other.example.com/acs',
            attribute_mapping: '{}',
            name_id_format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
          },
        ],
      }),
      SESSION_REVOCATION: makeFakeSessionNs([]),
    })
    const app = buildApp(registerOrganizationsRoutes)
    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_a/outbound-saml-apps',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string }[]
    expect(body.map((row) => row.id)).toEqual(['app_a'])
  })

  it('session 非成员 -> 403', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_outsider',
      activeOrgId: 'org_a',
    })
    const env = asUnknown<Env>({
      DB: makeFakeD1({
        sessions: [session],
        users: [activeUserRow('user_outsider')],
        organizations: [ORG_A],
        memberships: [],
        saml_service_providers: [],
      }),
      SESSION_REVOCATION: makeFakeSessionNs([]),
    })
    const app = buildApp(registerOrganizationsRoutes)
    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_a/outbound-saml-apps',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )
    expect(res.status).toBe(403)
  })
})

describe('v1 users Management API 契约', () => {
  it('非空 API key scopes 不允许 users 写操作', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1', ['users:read'])
    const db = makeFakeD1({ api_keys: [apiKey] })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerUsersRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/users',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice' }),
      },
      env,
    )

    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('insufficient_permission')
  })

  it('DELETE -> 标记 deleted,普通列表和详情不再返回', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const user = {
      id: 'user_1',
      tenant_id: 't_1',
      username: 'alice',
      external_id: null,
      first_name: 'Alice',
      last_name: null,
      display_name: null,
      public_metadata: {},
      private_metadata: {},
      unsafe_metadata: {},
      locale: 'en',
      timezone: 'UTC',
      status: 'active',
      deleted_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], users: [user] })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerUsersRoutes)

    const del = await app.request(
      'https://acme.xid.dev/v1/users/user_1',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(del.status).toBe(204)
    expect(user['status']).toBe('deleted')
    expect(user['deleted_at']).toBeTypeOf('number')

    const list = await app.request(
      'https://acme.xid.dev/v1/users',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(list.status).toBe(200)
    const page = (await list.json()) as {
      data: unknown[]
      next_cursor: string | null
      has_more: boolean
    }
    expect(page.data).toEqual([])
    expect(page.next_cursor).toBeNull()
    expect(page.has_more).toBe(false)

    const get = await app.request(
      'https://acme.xid.dev/v1/users/user_1',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(get.status).toBe(404)
  })

  it('deleted_at 非空即使 status active 也不进入普通列表和详情', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const user = {
      id: 'user_deleted_at',
      tenant_id: 't_1',
      username: 'ghost',
      external_id: null,
      first_name: 'Ghost',
      last_name: null,
      display_name: null,
      public_metadata: {},
      private_metadata: {},
      unsafe_metadata: {},
      locale: 'en',
      timezone: 'UTC',
      status: 'active',
      deleted_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], users: [user] })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerUsersRoutes)

    const list = await app.request(
      'https://acme.xid.dev/v1/users',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(list.status).toBe(200)
    const page = (await list.json()) as { data: unknown[] }
    expect(page.data).toEqual([])

    const get = await app.request(
      'https://acme.xid.dev/v1/users/user_deleted_at',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(get.status).toBe(404)
  })

  it('POST restore -> 恢复 deleted user,普通详情重新可读', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const user = {
      id: 'user_1',
      tenant_id: 't_1',
      username: 'alice',
      external_id: 'ext_alice',
      first_name: 'Alice',
      last_name: null,
      display_name: null,
      public_metadata: {},
      private_metadata: {},
      unsafe_metadata: {},
      locale: 'en',
      timezone: 'UTC',
      status: 'deleted',
      deleted_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], users: [user] })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerUsersRoutes)

    const restore = await app.request(
      'https://acme.xid.dev/v1/users/user_1/restore',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(restore.status).toBe(200)
    expect(user['status']).toBe('active')
    expect(user['deleted_at']).toBeNull()

    const get = await app.request(
      'https://acme.xid.dev/v1/users/user_1',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(get.status).toBe(200)
    const body = (await get.json()) as Record<string, unknown>
    expect(body['id']).toBe('user_1')
  })

  it('POST restore 跨租户 user -> 404 且不修改受害租户行', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const victim = {
      id: 'user_victim',
      tenant_id: 't_other',
      username: 'alice',
      external_id: null,
      first_name: 'Alice',
      last_name: null,
      display_name: null,
      public_metadata: {},
      private_metadata: {},
      unsafe_metadata: {},
      locale: 'en',
      timezone: 'UTC',
      status: 'deleted',
      deleted_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], users: [victim] })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerUsersRoutes)

    const restore = await app.request(
      'https://acme.xid.dev/v1/users/user_victim/restore',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(restore.status).toBe(404)
    expect(victim['status']).toBe('deleted')
    expect(victim['deleted_at']).toBeTypeOf('number')
  })

  it('POST restore 遇到 active 用户占用同 username -> 409', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const deletedUser = {
      id: 'user_deleted',
      tenant_id: 't_1',
      username: 'alice',
      external_id: null,
      first_name: 'Deleted',
      last_name: null,
      display_name: null,
      public_metadata: {},
      private_metadata: {},
      unsafe_metadata: {},
      locale: 'en',
      timezone: 'UTC',
      status: 'deleted',
      deleted_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const activeUser = {
      ...deletedUser,
      id: 'user_active',
      status: 'active',
      deleted_at: null,
      first_name: 'Active',
    }
    const db = makeFakeD1({ api_keys: [apiKey], users: [deletedUser, activeUser] })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerUsersRoutes)

    const restore = await app.request(
      'https://acme.xid.dev/v1/users/user_deleted/restore',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(restore.status).toBe(409)
    const body = (await restore.json()) as Record<string, unknown>
    expect(body['code']).toBe('already_exists')
    expect(deletedUser['status']).toBe('deleted')
    expect(deletedUser['deleted_at']).toBeTypeOf('number')
  })

  it('GET /v1/users/export 不被 /:id 详情路由截获', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const user = {
      id: 'user_1',
      tenant_id: 't_1',
      username: 'alice',
      external_id: null,
      first_name: 'Alice',
      last_name: null,
      display_name: null,
      public_metadata: {},
      private_metadata: {},
      unsafe_metadata: {},
      locale: 'en',
      timezone: 'UTC',
      status: 'active',
      deleted_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], users: [user] })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerUsersRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/users/export',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    expect(await res.text()).toContain('"id":"user_1"')
  })

  it('软删除用户释放 username 和 external_id 供重新创建', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const deletedUser = {
      id: 'user_deleted',
      tenant_id: 't_1',
      username: 'alice',
      external_id: 'ext_alice',
      first_name: 'Deleted',
      last_name: null,
      display_name: null,
      public_metadata: {},
      private_metadata: {},
      unsafe_metadata: {},
      locale: 'en',
      timezone: 'UTC',
      status: 'deleted',
      deleted_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], users: [deletedUser] })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerUsersRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/users',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', external_id: 'ext_alice' }),
      },
      env,
    )

    expect(res.status).toBe(201)
  })

  it('active 用户的 external_id 仍不可被更新抢占', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const user = {
      id: 'user_1',
      tenant_id: 't_1',
      username: 'alice',
      external_id: 'ext_alice',
      first_name: 'Alice',
      last_name: null,
      display_name: null,
      public_metadata: {},
      private_metadata: {},
      unsafe_metadata: {},
      locale: 'en',
      timezone: 'UTC',
      status: 'active',
      deleted_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const dup = {
      ...user,
      id: 'user_2',
      username: 'bob',
      external_id: 'ext_bob',
      first_name: 'Bob',
    }
    const db = makeFakeD1({ api_keys: [apiKey], users: [user, dup] })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerUsersRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/users/user_1',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ external_id: 'ext_bob' }),
      },
      env,
    )

    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('already_exists')
  })
})

describe('v1 organizations Management API 契约', () => {
  it('非空 API key scopes 不允许 organizations 写操作', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1', ['organizations:read'])
    const db = makeFakeD1({ api_keys: [apiKey] })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerOrganizationsRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/organizations',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'acme', name: 'Acme' }),
      },
      env,
    )

    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('insufficient_permission')
  })

  it('DELETE -> 标记 deleted,普通列表和详情不再返回', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const org = {
      id: 'org_1',
      tenant_id: 't_1',
      instance_id: 't_1',
      slug: 'acme',
      name: 'Acme',
      public_metadata: {},
      private_metadata: {},
      enrollment_mode: 'invite_required',
      seat_limit: null,
      status: 'active',
      deleted_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], organizations: [org] })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerOrganizationsRoutes)

    const del = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(del.status).toBe(204)
    expect(org['status']).toBe('deleted')
    expect(org['deleted_at']).toBeTypeOf('number')

    const list = await app.request(
      'https://acme.xid.dev/v1/organizations',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(list.status).toBe(200)
    const page = (await list.json()) as {
      data: unknown[]
      next_cursor: string | null
      has_more: boolean
    }
    expect(page.data).toEqual([])
    expect(page.next_cursor).toBeNull()
    expect(page.has_more).toBe(false)

    const get = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(get.status).toBe(404)
  })

  it('POST restore -> 恢复 deleted organization,普通详情重新可读', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const org = {
      id: 'org_1',
      tenant_id: 't_1',
      instance_id: 't_1',
      slug: 'acme',
      name: 'Acme',
      public_metadata: {},
      private_metadata: {},
      enrollment_mode: 'invite_required',
      seat_limit: null,
      status: 'deleted',
      deleted_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], organizations: [org] })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerOrganizationsRoutes)

    const restore = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/restore',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )

    expect(restore.status).toBe(200)
    expect(org['status']).toBe('active')
    expect(org['deleted_at']).toBeNull()

    const get = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(get.status).toBe(200)
  })

  it('POST restore 跨租户 organization -> 404 且不修改受害租户行', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const victim = {
      id: 'org_victim',
      tenant_id: 't_other',
      instance_id: 't_other',
      slug: 'victim',
      name: 'Victim',
      status: 'deleted',
      deleted_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], organizations: [victim] })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerOrganizationsRoutes)

    const restore = await app.request(
      'https://acme.xid.dev/v1/organizations/org_victim/restore',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )

    expect(restore.status).toBe(404)
    expect(victim['status']).toBe('deleted')
    expect(victim['deleted_at']).toBeTypeOf('number')
  })
})

describe('v1 organization domains 软删除', () => {
  it('DELETE domain -> 标记 deleted,普通列表不再返回', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const org = { id: 'org_1', tenant_id: 't_1', status: 'active' }
    const domain = {
      id: 'dom_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      domain: 'example.com',
      verification_method: 'dns_txt',
      verification_token: 'tok',
      verification_status: 'verified',
      status: 'active',
      is_wildcard: 0,
      enrollment_mode: 'invite_required',
      verified_at: Date.now(),
      deleted_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [org],
      organization_domains: [domain],
    })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: { send: async () => {} } })
    const app = buildApp(registerOrganizationsRoutes)

    const del = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/domains/dom_1',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(del.status).toBe(204)
    expect(domain['status']).toBe('deleted')
    expect(domain['deleted_at']).toBeTypeOf('number')

    const list = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/domains',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(list.status).toBe(200)
    const body = (await list.json()) as { data: unknown[] }
    expect(body.data).toEqual([])
  })
})

describe('v1 memberships 创建软删除过滤', () => {
  it('POST membership 拒绝 deleted_at 非空的 active user', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1', ['memberships:write'])
    const memberships: Record<string, unknown>[] = []
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
      users: [
        {
          id: 'user_deleted',
          tenant_id: 't_1',
          status: 'active',
          deleted_at: Date.now(),
        },
      ],
      memberships,
    })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerMembershipsRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/memberships',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'user_deleted' }),
      },
      env,
    )

    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('not_found')
    expect(memberships).toEqual([])
  })

  it('DELETE -> 标记 inactive,普通列表和详情不再返回', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const membership = {
      id: 'mem_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      user_id: 'user_1',
      role: 'member',
      status: 'active',
      joined_at: Date.now(),
    }
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
      memberships: [membership],
    })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerMembershipsRoutes)

    const del = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/memberships/mem_1',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(del.status).toBe(204)
    expect(membership['status']).toBe('inactive')

    const list = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/memberships',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(list.status).toBe(200)
    const page = (await list.json()) as { data: unknown[] }
    expect(page.data).toEqual([])

    const get = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/memberships/mem_1',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(get.status).toBe(404)
  })

  it('POST restore -> 恢复 inactive membership,普通详情重新可读', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const membership = {
      id: 'mem_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      user_id: 'user_1',
      role: 'member',
      status: 'inactive',
      joined_at: Date.now() - 1000,
    }
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
      users: [activeUserRow('user_1')],
      memberships: [membership],
    })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerMembershipsRoutes)

    const restore = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/memberships/mem_1/restore',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(restore.status).toBe(200)
    expect(membership['status']).toBe('active')

    const get = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/memberships/mem_1',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(get.status).toBe(200)
  })

  it('POST restore 拒绝 deleted_at 非空的 membership user', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const membership = {
      id: 'mem_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      user_id: 'user_deleted',
      role: 'member',
      status: 'inactive',
    }
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
      users: [{ id: 'user_deleted', tenant_id: 't_1', status: 'active', deleted_at: Date.now() }],
      memberships: [membership],
    })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerMembershipsRoutes)

    const restore = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/memberships/mem_1/restore',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )

    expect(restore.status).toBe(404)
    expect(membership['status']).toBe('inactive')
  })

  it('POST restore 跨租户 membership -> 404 且不修改受害租户行', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const victim = {
      id: 'mem_victim',
      tenant_id: 't_other',
      org_id: 'org_1',
      user_id: 'user_victim',
      role: 'member',
      status: 'inactive',
    }
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
      users: [activeUserRow('user_victim', 't_other')],
      memberships: [victim],
    })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerMembershipsRoutes)

    const restore = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/memberships/mem_victim/restore',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )

    expect(restore.status).toBe(404)
    expect(victim['status']).toBe('inactive')
  })
})

describe('v1 invitations revoke 语义', () => {
  it('DELETE -> 标记 revoked,普通列表和详情不再返回', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const invitation = {
      id: 'inv_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      email: 'user@example.com',
      role: 'member',
      token_hash: 'hash',
      status: 'pending',
      expires_at: Date.now() + 3_600_000,
    }
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
      invitations: [invitation],
    })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerInvitationsRoutes)

    const del = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/invitations/inv_1',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(del.status).toBe(204)
    expect(invitation['status']).toBe('revoked')

    const list = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/invitations',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(list.status).toBe(200)
    const page = (await list.json()) as { data: unknown[] }
    expect(page.data).toEqual([])

    const get = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/invitations/inv_1',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(get.status).toBe(404)
  })

  it('POST revoke 跨租户 invitation -> 404 且不修改受害租户行', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const victim = {
      id: 'inv_victim',
      tenant_id: 't_other',
      org_id: 'org_1',
      email: 'victim@example.com',
      role: 'member',
      token_hash: 'hash',
      status: 'pending',
      expires_at: Date.now() + 3_600_000,
    }
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
      invitations: [victim],
    })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerInvitationsRoutes)

    const revoke = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/invitations/inv_victim/revoke',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )

    expect(revoke.status).toBe(404)
    expect(victim['status']).toBe('pending')
  })
})

describe('v1 invitations cookie 路径 role 防自提', () => {
  async function setupConsoleInvitation(callerRole: string) {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({ tenantId: 't_1', userId: 'user_caller', activeOrgId: 'org_1' })
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_caller')],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
      memberships: [
        {
          id: 'mem_caller',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_caller',
          role: callerRole,
          status: 'active',
        },
      ],
      manager_assignments: [],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      EMAIL_QUEUE: makeFakeQueue(),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    return { token, cookieName, env }
  }

  function postInvitation(
    app: Hono<XidHonoEnv>,
    env: Env,
    cookie: { cookieName: string; token: string },
    role: string,
  ): Promise<Response> {
    return app.request(
      'https://acme.xid.dev/v1/organizations/org_1/invitations',
      {
        method: 'POST',
        headers: {
          Cookie: `${cookie.cookieName}=${cookie.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'new@example.com', role }),
      },
      env,
    )
  }

  it('admin 发 owner 邀请 -> 403 forbidden(不得高于调用者 role)', async () => {
    const { token, cookieName, env } = await setupConsoleInvitation('admin')
    const app = buildApp(registerInvitationsRoutes)

    const res = await postInvitation(app, env, { cookieName, token }, 'owner')

    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('forbidden')
  })

  it('admin 发 admin 邀请 -> 201(同级允许)', async () => {
    const { token, cookieName, env } = await setupConsoleInvitation('admin')
    const app = buildApp(registerInvitationsRoutes)

    const res = await postInvitation(app, env, { cookieName, token }, 'admin')

    expect(res.status).toBe(201)
  })

  it('owner 发 owner 邀请 -> 201', async () => {
    const { token, cookieName, env } = await setupConsoleInvitation('owner')
    const app = buildApp(registerInvitationsRoutes)

    const res = await postInvitation(app, env, { cookieName, token }, 'owner')

    expect(res.status).toBe(201)
  })
})

describe('v1 project grants revoke 语义', () => {
  it('DELETE -> 标记 revoked,普通列表不再返回,Grant 下 user_grants 一并 revoked', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const grant = {
      id: 'grant_1',
      tenant_id: 't_1',
      granted_project_id: 'proj_1',
      granted_by_org_id: 'org_a',
      granted_to_org_id: 'org_b',
      status: 'active',
      revoked_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const userGrant = {
      id: 'ug_1',
      tenant_id: 't_1',
      user_id: 'user_b',
      project_id: 'proj_1',
      role_id: 'role_1',
      granted_via_grant_id: 'grant_1',
      revoked_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({
      api_keys: [apiKey],
      project_grants: [grant],
      user_grants: [userGrant],
    })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerProjectGrants)

    const del = await app.request(
      'https://acme.xid.dev/v1/project-grants/grant_1',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(del.status).toBe(204)
    expect(grant['status']).toBe('revoked')
    expect(grant['revoked_at']).toBeTypeOf('number')
    expect(userGrant['revoked_at']).toBeTypeOf('number')

    const list = await app.request(
      'https://acme.xid.dev/v1/project-grants',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(list.status).toBe(200)
    const body = (await list.json()) as { data: unknown[] }
    expect(body.data).toEqual([])
  })

  it('POST 跨租户 granted_to_org_id -> 404 org_not_found', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [
        { id: 'org_a', tenant_id: 't_1', status: 'active' },
        { id: 'org_victim', tenant_id: 't_other', status: 'active' },
      ],
      projects: [{ id: 'proj_1', tenant_id: 't_1', org_id: 'org_a' }],
    })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp(registerProjectGrants)

    const res = await app.request(
      'https://acme.xid.dev/v1/project-grants',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          granted_project_id: 'proj_1',
          granted_by_org_id: 'org_a',
          granted_to_org_id: 'org_victim',
        }),
      },
      env,
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('org_not_found')
  })
})

describe('org console members 契约:cookie session + org manager 门控', () => {
  it('GET /v1/organizations/:id/members 无 session -> 401', async () => {
    const db = makeFakeD1({
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    const app = buildApp(registerOrganizationsRoutes)
    const res = await app.request('https://acme.xid.dev/v1/organizations/org_1/members', {}, env)
    expect(res.status).toBe(401)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('unauthorized')
  })

  it('普通成员不能读取 org console members -> 403', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_member',
      activeOrgId: 'org_1',
    })
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_member')],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
      memberships: [
        {
          id: 'mem_member',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_member',
          role: 'member',
          status: 'active',
        },
      ],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    const app = buildApp(registerOrganizationsRoutes)
    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/members',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('forbidden')
  })

  it('admin 可读取 org stats 聚合指标', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_1',
    })
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_admin')],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
      memberships: [
        {
          id: 'mem_admin',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_admin',
          role: 'admin',
          status: 'active',
        },
        {
          id: 'mem_target',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_target',
          role: 'member',
          status: 'active',
        },
      ],
      invitations: [
        { id: 'inv_1', tenant_id: 't_1', org_id: 'org_1', status: 'pending' },
        { id: 'inv_2', tenant_id: 't_1', org_id: 'org_1', status: 'revoked' },
      ],
      mfa_factors: [{ id: 'mfa_1', tenant_id: 't_1', user_id: 'user_admin', status: 'active' }],
      usage_daily: [{ tenant_id: 't_1', day: new Date().toISOString().slice(0, 10), dau: 7 }],
      usage_monthly: [
        { tenant_id: 't_1', year_month: new Date().toISOString().slice(0, 7), mau: 13 },
      ],
      audit_events: [
        {
          tenant_id: 't_1',
          org_id: 'org_1',
          event_type: 'authentication.login_succeeded',
        },
        {
          tenant_id: 't_1',
          org_id: 'org_1',
          event_type: 'authentication.login_failed',
        },
      ],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    const app = buildApp(registerOrganizationsRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/stats',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['dau']).toBe(7)
    expect(body['mau']).toBe(13)
    expect(body['loginSuccessRate']).toBe(0.5)
    expect(body['mfaAdoptionRate']).toBe(0.5)
    expect(body['activeMemberCount']).toBe(2)
    expect(body['pendingInvitationCount']).toBe(1)
  })

  it('admin 可创建 SSO connection', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_1',
    })
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_admin')],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
      memberships: [
        {
          id: 'mem_admin',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_admin',
          role: 'admin',
          status: 'active',
        },
      ],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    const app = buildApp(registerOrganizationsRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/sso-connections',
      {
        method: 'POST',
        headers: { Cookie: `${cookieName}=${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocol: 'saml',
          idp_entity_id: 'https://idp.example.com/entity',
          idp_sso_url: 'https://idp.example.com/sso',
        }),
      },
      env,
    )

    expect(res.status).toBe(201)
  })

  it('admin 可读取并更新 SSO connection JIT 和 mapping', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_1',
    })
    const connection = {
      id: 'conn_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      protocol: 'saml',
      idp_entity_id: 'https://idp.example.com/entity',
      idp_sso_url: 'https://idp.example.com/sso',
      idp_metadata_url: null,
      idp_certificates: ['old-cert'],
      oidc_client_id: null,
      oidc_discovery_url: null,
      want_authn_response_signed: 1,
      want_assertions_signed: 1,
      attribute_mapping: { email: 'mail' },
      role_mapping: { Engineering: 'member' },
      jit_enabled: 1,
      status: 'active',
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_admin')],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
      memberships: [
        {
          id: 'mem_admin',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_admin',
          role: 'admin',
          status: 'active',
        },
      ],
      sso_connections: [connection],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    const app = buildApp(registerOrganizationsRoutes)

    const list = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/sso-connections',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )
    expect(list.status).toBe(200)
    const before = (await list.json()) as Record<string, unknown>[]
    expect(before[0]).toMatchObject({
      id: 'conn_1',
      type: 'saml',
      jit_enabled: true,
      attribute_mapping: { email: 'mail' },
      role_mapping: { Engineering: 'member' },
    })

    const update = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/sso-connections/conn_1',
      {
        method: 'PATCH',
        headers: { Cookie: `${cookieName}=${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jit_enabled: false,
          attribute_mapping: { email: 'email', groups: 'groups' },
          role_mapping: { Admins: 'admin' },
          idp_certificates: ['new-cert'],
        }),
      },
      env,
    )

    expect(update.status).toBe(200)
    const body = (await update.json()) as Record<string, unknown>
    expect(body['jit_enabled']).toBe(false)
    expect(body['attribute_mapping']).toEqual({ email: 'email', groups: 'groups' })
    expect(body['role_mapping']).toEqual({ Admins: 'admin' })
    expect(body['idp_certificates']).toEqual(['new-cert'])
  })

  it('admin 删除 SSO connection 后普通列表过滤 inactive', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_1',
    })
    const connection = {
      id: 'conn_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      protocol: 'oidc',
      idp_entity_id: null,
      idp_sso_url: null,
      idp_metadata_url: null,
      idp_certificates: [],
      oidc_client_id: 'client',
      oidc_discovery_url: 'https://idp.example.com/.well-known/openid-configuration',
      attribute_mapping: {},
      role_mapping: {},
      jit_enabled: 1,
      status: 'active',
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_admin')],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
      memberships: [
        {
          id: 'mem_admin',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_admin',
          role: 'admin',
          status: 'active',
        },
      ],
      sso_connections: [connection],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    const app = buildApp(registerOrganizationsRoutes)

    const del = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/sso-connections/conn_1',
      { method: 'DELETE', headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )

    expect(del.status).toBe(204)
    expect(connection['status']).toBe('deleted')

    const list = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/sso-connections',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )
    expect(list.status).toBe(200)
    const body = (await list.json()) as Record<string, unknown>[]
    expect(body).toEqual([])
  })

  it('admin 可创建 SCIM directory 并只返回一次 token', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_1',
    })
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_admin')],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
      memberships: [
        {
          id: 'mem_admin',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_admin',
          role: 'admin',
          status: 'active',
        },
      ],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    const app = buildApp(registerOrganizationsRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/directories',
      {
        method: 'POST',
        headers: { Cookie: `${cookieName}=${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'okta' }),
      },
      env,
    )

    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body['scimToken']).toBe('string')
  })

  it('admin 可读取 auth policy 且不暴露 social provider 配置', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_1',
    })
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_admin')],
      organizations: [
        {
          id: 'org_1',
          tenant_id: 't_1',
          status: 'active',
          private_metadata: {
            hostedAuth: { magicLink: { enabled: true, allowLogin: true, allowUserCreation: true } },
            socialProviders: {
              google: {
                authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
                tokenEndpoint: 'https://oauth2.googleapis.com/token',
                clientId: 'google-client',
                clientSecretRef: 'secret:google',
                scopes: ['openid', 'email'],
                usesPkce: true,
                enabled: true,
                allowLogin: true,
                allowUserCreation: false,
                requireVerifiedEmail: true,
                allowedEmailDomains: ['example.com'],
                blockedEmailDomains: ['blocked.example'],
              },
            },
          },
        },
      ],
      memberships: [
        {
          id: 'mem_admin',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_admin',
          role: 'admin',
          status: 'active',
        },
      ],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    const app = buildApp(registerOrganizationsRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/auth-policy',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      hostedAuth: Record<string, unknown>
      socialProviders?: unknown
      providerReadiness?: unknown
      deliveryChannelReadiness: Record<string, Record<string, unknown>>
    }
    expect(body.hostedAuth['identifierMode']).toBe('email')
    expect(body.socialProviders).toBeUndefined()
    expect(body.providerReadiness).toBeUndefined()
    expect(body.deliveryChannelReadiness['whatsappOtp']).toEqual({
      configured: false,
      channel: null,
    })
  })

  it('social providers 按 Workers env 计算 credentials readiness 且 secret 不回显', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_1',
    })
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_admin')],
      organizations: [
        {
          id: 'org_1',
          tenant_id: 't_1',
          status: 'active',
          private_metadata: {
            hostedAuth: {},
            socialProviders: {
              google: {
                authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
                tokenEndpoint: 'https://oauth2.googleapis.com/token',
                clientId: 'google-client',
                clientSecretRef: 'GOOGLE_CLIENT_SECRET',
                issuer: 'https://accounts.google.com',
                jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                scopes: ['openid', 'email'],
                usesPkce: true,
                enabled: true,
                allowLogin: true,
                allowUserCreation: false,
                requireVerifiedEmail: true,
                allowedEmailDomains: [],
                blockedEmailDomains: [],
              },
            },
          },
        },
      ],
      memberships: [
        {
          id: 'mem_admin',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_admin',
          role: 'admin',
          status: 'active',
        },
      ],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
      GOOGLE_CLIENT_SECRET: 'secret-value',
    })
    const app = buildApp(registerOrganizationsRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/social-providers',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      socialProviders: Record<string, Record<string, unknown>>
    }
    expect(body.socialProviders.google).toMatchObject({
      clientSecretRef: 'GOOGLE_CLIENT_SECRET',
      hasClientSecret: true,
      credentialsReady: true,
    })
    expect(JSON.stringify(body)).not.toContain('secret-value')
  })

  it('social providers 对 OIDC provider 缺 issuer 或 JWKS 时 credentials not ready', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_1',
    })
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_admin')],
      organizations: [
        {
          id: 'org_1',
          tenant_id: 't_1',
          status: 'active',
          private_metadata: {
            hostedAuth: {},
            socialProviders: {
              google: {
                authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
                tokenEndpoint: 'https://oauth2.googleapis.com/token',
                clientId: 'google-client',
                clientSecretRef: 'GOOGLE_CLIENT_SECRET',
                scopes: ['openid', 'email'],
                usesPkce: true,
                enabled: true,
                allowLogin: true,
                allowUserCreation: false,
                requireVerifiedEmail: true,
                allowedEmailDomains: [],
                blockedEmailDomains: [],
              },
            },
          },
        },
      ],
      memberships: [
        {
          id: 'mem_admin',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_admin',
          role: 'admin',
          status: 'active',
        },
      ],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
      GOOGLE_CLIENT_SECRET: 'secret-value',
    })
    const app = buildApp(registerOrganizationsRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/social-providers',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      socialProviders: Record<string, Record<string, unknown>>
    }
    expect(body.socialProviders.google).toMatchObject({
      hasClientSecret: true,
      credentialsReady: false,
    })
  })

  it('auth policy 返回 WhatsApp/SMS delivery channel readiness 且无 secret 时为 false', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_1',
    })
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_admin')],
      organizations: [
        {
          id: 'org_1',
          tenant_id: 't_1',
          status: 'active',
          private_metadata: {
            hostedAuth: {
              whatsappOtp: { enabled: true, allowLogin: true, allowUserCreation: false },
              smsOtp: { enabled: true, allowLogin: true, allowUserCreation: false },
            },
            deliveryChannels: {
              whatsapp: {
                provider: 'meta',
                enabled: true,
                secretRefs: ['WHATSAPP_META_PHONE_NUMBER_ID', 'WHATSAPP_META_ACCESS_TOKEN'],
              },
              sms: {
                provider: 'twilio',
                enabled: true,
                secretRefs: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
                from: '+15550000000',
              },
            },
            socialProviders: {},
          },
        },
      ],
      memberships: [
        {
          id: 'mem_admin',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_admin',
          role: 'admin',
          status: 'active',
        },
      ],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    const app = buildApp(registerOrganizationsRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/auth-policy',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      providerReadiness?: unknown
      deliveryChannelReadiness: Record<string, Record<string, unknown>>
    }
    expect(body.providerReadiness).toBeUndefined()
    expect(body.deliveryChannelReadiness['whatsappOtp']).toEqual({
      configured: false,
      channel: null,
    })
    expect(body.deliveryChannelReadiness['smsOtp']).toEqual({
      configured: false,
      channel: null,
    })
  })

  it('auth policy 按 organization delivery channel policy 和 Workers Secret 返回 readiness', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_1',
    })
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_admin')],
      organizations: [
        {
          id: 'org_1',
          tenant_id: 't_1',
          status: 'active',
          private_metadata: {
            hostedAuth: {},
            deliveryChannels: {
              whatsapp: {
                provider: 'meta',
                enabled: true,
                secretRefs: ['WHATSAPP_META_PHONE_NUMBER_ID', 'WHATSAPP_META_ACCESS_TOKEN'],
              },
              sms: {
                provider: 'twilio',
                enabled: true,
                secretRefs: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
              },
            },
            socialProviders: {},
          },
        },
      ],
      memberships: [
        {
          id: 'mem_admin',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_admin',
          role: 'admin',
          status: 'active',
        },
      ],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
      WHATSAPP_META_PHONE_NUMBER_ID: 'phone-number-id',
      WHATSAPP_META_ACCESS_TOKEN: 'access-token',
      TWILIO_ACCOUNT_SID: 'account-sid',
      TWILIO_AUTH_TOKEN: 'auth-token',
      SMS_FROM: '+15550000000',
    })
    const app = buildApp(registerOrganizationsRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/auth-policy',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      deliveryChannelReadiness: Record<string, Record<string, unknown>>
    }
    expect(body.deliveryChannelReadiness['whatsappOtp']).toEqual({
      configured: true,
      channel: 'meta',
    })
    expect(body.deliveryChannelReadiness['smsOtp']).toEqual({
      configured: true,
      channel: 'twilio',
    })
  })

  it('auth policy 允许 Twilio delivery channel 只使用 messaging service sid', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_1',
    })
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_admin')],
      organizations: [
        {
          id: 'org_1',
          tenant_id: 't_1',
          status: 'active',
          private_metadata: {
            hostedAuth: {},
            deliveryChannels: {
              whatsapp: {
                provider: 'twilio',
                enabled: true,
                secretRefs: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
              },
              sms: {
                provider: 'twilio',
                enabled: true,
                secretRefs: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
              },
            },
            socialProviders: {},
          },
        },
      ],
      memberships: [
        {
          id: 'mem_admin',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_admin',
          role: 'admin',
          status: 'active',
        },
      ],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
      TWILIO_ACCOUNT_SID: 'account-sid',
      TWILIO_AUTH_TOKEN: 'auth-token',
      TWILIO_MESSAGING_SERVICE_SID: 'messaging-service-sid',
    })
    const app = buildApp(registerOrganizationsRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/auth-policy',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      deliveryChannelReadiness: Record<string, Record<string, unknown>>
    }
    expect(body.deliveryChannelReadiness['whatsappOtp']).toEqual({
      configured: true,
      channel: 'twilio',
    })
    expect(body.deliveryChannelReadiness['smsOtp']).toEqual({
      configured: true,
      channel: 'twilio',
    })
  })

  it('delivery channels GET/PATCH 使用 secret refs 且不回读 secret value', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_1',
    })
    const org = {
      id: 'org_1',
      tenant_id: 't_1',
      status: 'active',
      private_metadata: {},
    }
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_admin')],
      organizations: [org],
      memberships: [
        {
          id: 'mem_admin',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_admin',
          role: 'admin',
          status: 'active',
        },
      ],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
      WHATSAPP_META_PHONE_NUMBER_ID: 'phone-number-id',
      WHATSAPP_META_ACCESS_TOKEN: 'access-token',
      TWILIO_ACCOUNT_SID: 'account-sid',
      TWILIO_AUTH_TOKEN: 'auth-token',
    })
    const app = buildApp(registerOrganizationsRoutes)

    const patch = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/delivery-channels',
      {
        method: 'PATCH',
        headers: { Cookie: `${cookieName}=${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          whatsapp: {
            provider: 'meta',
            enabled: true,
            secretRefs: ['WHATSAPP_META_PHONE_NUMBER_ID', 'WHATSAPP_META_ACCESS_TOKEN'],
            from: 'whatsapp:+15550000000',
          },
          sms: {
            provider: 'twilio',
            enabled: true,
            secretRefs: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
            from: '+15550000000',
          },
        }),
      },
      env,
    )

    expect(patch.status).toBe(200)
    const patchBody = (await patch.json()) as {
      whatsapp: Record<string, unknown>
      sms: Record<string, unknown>
    }
    expect(patchBody.whatsapp).toMatchObject({
      provider: 'meta',
      enabled: true,
      hasSecrets: true,
      credentialsReady: true,
    })
    expect(patchBody.whatsapp['secretRefs']).toEqual([
      'WHATSAPP_META_PHONE_NUMBER_ID',
      'WHATSAPP_META_ACCESS_TOKEN',
    ])
    expect(JSON.stringify(patchBody)).not.toContain('access-token')
    expect(JSON.stringify(patchBody)).not.toContain('auth-token')

    const get = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/delivery-channels',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )
    expect(get.status).toBe(200)
    const getBody = (await get.json()) as {
      whatsapp: Record<string, unknown>
      sms: Record<string, unknown>
    }
    expect(getBody.sms).toMatchObject({
      provider: 'twilio',
      enabled: true,
      hasSecrets: true,
      credentialsReady: true,
    })
    expect(JSON.stringify(getBody)).not.toContain('phone-number-id')
    expect(JSON.stringify(getBody)).not.toContain('account-sid')
  })

  it('auth policy PATCH 忽略请求体 deliveryChannelReadiness 并按 env 重算', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_1',
    })
    const org = {
      id: 'org_1',
      tenant_id: 't_1',
      status: 'active',
      private_metadata: {
        hostedAuth: {},
        socialProviders: {},
      },
    }
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_admin')],
      organizations: [org],
      memberships: [
        {
          id: 'mem_admin',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_admin',
          role: 'admin',
          status: 'active',
        },
      ],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    const app = buildApp(registerOrganizationsRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/auth-policy',
      {
        method: 'PATCH',
        headers: { Cookie: `${cookieName}=${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostedAuth: {
            smsOtp: { enabled: true, allowLogin: true, allowUserCreation: false },
          },
          providerReadiness: {
            smsOtp: { configured: true, provider: 'legacy-twilio' },
            whatsappOtp: { configured: true, provider: 'legacy-meta' },
          },
          deliveryChannelReadiness: {
            smsOtp: { configured: true, channel: 'twilio' },
            whatsappOtp: { configured: true, channel: 'meta' },
          },
        }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      providerReadiness?: unknown
      deliveryChannelReadiness: Record<string, Record<string, unknown>>
    }
    expect(body.providerReadiness).toBeUndefined()
    expect(body.deliveryChannelReadiness['whatsappOtp']).toEqual({
      configured: false,
      channel: null,
    })
    expect(body.deliveryChannelReadiness['smsOtp']).toEqual({
      configured: false,
      channel: null,
    })
    expect((org.private_metadata as Record<string, unknown>)['providerReadiness']).toBeUndefined()
    expect(
      (org.private_metadata as Record<string, unknown>)['deliveryChannelReadiness'],
    ).toBeUndefined()
  })

  it('instance_manager 不能管理非成员的目标 org auth policy', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_manager',
      activeOrgId: 'org_admin',
    })
    const org = {
      id: 'org_target',
      tenant_id: 't_1',
      status: 'active',
      private_metadata: {
        hostedAuth: { emailOtp: { enabled: true, allowLogin: true, allowUserCreation: false } },
        socialProviders: {},
      },
    }
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_manager')],
      organizations: [
        { id: 'org_admin', tenant_id: 't_1', status: 'active', private_metadata: {} },
        org,
      ],
      memberships: [],
      manager_assignments: [
        {
          id: 'mgr_1',
          tenant_id: 'admin_org',
          user_id: 'user_manager',
          manager_role: 'instance_manager',
          scope_type: 'instance',
          scope_id: null,
        },
      ],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    const app = buildApp(registerOrganizationsRoutes)

    const getRes = await app.request(
      'https://acme.xid.dev/v1/organizations/org_target/auth-policy',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )

    expect(getRes.status).toBe(403)

    const patchRes = await app.request(
      'https://acme.xid.dev/v1/organizations/org_target/auth-policy',
      {
        method: 'PATCH',
        headers: { Cookie: `${cookieName}=${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostedAuth: {
            emailOtp: { enabled: true, allowLogin: true, allowUserCreation: true },
          },
        }),
      },
      env,
    )

    expect(patchRes.status).toBe(403)
  })

  describe('org auth-policy session/token 覆盖', () => {
    async function adminEnv(tables: TableSet): Promise<{
      env: Env
      cookieName: string
      token: string
    }> {
      const {
        token,
        cookieName,
        row: session,
      } = await makeSessionRow({
        tenantId: 't_1',
        userId: 'user_admin',
        activeOrgId: 'org_1',
      })
      const db = makeFakeD1({
        sessions: [session],
        users: [activeUserRow('user_admin')],
        organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active', private_metadata: {} }],
        memberships: [
          {
            id: 'mem_admin',
            tenant_id: 't_1',
            org_id: 'org_1',
            user_id: 'user_admin',
            role: 'admin',
            status: 'active',
          },
        ],
        ...tables,
      })
      const env = asUnknown<Env>({
        DB: db,
        SESSION_REVOCATION: makeFakeSessionNs([]),
        CACHE: makeFakeKv(),
        WEBHOOK_QUEUE: makeFakeQueue(),
      })
      return { env, cookieName, token }
    }

    function patchAuthPolicy(
      app: Hono<XidHonoEnv>,
      env: Env,
      cookie: { name: string; value: string },
      options: { body: Record<string, unknown>; orgId?: string },
    ): Promise<Response> {
      const orgId = options.orgId ?? 'org_1'
      return Promise.resolve(
        app.request(
          `https://acme.xid.dev/v1/organizations/${orgId}/auth-policy`,
          {
            method: 'PATCH',
            headers: {
              Cookie: `${cookie.name}=${cookie.value}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(options.body),
          },
          env,
        ),
      )
    }

    it('GET 返回 org 覆盖值;无 org_policies 行时字段为 null', async () => {
      const { env, cookieName, token } = await adminEnv({
        org_policies: [
          {
            id: 'pol_1',
            tenant_id: 't_1',
            org_id: 'org_1',
            session_idle_timeout_min: 60,
            session_absolute_timeout_days: 14,
            token_policy: '{"access_token_ttl_sec":300,"refresh_idle_timeout_days":15}',
          },
        ],
      })
      const app = buildApp(registerOrganizationsRoutes)

      const res = await app.request(
        'https://acme.xid.dev/v1/organizations/org_1/auth-policy',
        { headers: { Cookie: `${cookieName}=${token}` } },
        env,
      )

      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        sessionPolicy: Record<string, unknown>
        tokenPolicy: Record<string, unknown>
      }
      expect(body.sessionPolicy).toEqual({ idleTimeoutMin: 60, absoluteTimeoutDays: 14 })
      expect(body.tokenPolicy).toEqual({
        accessTokenTtlSec: 300,
        sessionTokenTtlSec: null,
        refreshIdleTimeoutDays: 15,
        refreshAbsoluteTimeoutDays: null,
      })
    })

    it('PATCH sessionPolicy 无行时 insert 且 GET 可读回', async () => {
      const orgPolicies: Record<string, unknown>[] = []
      const { env, cookieName, token } = await adminEnv({ org_policies: orgPolicies })
      const app = buildApp(registerOrganizationsRoutes)

      const res = await patchAuthPolicy(
        app,
        env,
        { name: cookieName, value: token },
        { body: { sessionPolicy: { idleTimeoutMin: 120, absoluteTimeoutDays: 7 } } },
      )

      expect(res.status).toBe(200)
      expect(orgPolicies).toHaveLength(1)
      expect(orgPolicies[0]).toMatchObject({
        tenant_id: 't_1',
        org_id: 'org_1',
        session_idle_timeout_min: 120,
        session_absolute_timeout_days: 7,
      })

      const getRes = await app.request(
        'https://acme.xid.dev/v1/organizations/org_1/auth-policy',
        { headers: { Cookie: `${cookieName}=${token}` } },
        env,
      )
      const getBody = (await getRes.json()) as { sessionPolicy: Record<string, unknown> }
      expect(getBody.sessionPolicy).toEqual({ idleTimeoutMin: 120, absoluteTimeoutDays: 7 })
    })

    it('PATCH sessionPolicy 有行时 update;显式 null 清除覆盖回退 instance', async () => {
      const orgPolicies: Record<string, unknown>[] = [
        {
          id: 'pol_1',
          tenant_id: 't_1',
          org_id: 'org_1',
          session_idle_timeout_min: 60,
          session_absolute_timeout_days: 14,
        },
      ]
      const { env, cookieName, token } = await adminEnv({ org_policies: orgPolicies })
      const app = buildApp(registerOrganizationsRoutes)

      const res = await patchAuthPolicy(
        app,
        env,
        { name: cookieName, value: token },
        { body: { sessionPolicy: { idleTimeoutMin: null } } },
      )

      expect(res.status).toBe(200)
      const body = (await res.json()) as { sessionPolicy: Record<string, unknown> }
      expect(body.sessionPolicy).toEqual({ idleTimeoutMin: null, absoluteTimeoutDays: 14 })
      expect(orgPolicies[0]?.['session_idle_timeout_min']).toBeNull()
    })

    it('PATCH tokenPolicy 合并已有 JSON;显式 null 删键', async () => {
      const orgPolicies: Record<string, unknown>[] = [
        {
          id: 'pol_1',
          tenant_id: 't_1',
          org_id: 'org_1',
          token_policy: '{"access_token_ttl_sec":600,"refresh_absolute_timeout_days":14}',
        },
      ]
      const { env, cookieName, token } = await adminEnv({ org_policies: orgPolicies })
      const app = buildApp(registerOrganizationsRoutes)

      const res = await patchAuthPolicy(
        app,
        env,
        { name: cookieName, value: token },
        { body: { tokenPolicy: { accessTokenTtlSec: null, refreshIdleTimeoutDays: 15 } } },
      )

      expect(res.status).toBe(200)
      const body = (await res.json()) as { tokenPolicy: Record<string, unknown> }
      expect(body.tokenPolicy).toEqual({
        accessTokenTtlSec: null,
        sessionTokenTtlSec: null,
        refreshIdleTimeoutDays: 15,
        refreshAbsoluteTimeoutDays: 14,
      })
      expect(JSON.parse(String(orgPolicies[0]?.['token_policy']))).toEqual({
        refresh_idle_timeout_days: 15,
        refresh_absolute_timeout_days: 14,
      })
    })

    it('PATCH sessionPolicy 越界 -> 422 且不落库', async () => {
      const orgPolicies: Record<string, unknown>[] = []
      const { env, cookieName, token } = await adminEnv({ org_policies: orgPolicies })
      const app = buildApp(registerOrganizationsRoutes)

      const res = await patchAuthPolicy(
        app,
        env,
        { name: cookieName, value: token },
        { body: { sessionPolicy: { idleTimeoutMin: 2 } } },
      )

      expect(res.status).toBe(422)
      const body = (await res.json()) as Record<string, unknown>
      expect(body['code']).toBe('validation_failed')
      expect(orgPolicies).toHaveLength(0)
    })

    it('PATCH tokenPolicy 越界 -> 422 且不落库', async () => {
      const orgPolicies: Record<string, unknown>[] = []
      const { env, cookieName, token } = await adminEnv({ org_policies: orgPolicies })
      const app = buildApp(registerOrganizationsRoutes)

      const res = await patchAuthPolicy(
        app,
        env,
        { name: cookieName, value: token },
        { body: { tokenPolicy: { accessTokenTtlSec: 30 } } },
      )

      expect(res.status).toBe(422)
      const body = (await res.json()) as Record<string, unknown>
      expect(body['code']).toBe('validation_failed')
      expect(orgPolicies).toHaveLength(0)
    })

    it('越权:非成员 instance_manager PATCH sessionPolicy -> 403 且不建行', async () => {
      const {
        token,
        cookieName,
        row: session,
      } = await makeSessionRow({
        tenantId: 't_1',
        userId: 'user_manager',
        activeOrgId: 'org_admin',
      })
      const orgPolicies: Record<string, unknown>[] = []
      const db = makeFakeD1({
        sessions: [session],
        users: [activeUserRow('user_manager')],
        organizations: [
          { id: 'org_admin', tenant_id: 't_1', status: 'active', private_metadata: {} },
          { id: 'org_target', tenant_id: 't_1', status: 'active', private_metadata: {} },
        ],
        memberships: [],
        manager_assignments: [
          {
            id: 'mgr_1',
            tenant_id: 'admin_org',
            user_id: 'user_manager',
            manager_role: 'instance_manager',
            scope_type: 'instance',
            scope_id: null,
          },
        ],
        org_policies: orgPolicies,
      })
      const env = asUnknown<Env>({
        DB: db,
        SESSION_REVOCATION: makeFakeSessionNs([]),
        CACHE: makeFakeKv(),
        WEBHOOK_QUEUE: makeFakeQueue(),
      })
      const app = buildApp(registerOrganizationsRoutes)

      const res = await patchAuthPolicy(
        app,
        env,
        { name: cookieName, value: token },
        { body: { sessionPolicy: { idleTimeoutMin: 60 } }, orgId: 'org_target' },
      )

      expect(res.status).toBe(403)
      expect(orgPolicies).toHaveLength(0)
    })
  })

  it('admin 更新 auth policy 不擦除已有 social providers', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_1',
    })
    const org = {
      id: 'org_1',
      tenant_id: 't_1',
      status: 'active',
      private_metadata: {
        hostedAuth: { password: { enabled: false, allowLogin: false, allowUserCreation: false } },
        socialProviders: {
          google: {
            authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenEndpoint: 'https://oauth2.googleapis.com/token',
            clientId: 'google-client',
            clientSecretRef: 'secret:google',
            scopes: ['openid', 'email'],
            usesPkce: true,
            enabled: true,
            allowLogin: true,
            allowUserCreation: false,
            requireVerifiedEmail: true,
            allowedEmailDomains: [],
            blockedEmailDomains: [],
          },
        },
      },
    }
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_admin')],
      organizations: [org],
      memberships: [
        {
          id: 'mem_admin',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_admin',
          role: 'admin',
          status: 'active',
        },
      ],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    const app = buildApp(registerOrganizationsRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/auth-policy',
      {
        method: 'PATCH',
        headers: { Cookie: `${cookieName}=${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostedAuth: {
            password: { enabled: true, allowLogin: true, allowUserCreation: false },
          },
          socialProviders: {
            google: {
              allowUserCreation: true,
              clientSecretRef: 'CHANGED_SECRET',
              credentialsReady: true,
            },
          },
        }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      hostedAuth: { password: Record<string, unknown> }
      socialProviders?: unknown
    }
    expect(body.hostedAuth.password).toEqual({
      enabled: true,
      allowLogin: true,
      allowUserCreation: false,
      requireEmailVerification: true,
    })
    expect(body.socialProviders).toBeUndefined()

    const getRes = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/social-providers',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )
    expect(getRes.status).toBe(200)
    const getBody = (await getRes.json()) as {
      socialProviders: Record<string, Record<string, unknown>>
    }
    expect(getBody.socialProviders.google?.['hasClientSecret']).toBe(true)
    expect(getBody.socialProviders.google?.['credentialsReady']).toBe(false)
    expect(getBody.socialProviders.google?.['allowUserCreation']).toBe(false)
    expect(getBody.socialProviders.google?.['clientSecretRef']).toBe('secret:google')
  })

  it('admin 可新增 social provider 配置且 secret ref 不回显', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_1',
    })
    const org = {
      id: 'org_1',
      tenant_id: 't_1',
      status: 'active',
      private_metadata: {
        hostedAuth: {},
        socialProviders: {},
      },
    }
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_admin')],
      organizations: [org],
      memberships: [
        {
          id: 'mem_admin',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_admin',
          role: 'admin',
          status: 'active',
        },
      ],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    const app = buildApp(registerOrganizationsRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/social-providers',
      {
        method: 'PATCH',
        headers: { Cookie: `${cookieName}=${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          socialProviders: {
            microsoft: {
              authorizationEndpoint:
                'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
              tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
              clientId: 'microsoft-client',
              clientSecretRef: 'MICROSOFT_CLIENT_SECRET',
              userInfoEndpoint: 'https://graph.microsoft.com/oidc/userinfo',
              issuer: 'https://login.microsoftonline.com/common/v2.0',
              jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
              redirectUris: ['https://app.xid.dev/auth/microsoft/callback'],
              scopes: ['openid', 'email', 'profile'],
              usesPkce: true,
              enabled: true,
              allowLogin: true,
              allowUserCreation: true,
              requireVerifiedEmail: true,
              allowedEmailDomains: ['example.com'],
              blockedEmailDomains: ['blocked.example'],
            },
          },
        }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      socialProviders: Record<string, Record<string, unknown>>
    }
    expect(body.socialProviders.microsoft).toMatchObject({
      authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      clientId: 'microsoft-client',
      userInfoEndpoint: 'https://graph.microsoft.com/oidc/userinfo',
      usesPkce: true,
      enabled: true,
      allowLogin: true,
      allowUserCreation: true,
      requireVerifiedEmail: true,
      clientSecretRef: 'MICROSOFT_CLIENT_SECRET',
      hasClientSecret: true,
      credentialsReady: false,
      allowedEmailDomains: ['example.com'],
      blockedEmailDomains: ['blocked.example'],
    })
  })

  it('admin 删除 social provider 后不再保留旧 provider', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_1',
    })
    const org = {
      id: 'org_1',
      tenant_id: 't_1',
      status: 'active',
      private_metadata: {
        hostedAuth: {},
        socialProviders: {
          google: {
            authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenEndpoint: 'https://oauth2.googleapis.com/token',
            clientId: 'google-client',
            clientSecretRef: 'secret:google',
            scopes: ['openid', 'email'],
            usesPkce: true,
            enabled: true,
            allowLogin: true,
            allowUserCreation: false,
            requireVerifiedEmail: true,
            allowedEmailDomains: [],
            blockedEmailDomains: [],
          },
          github: {
            authorizationEndpoint: 'https://github.com/login/oauth/authorize',
            tokenEndpoint: 'https://github.com/login/oauth/access_token',
            clientId: 'github-client',
            clientSecretRef: 'secret:github',
            scopes: ['user:email'],
            usesPkce: true,
            enabled: true,
            allowLogin: true,
            allowUserCreation: true,
            requireVerifiedEmail: true,
            allowedEmailDomains: [],
            blockedEmailDomains: [],
          },
        },
      },
    }
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_admin')],
      organizations: [org],
      memberships: [
        {
          id: 'mem_admin',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_admin',
          role: 'admin',
          status: 'active',
        },
      ],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    const app = buildApp(registerOrganizationsRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/social-providers',
      {
        method: 'PATCH',
        headers: { Cookie: `${cookieName}=${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          socialProviders: {
            github: { enabled: false },
          },
        }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      socialProviders: Record<string, Record<string, unknown>>
    }
    expect(Object.keys(body.socialProviders)).toEqual(['github'])
    expect(body.socialProviders.google).toBeUndefined()
    expect(body.socialProviders.github?.['hasClientSecret']).toBe(true)
    expect(body.socialProviders.github?.['credentialsReady']).toBe(false)
    expect(body.socialProviders.github?.['enabled']).toBe(false)
  })

  it('admin 可清空 social provider 可选字段和列表字段', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_1',
    })
    const org = {
      id: 'org_1',
      tenant_id: 't_1',
      status: 'active',
      private_metadata: {
        hostedAuth: {},
        socialProviders: {
          google: {
            authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenEndpoint: 'https://oauth2.googleapis.com/token',
            clientId: 'google-client',
            clientSecretRef: 'secret:google',
            userInfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
            issuer: 'https://accounts.google.com',
            jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
            redirectUris: ['https://app.xid.dev/auth/google/callback'],
            scopes: ['openid', 'email'],
            usesPkce: true,
            enabled: true,
            allowLogin: true,
            allowUserCreation: true,
            requireVerifiedEmail: true,
            allowedEmailDomains: ['example.com'],
            blockedEmailDomains: ['blocked.example'],
          },
        },
      },
    }
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_admin')],
      organizations: [org],
      memberships: [
        {
          id: 'mem_admin',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_admin',
          role: 'admin',
          status: 'active',
        },
      ],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    const app = buildApp(registerOrganizationsRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/social-providers',
      {
        method: 'PATCH',
        headers: { Cookie: `${cookieName}=${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          socialProviders: {
            google: {
              clientSecretRef: '',
              userInfoEndpoint: '',
              issuer: '',
              jwksUri: '',
              redirectUris: [],
              scopes: [],
              allowedEmailDomains: [],
              blockedEmailDomains: [],
            },
          },
        }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      socialProviders: Record<string, Record<string, unknown>>
    }
    expect(body.socialProviders.google).toMatchObject({
      clientId: 'google-client',
      hasClientSecret: false,
      credentialsReady: false,
      scopes: [],
      redirectUris: [],
      allowedEmailDomains: [],
      blockedEmailDomains: [],
    })
    expect(body.socialProviders.google?.['userInfoEndpoint']).toBeUndefined()
    expect(body.socialProviders.google?.['issuer']).toBeUndefined()
    expect(body.socialProviders.google?.['jwksUri']).toBeUndefined()
    expect(body.socialProviders.google?.['clientSecretRef']).toBeUndefined()
  })

  it('admin 可轮换 SCIM directory token', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_1',
    })
    const directory = {
      id: 'dir_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      provider: 'okta',
      status: 'active',
      sync_status: 'idle',
      scim_token_hash: 'old_hash',
      scim_token_hash_prev: null,
      scim_token_prev_expires: null,
    }
    const db = makeFakeD1({
      sessions: [session],
      users: [activeUserRow('user_admin')],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
      memberships: [
        {
          id: 'mem_admin',
          tenant_id: 't_1',
          org_id: 'org_1',
          user_id: 'user_admin',
          role: 'admin',
          status: 'active',
        },
      ],
      directories: [directory],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    const app = buildApp(registerOrganizationsRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/directories/dir_1/rotate-token',
      { method: 'POST', headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body['scimToken']).toBe('string')
    expect(directory['scim_token_hash_prev']).toBe('old_hash')
    expect(directory['scim_token_hash']).not.toBe('old_hash')
  })

  it('admin 可读取 members Page,DELETE 后默认列表过滤 inactive', async () => {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({
      tenantId: 't_1',
      userId: 'user_admin',
      activeOrgId: 'org_1',
    })
    const adminMembership = {
      id: 'mem_admin',
      tenant_id: 't_1',
      org_id: 'org_1',
      user_id: 'user_admin',
      role: 'admin',
      status: 'active',
      joined_at: Date.now(),
      created_at: Date.now(),
    }
    const memberMembership = {
      id: 'mem_target',
      tenant_id: 't_1',
      org_id: 'org_1',
      user_id: 'user_target',
      role: 'member',
      status: 'active',
      joined_at: Date.now(),
      created_at: Date.now(),
    }
    const db = makeFakeD1({
      sessions: [session],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
      memberships: [adminMembership, memberMembership],
      users: [
        {
          id: 'user_admin',
          tenant_id: 't_1',
          status: 'active',
          deleted_at: null,
          primary_email_id: 'email_admin',
        },
        {
          id: 'user_target',
          tenant_id: 't_1',
          status: 'active',
          deleted_at: null,
          primary_email_id: 'email_target',
        },
      ],
      user_emails: [
        { id: 'email_admin', tenant_id: 't_1', user_id: 'user_admin', email: 'admin@example.com' },
        {
          id: 'email_target',
          tenant_id: 't_1',
          user_id: 'user_target',
          email: 'target@example.com',
        },
      ],
    })
    const env = asUnknown<Env>({
      DB: db,
      SESSION_REVOCATION: makeFakeSessionNs([]),
      CACHE: makeFakeKv(),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    const app = buildApp(registerOrganizationsRoutes)

    const list = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/members',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )
    expect(list.status).toBe(200)
    const before = (await list.json()) as {
      data: Record<string, unknown>[]
      nextCursor: string | null
      total: number
    }
    expect(before.data.map((row) => row['id']).sort()).toEqual(['mem_admin', 'mem_target'])
    expect(before.nextCursor).toBeNull()
    expect(before.total).toBe(2)

    const del = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/members/mem_target',
      { method: 'DELETE', headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )
    expect(del.status).toBe(204)
    expect(memberMembership['status']).toBe('inactive')

    const afterList = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/members',
      { headers: { Cookie: `${cookieName}=${token}` } },
      env,
    )
    const after = (await afterList.json()) as { data: Record<string, unknown>[]; total: number }
    expect(after.data.map((row) => row['id'])).toEqual(['mem_admin'])
    expect(after.total).toBe(1)
  })
})

describe('v1 sessions 撤销:命中 per-user SessionDO(idFromName=session:{userId})', () => {
  it('普通列表和详情过滤 revoked sessions', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({
      api_keys: [apiKey],
      sessions: [
        {
          id: 's_active',
          tenant_id: 't_1',
          user_id: 'u_42',
          status: 'active',
          refresh_token_hash: 'secret_active',
        },
        {
          id: 's_revoked',
          tenant_id: 't_1',
          user_id: 'u_42',
          status: 'revoked',
          refresh_token_hash: 'secret_revoked',
        },
      ],
    })
    const env = asUnknown<Env>({ DB: db, SESSION_REVOCATION: makeFakeSessionNs([]) })
    const app = buildApp(registerSessionsRoutes)

    const list = await app.request(
      'https://acme.xid.dev/v1/sessions?user_id=u_42',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(list.status).toBe(200)
    const body = (await list.json()) as { data: Record<string, unknown>[] }
    expect(body.data.map((row) => row['id'])).toEqual(['s_active'])
    expect(body.data[0]?.['refresh_token_hash']).toBeUndefined()

    const revokedGet = await app.request(
      'https://acme.xid.dev/v1/sessions/s_revoked',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(revokedGet.status).toBe(404)
  })

  it('revoke 单条 -> idFromName 用 session:{userId}(与签发同一实例)', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({
      api_keys: [apiKey],
      sessions: [{ id: 's_1', tenant_id: 't_1', user_id: 'u_42', status: 'active' }],
    })
    const names: string[] = []
    const env = asUnknown<Env>({ DB: db, SESSION_REVOCATION: makeFakeSessionNs(names) })
    const app = buildApp(registerSessionsRoutes)
    const res = await app.request(
      'https://acme.xid.dev/v1/sessions/s_1/revoke',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    // 关键:必须用 session:{userId},否则写错 DO 实例,强制下线无效。
    expect(names).toContain('session:u_42')
    expect(names).not.toContain('t_1:u_42')

    const getAfterRevoke = await app.request(
      'https://acme.xid.dev/v1/sessions/s_1',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(getAfterRevoke.status).toBe(404)
  })

  it('revoke_all -> idFromName 用 session:{userId}', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({
      api_keys: [apiKey],
      users: [{ id: 'u_42', tenant_id: 't_1', status: 'active', deleted_at: null }],
      sessions: [{ id: 's_1', tenant_id: 't_1', user_id: 'u_42', status: 'active' }],
    })
    const names: string[] = []
    const env = asUnknown<Env>({ DB: db, SESSION_REVOCATION: makeFakeSessionNs(names) })
    const app = buildApp(registerSessionsRoutes)
    const res = await app.request(
      'https://acme.xid.dev/v1/sessions/users/u_42/revoke_all',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    expect(names).toContain('session:u_42')
    expect(names).not.toContain('t_1:u_42')
  })

  it('revoke_all 拒绝 deleted_at 非空的 user 且不调用 SessionDO', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({
      api_keys: [apiKey],
      users: [{ id: 'u_deleted', tenant_id: 't_1', status: 'active', deleted_at: Date.now() }],
      sessions: [{ id: 's_1', tenant_id: 't_1', user_id: 'u_deleted', status: 'active' }],
    })
    const names: string[] = []
    const env = asUnknown<Env>({ DB: db, SESSION_REVOCATION: makeFakeSessionNs(names) })
    const app = buildApp(registerSessionsRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/sessions/users/u_deleted/revoke_all',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )

    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('not_found')
    expect(names).toEqual([])
  })
})

// 对抗审查修复(2026-07):org 行裸返收窄为 toResponse 白名单;slug 实例级唯一;self-service 门控;domains 409。
describe('v1 organizations 响应白名单与 slug 实例级唯一', () => {
  const ORG_ROW = {
    id: 'org_1',
    tenant_id: 't_1',
    instance_id: 't_1',
    slug: 'acme',
    name: 'Acme',
    logo_url: null,
    public_metadata: {},
    // private_metadata 含策略与 secret ref,断言不裸出(走 auth-policy 等显式端点)。
    private_metadata: { hostedAuth: {}, socialProviders: { github: { clientSecretRef: 'SEC' } } },
    seat_limit: 50,
    seat_used: 3,
    enrollment_mode: 'invite_required',
    allow_org_self_service: 1,
    status: 'active',
    deleted_at: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  }

  it('GET list/detail -> 无 privateMetadata 裸出,无内部列', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({ api_keys: [apiKey], organizations: [ORG_ROW] })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerOrganizationsRoutes)

    const list = await app.request(
      'https://acme.xid.dev/v1/organizations',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(list.status).toBe(200)
    const page = (await list.json()) as { data: Record<string, unknown>[] }
    const item = page.data[0]!
    expect(item['slug']).toBe('acme')
    expect(item).not.toHaveProperty('private_metadata')
    expect(item).not.toHaveProperty('privateMetadata')
    expect(item).not.toHaveProperty('tenant_id')
    expect(item).not.toHaveProperty('instance_id')
    expect(item).not.toHaveProperty('deleted_at')

    const detail = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(detail.status).toBe(200)
    const org = (await detail.json()) as Record<string, unknown>
    expect(org['slug']).toBe('acme')
    expect(org).not.toHaveProperty('private_metadata')
    expect(org).not.toHaveProperty('privateMetadata')
    expect(org).not.toHaveProperty('tenant_id')
  })

  it('PATCH slug 与他租户 org 冲突 -> 409 already_exists', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [
        { id: 'org_1', tenant_id: 't_1', instance_id: 't_1', slug: 'own-slug', status: 'active' },
        // 他租户 org 占用 victim-slug:实例级解析同域,占用即冲突(防 suspend 后子域接管)。
        {
          id: 'org_victim',
          tenant_id: 't_other',
          instance_id: 't_1',
          slug: 'victim-slug',
          status: 'active',
        },
      ],
    })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerOrganizationsRoutes)
    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'victim-slug' }),
      },
      env,
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('already_exists')
  })

  it('POST slug 与他租户 org 冲突 -> 409 already_exists', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [
        {
          id: 'org_victim',
          tenant_id: 't_other',
          instance_id: 't_1',
          slug: 'victim-slug',
          status: 'active',
        },
      ],
    })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerOrganizationsRoutes)
    const res = await app.request(
      'https://acme.xid.dev/v1/organizations',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'victim-slug', name: 'X' }),
      },
      env,
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('already_exists')
  })

  it('PATCH slug 改为自身当前 slug -> 200(排除自身不误判冲突)', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [
        { id: 'org_1', tenant_id: 't_1', instance_id: 't_1', slug: 'own-slug', status: 'active' },
      ],
    })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerOrganizationsRoutes)
    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'own-slug' }),
      },
      env,
    )
    expect(res.status).toBe(200)
  })

  it('POST/PATCH 保留字 slug(admin/www 等)-> 422', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [
        { id: 'org_1', tenant_id: 't_1', instance_id: 't_1', slug: 'own-slug', status: 'active' },
      ],
    })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerOrganizationsRoutes)

    const post = await app.request(
      'https://acme.xid.dev/v1/organizations',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'admin', name: 'X' }),
      },
      env,
    )
    expect(post.status).toBe(422)

    const patch = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'www' }),
      },
      env,
    )
    expect(patch.status).toBe(422)
  })

  it('POST create -> instance_id 取 TenantContext.instanceId 写入', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const orgs: Record<string, unknown>[] = []
    const db = makeFakeD1({ api_keys: [apiKey], organizations: orgs })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerOrganizationsRoutes, { ...TENANT, instanceId: 'inst_1' })
    const res = await app.request(
      'https://acme.xid.dev/v1/organizations',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'new-org', name: 'New' }),
      },
      env,
    )
    expect(res.status).toBe(201)
    expect(orgs).toHaveLength(1)
    expect(orgs[0]!['instance_id']).toBe('inst_1')
    expect(orgs[0]!['tenant_id']).toBe('t_1')
  })
})

// logo 上传:R2 落盘后 logoUrl 走 issuer /storage 路径(worker 自 serve,见 storage.ts),
// 不再硬编码 storage.idx.dev。
describe('v1 organizations logo 上传', () => {
  it('PUT logo -> logo_url 为 {issuer}/storage/logos/{tenantId}/{orgId}/{uuid}', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const org = {
      id: 'org_1',
      tenant_id: 't_1',
      instance_id: 't_1',
      slug: 'acme',
      name: 'Acme',
      logo_url: null,
      public_metadata: {},
      private_metadata: {},
      enrollment_mode: 'invite_required',
      seat_limit: null,
      seat_used: 0,
      allow_org_self_service: 1,
      status: 'active',
      deleted_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeFakeD1({ api_keys: [apiKey], organizations: [org] })
    const stored = new Map<string, { contentType?: string }>()
    const env = asUnknown<Env>({
      DB: db,
      WEBHOOK_QUEUE: makeFakeQueue(),
      STORAGE: {
        put: async (
          key: string,
          _body: unknown,
          opts?: { httpMetadata?: { contentType?: string } },
        ) => {
          stored.set(key, { contentType: opts?.httpMetadata?.contentType })
        },
      },
    })
    const app = buildApp(registerOrganizationsRoutes)

    const form = new FormData()
    form.set('file', new File(['fake-png-bytes'], 'logo.png', { type: 'image/png' }))
    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/logo',
      { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: form },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { logo_url: string; organization: { logo_url: string } }
    expect(body.logo_url).toMatch(
      /^https:\/\/acme\.xid\.dev\/storage\/logos\/t_1\/org_1\/[0-9a-f-]{36}$/u,
    )
    expect(body.logo_url).not.toContain('storage.idx.dev')
    expect(body.organization.logo_url).toBe(body.logo_url)
    expect(org['logo_url']).toBe(body.logo_url)

    const entries = [...stored.entries()]
    expect(entries).toHaveLength(1)
    expect(entries[0]![0]).toMatch(/^logos\/t_1\/org_1\//u)
    expect(entries[0]![1].contentType).toBe('image/png')
  })
})

describe('v1 organizations allow_org_self_service 门控', () => {
  const LOCKED_ORG = {
    id: 'org_1',
    tenant_id: 't_1',
    status: 'active',
    private_metadata: {},
    allow_org_self_service: 0,
  }

  async function adminCookieEnv(opts: { instanceManager?: boolean } = {}) {
    const {
      token,
      cookieName,
      row: session,
    } = await makeSessionRow({ tenantId: 't_1', userId: 'user_admin', activeOrgId: 'org_1' })
    const env = asUnknown<Env>({
      DB: makeFakeD1({
        sessions: [session],
        users: [activeUserRow('user_admin')],
        organizations: [LOCKED_ORG],
        memberships: [
          {
            id: 'mem_1',
            tenant_id: 't_1',
            org_id: 'org_1',
            user_id: 'user_admin',
            role: 'admin',
            status: 'active',
          },
        ],
        manager_assignments: opts.instanceManager
          ? [
              {
                id: 'mgr_1',
                tenant_id: 't_1',
                user_id: 'user_admin',
                manager_role: 'instance_manager',
                scope_type: 'instance',
                scope_id: null,
              },
            ]
          : [],
      }),
      SESSION_REVOCATION: makeFakeSessionNs([]),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    return { env, cookieName, token }
  }

  it('flag=false 时 org admin(cookie)PATCH auth-policy -> 403', async () => {
    const { env, cookieName, token } = await adminCookieEnv()
    const app = buildApp(registerOrganizationsRoutes)
    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/auth-policy',
      {
        method: 'PATCH',
        headers: { Cookie: `${cookieName}=${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostedAuth: {} }),
      },
      env,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('forbidden')
  })

  it('flag=false 时 org admin(cookie)POST sso-connections -> 403', async () => {
    const { env, cookieName, token } = await adminCookieEnv()
    const app = buildApp(registerOrganizationsRoutes)
    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/sso-connections',
      {
        method: 'POST',
        headers: { Cookie: `${cookieName}=${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol: 'oidc' }),
      },
      env,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('forbidden')
  })

  it('flag=false 时 sk 路径不受影响 -> 200', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const env = asUnknown<Env>({
      DB: makeFakeD1({ api_keys: [apiKey], organizations: [LOCKED_ORG] }),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    const app = buildApp(registerOrganizationsRoutes)
    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/auth-policy',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostedAuth: {} }),
      },
      env,
    )
    expect(res.status).toBe(200)
  })

  it('flag=false 时 instance_manager(cookie)不受影响 -> 200', async () => {
    const { env, cookieName, token } = await adminCookieEnv({ instanceManager: true })
    const app = buildApp(registerOrganizationsRoutes)
    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/auth-policy',
      {
        method: 'PATCH',
        headers: { Cookie: `${cookieName}=${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostedAuth: {} }),
      },
      env,
    )
    expect(res.status).toBe(200)
  })
})

describe('v1 organization domains 唯一冲突映射', () => {
  // insert 时抛 UNIQUE 冲突的 D1 包装:模拟跨租户已注册同域名的约束命中(fake D1 不实现约束)。
  function makeUniqueFailingD1(tables: TableSet): D1Database {
    const base = makeFakeD1(tables)
    const fail = async (): Promise<never> => {
      throw new Error('UNIQUE constraint failed: organization_domains.domain')
    }
    return asUnknown<D1Database>({
      prepare: (sql: string) => {
        if (/^insert\s+into\s+"?organization_domains"?/i.test(sql.trim())) {
          const stmt = {
            bind: () => stmt,
            raw: fail,
            all: fail,
            run: fail,
            first: fail,
          }
          return stmt
        }
        return base.prepare(sql)
      },
      batch: async () => [],
    })
  }

  it('POST 跨租户重复域名撞 UNIQUE -> 409 already_exists(不外溢 500)', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const env = asUnknown<Env>({
      DB: makeUniqueFailingD1({
        api_keys: [apiKey],
        organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
        organization_domains: [],
      }),
      WEBHOOK_QUEUE: makeFakeQueue(),
    })
    const app = buildApp(registerOrganizationsRoutes)
    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/domains',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'taken.example.com' }),
      },
      env,
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('already_exists')
  })
})

describe('v1 users 响应白名单(内部字段不外泄)', () => {
  const INTERNAL_KEYS = [
    'tenantId',
    'tenant_id',
    'primaryEmailId',
    'primary_email_id',
    'primaryPhoneId',
    'primary_phone_id',
    'isNewUser',
    'is_new_user',
    'profileCompletionStatus',
    'profile_completion_status',
    'failedLoginCount',
    'failed_login_count',
    'mergedIntoUserId',
    'merged_into_user_id',
    'provisionedBy',
    'provisioned_by',
    'deletedAt',
    'deleted_at',
  ]

  function fullUserRow(): Record<string, unknown> {
    return {
      id: 'user_1',
      tenant_id: 't_1',
      username: 'alice',
      external_id: 'ext_alice',
      primary_email_id: 'uem_1',
      primary_phone_id: 'uph_1',
      first_name: 'Alice',
      last_name: 'Lee',
      display_name: 'Alice Lee',
      avatar_url: 'https://img.example/a.png',
      locale: 'en',
      timezone: 'UTC',
      public_metadata: { tier: 'pro' },
      private_metadata: { note: 'n' },
      unsafe_metadata: { theme: 'dark' },
      custom_attributes: { dept: 'eng' },
      status: 'active',
      password_change_required: 0,
      is_new_user: 0,
      profile_completion_status: 'complete',
      lockout_until: null,
      failed_login_count: 7,
      last_login_at: Date.now(),
      merged_into_user_id: 'user_merged',
      provisioned_by: 'scim',
      deleted_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
  }

  function expectUserWhitelisted(body: Record<string, unknown>): void {
    for (const key of INTERNAL_KEYS) expect(body).not.toHaveProperty(key)
    expect(body['id']).toBe('user_1')
    expect(body['username']).toBe('alice')
    // 运维状态对 sk 可见:lockout/lastLogin 保留。
    expect(body).toHaveProperty('lockoutUntil')
    expect(body).toHaveProperty('lastLoginAt')
  }

  it('GET /v1/users/:id -> 白名单响应', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({ api_keys: [apiKey], users: [fullUserRow()] })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerUsersRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/users/user_1',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )

    expect(res.status).toBe(200)
    expectUserWhitelisted((await res.json()) as Record<string, unknown>)
  })

  it('GET /v1/users 列表 -> 每行白名单化', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({ api_keys: [apiKey], users: [fullUserRow()] })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerUsersRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/users',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )

    expect(res.status).toBe(200)
    const page = (await res.json()) as { data: Record<string, unknown>[] }
    expect(page.data).toHaveLength(1)
    expectUserWhitelisted(page.data[0]!)
  })

  it('POST /v1/users/:id/ban -> 白名单响应且 status=banned', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({ api_keys: [apiKey], users: [fullUserRow()] })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerUsersRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/users/user_1/ban',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expectUserWhitelisted(body)
    expect(body['status']).toBe('banned')
  })
})

describe('v1 memberships 响应白名单(内部字段不外泄)', () => {
  const INTERNAL_KEYS = [
    'tenantId',
    'tenant_id',
    'isManaged',
    'is_managed',
    'invitedByUserId',
    'invited_by_user_id',
  ]

  function membershipRow(): Record<string, unknown> {
    return {
      id: 'mem_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      user_id: 'user_1',
      role: 'admin',
      membership_type: 'member',
      status: 'active',
      is_managed: 1,
      invited_by_user_id: 'user_inviter',
      joined_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    }
  }

  function expectMembershipWhitelisted(body: Record<string, unknown>): void {
    for (const key of INTERNAL_KEYS) expect(body).not.toHaveProperty(key)
    expect(body['id']).toBe('mem_1')
    expect(body['orgId']).toBe('org_1')
    expect(body['userId']).toBe('user_1')
    expect(body['role']).toBe('admin')
  }

  it('GET /v1/organizations/:orgId/memberships/:id -> 白名单响应', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
      memberships: [membershipRow()],
    })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerMembershipsRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/memberships/mem_1',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )

    expect(res.status).toBe(200)
    expectMembershipWhitelisted((await res.json()) as Record<string, unknown>)
  })

  it('POST /v1/organizations/:orgId/memberships -> 白名单响应', async () => {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({
      api_keys: [apiKey],
      organizations: [{ id: 'org_1', tenant_id: 't_1', status: 'active' }],
      users: [activeUserRow('user_1')],
      memberships: [],
    })
    const env = asUnknown<Env>({ DB: db, WEBHOOK_QUEUE: makeFakeQueue() })
    const app = buildApp(registerMembershipsRoutes)

    const res = await app.request(
      'https://acme.xid.dev/v1/organizations/org_1/memberships',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'user_1', role: 'admin' }),
      },
      env,
    )

    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    for (const key of INTERNAL_KEYS) expect(body).not.toHaveProperty(key)
    expect(body['orgId']).toBe('org_1')
    expect(body['userId']).toBe('user_1')
    expect(body['role']).toBe('admin')
  })
})
