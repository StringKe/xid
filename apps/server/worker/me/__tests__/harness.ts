// me/* 端点测试共享 harness:最小 D1 fake(按表名 + 字符串绑定参数收窄)+ 测试 onError + tenant/session 注入。
// 思路对齐 v1/__tests__/isolation.test.ts:node 池无 Workers binding,fake 按 SQL 关键字路由表,
// 字符串绑定参数全部命中行内某列值才算匹配(模拟 WHERE tenant_id=? 收窄)。
// session 通过 c.set('session', ...) 注入(requireSession 优先读 c.get('session')),免去 cookie + DO 往返。

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { TenantContext } from '@xid-kit/types'
import { isAppError } from '../../lib/errors'
import type { SessionData, XidHonoEnv } from '../../lib/types'

export const TENANT: TenantContext = {
  tenantId: 't_1',
  issuer: 'https://acme.xid.dev',
  rpId: 'acme.xid.dev',
  signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
  policy: {},
}

export function asUnknown<T>(v: unknown): T {
  return v as T
}

// fake D1 表集:键为物理表名(snake_case),值为行数组(行键为 snake_case 列名)。
export type TableSet = Record<string, Record<string, unknown>[]>

const TABLE_KEYWORDS = [
  'user_emails',
  'user_phones',
  'user_identities',
  'passkey_credentials',
  'mfa_factors',
  'backup_codes',
  'trusted_devices',
  'password_history',
  'passwords',
  'manager_assignments',
  'memberships',
  'organizations',
  'projects',
  'role_permissions',
  'permissions',
  'user_grants',
  'roles',
  'sessions',
  'users',
] as const

function tableNameForSql(sql: string): string {
  const l = sql.toLowerCase()
  for (const name of TABLE_KEYWORDS) {
    if (l.includes(`"${name}"`) || l.includes(` ${name} `) || l.includes(`${name}\n`)) return name
  }
  for (const name of TABLE_KEYWORDS) {
    if (l.includes(name)) return name
  }
  return 'unknown'
}

function projectionColumns(sql: string): string[] {
  const ret = /returning\s+(.+)$/i.exec(sql)
  const head = ret ? ret[1] : /^select\s+(.+?)\s+from\s/i.exec(sql)?.[1]
  if (!head) return []
  return [...head.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? '')
}

function rowToRaw(sql: string, row: Record<string, unknown>): unknown[] {
  return projectionColumns(sql).map((c) => row[c] ?? null)
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

function parameterForPredicate(
  sql: string,
  params: unknown[],
  options: { column: string; operator: string; skippedParams: number },
): unknown | undefined {
  const { column, operator, skippedParams } = options
  const match = new RegExp(`"${column}"\\s*${operator}\\s*\\?`, 'i').exec(sql)
  if (match?.index === undefined) return undefined
  const placeholdersBefore = (sql.slice(0, match.index).match(/\?/g) ?? []).length
  return params[placeholdersBefore - skippedParams]
}

function timestampMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return null
}

export function makeFakeD1(tables: TableSet): D1Database {
  const get = (t: string): Record<string, unknown>[] => tables[t] ?? []

  const match = (
    sql: string,
    params: unknown[],
    opts: { skipParams?: number } = {},
  ): Record<string, unknown>[] => {
    const rows = get(tableNameForSql(sql))
    const lower = sql.toLowerCase()
    if (lower.startsWith('insert') || lower.startsWith('with')) {
      return rows.slice(-1).length ? rows.slice(-1) : [{ id: crypto.randomUUID() }]
    }
    if (lower.startsWith('delete')) return []
    const activeParams = opts.skipParams ? params.slice(opts.skipParams) : params
    const sp = activeParams.filter((v): v is string => typeof v === 'string')
    const filtered = rows.filter((r) => {
      if (requiresNull(sql, 'revoked_at') && r['revoked_at'] != null) return false
      if (requiresNull(sql, 'deleted_at') && r['deleted_at'] != null) return false
      if (sp.length > 0 && !sp.every((v) => Object.values(r).includes(v))) return false

      const usedParam = parameterForPredicate(sql, activeParams, {
        column: 'used',
        operator: '=',
        skippedParams: opts.skipParams ?? 0,
      })
      if (usedParam !== undefined) {
        const rowUsed = booleanValue(r['used'])
        const expectedUsed = booleanValue(usedParam)
        if (rowUsed !== null && expectedUsed !== null && rowUsed !== expectedUsed) return false
      }

      const expiresParam = parameterForPredicate(sql, activeParams, {
        column: 'expires_at',
        operator: '>',
        skippedParams: opts.skipParams ?? 0,
      })
      if (expiresParam !== undefined) {
        const rowExpiresAt = timestampMs(r['expires_at'])
        const expectedExpiresAt = timestampMs(expiresParam)
        if (
          rowExpiresAt !== null &&
          expectedExpiresAt !== null &&
          rowExpiresAt <= expectedExpiresAt
        ) {
          return false
        }
      }

      return true
    })
    return filtered
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

// per-user SessionDO namespace fake:记录 idFromName,fetch 默认返回 active=true。
// status 可调:用于验证 DO 故障时端点 fail closed(响应体不带否定信号,只有查 HTTP status 才会拒绝)。
export function makeFakeSessionNs(names: string[], status = 200): DurableObjectNamespace {
  const stub = {
    fetch: async () => new Response(JSON.stringify({ active: true }), { status }),
  }
  return asUnknown<DurableObjectNamespace>({
    idFromName: (n: string) => {
      names.push(n)
      return n
    },
    get: () => stub,
  })
}

export type BuildAppOptions = {
  register: (app: Hono<XidHonoEnv>) => void
  session: SessionData | null
  tenant?: TenantContext
}

// 测试 app:最小 onError(直读 AppError.code/httpStatus,避免触发 i18n lingui macro)+ 注入 tenant/session。
export function buildApp(opts: BuildAppOptions): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError((err, c) => {
    if (isAppError(err)) return c.json({ code: err.code, meta: err.meta }, err.httpStatus as 400)
    return c.json({ code: 'server_error' }, 500)
  })
  app.use('*', async (c: Context<XidHonoEnv>, next) => {
    c.set('tenant', opts.tenant ?? TENANT)
    c.set('session', opts.session)
    await next()
  })
  opts.register(app)
  return app
}

export function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  const now = new Date()
  return {
    sessionId: 's_current',
    userId: 'u_1',
    status: 'active',
    activeOrgId: null,
    authenticatedAt: now,
    lastActiveAt: now,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    rememberMe: false,
    isImpersonation: false,
    impersonatorUserId: null,
    acr: null,
    amr: null,
    aal: null,
    ...overrides,
  }
}
