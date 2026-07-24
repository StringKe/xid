// Management API v1 共享工具:认证守卫(sk_live_ Bearer)、cursor 分页。
// 见 api-sdk-conventions rule:/v1/ 前缀,cursor 分页(<=100/page),sk_live_ secret key 认证。
// tenant_id 从 TenantContext 取(不信任 body),见 tenant-isolation rule。

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, gt } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { Context } from 'hono'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { readSession } from '../lib/session'

// Management API 每页最大条数。
export const MAX_PAGE_SIZE = 100

// cursor 分页参数解析。返回 { limit, cursor } 供查询使用。
export function parsePagination(c: Context<XidHonoEnv>): { limit: number; cursor: string | null } {
  const rawLimit = Number(c.req.query('limit') ?? String(MAX_PAGE_SIZE))
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, isNaN(rawLimit) ? MAX_PAGE_SIZE : rawLimit))
  const cursor = c.req.query('cursor') ?? null
  return { limit, cursor }
}

// cursor 分页响应包装。data 为已分页的结果,next_cursor 为 null 时表示最后一页。
export type PaginatedResponse<T> = {
  data: T[]
  next_cursor: string | null
  has_more: boolean
}

// paginate: 从多取 1 条的结果中截断并计算 next_cursor。
// getId 取该行的 id(作 cursor 游标值,base64url)。
export function paginate<T>(
  rows: T[],
  getId: (row: T) => string,
  limit: number,
): PaginatedResponse<T> {
  const has_more = rows.length > limit
  const data = has_more ? rows.slice(0, limit) : rows
  const last = data[data.length - 1]
  const next_cursor = has_more && last !== undefined ? encodeCursor(getId(last)) : null
  return { data, next_cursor, has_more }
}

// encodeCursor / decodeCursor: id -> base64url。
export function encodeCursor(id: string): string {
  return btoa(id).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeCursor(cursor: string): string {
  try {
    return atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))
  } catch {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      longMessage: 'Invalid cursor.',
    })
  }
}

export type ApiKeyScope = string

function normalizeApiKeyScopes(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function apiKeyAllows(scopes: string[], requiredScopes: string[]): boolean {
  if (requiredScopes.length === 0) return true
  if (scopes.length === 0) return false
  if (scopes.includes('*')) return true
  return requiredScopes.some((required) => {
    const resource = required.split(':')[0]
    return scopes.includes(required) || (resource !== undefined && scopes.includes(`${resource}:*`))
  })
}

// scope 词法白名单:只允许 v1 实际使用的资源名,防乱码 scope 入库(入库后 apiKeyAllows 永不命中等于废 key)。
const API_KEY_SCOPE_RESOURCES = new Set([
  'api_keys',
  'applications',
  'audit_events',
  'branding',
  'connections',
  'directories',
  'invitations',
  'memberships',
  'organization_domains',
  'organizations',
  'permissions',
  'project_grants',
  'roles',
  'sessions',
  'users',
  'webhooks',
])
const API_KEY_SCOPE_ACTIONS = new Set(['read', 'write', '*'])

export function isApiKeyScopeLexical(scope: string): boolean {
  if (scope === '*') return true
  const parts = scope.split(':')
  if (parts.length !== 2) return false
  const [resource, action] = parts
  return (
    resource !== undefined &&
    action !== undefined &&
    API_KEY_SCOPE_RESOURCES.has(resource) &&
    API_KEY_SCOPE_ACTIONS.has(action)
  )
}

// 铸 key 防提权:新 key scope 必须 ⊆ caller scope,判定语义与 apiKeyAllows 一致('*' 全量 / resource:* 通配)。
export function apiKeyScopesCover(
  callerScopes: readonly string[],
  requested: readonly string[],
): boolean {
  if (callerScopes.includes('*')) return true
  return requested.every((scope) => {
    if (scope === '*') return false
    const resource = scope.split(':')[0]
    return (
      callerScopes.includes(scope) ||
      (resource !== undefined && callerScopes.includes(`${resource}:*`))
    )
  })
}

// sk_live_ / sk_test_ Bearer token 认证守卫。
// sha256Hex(token) 后与 api_keys.key_hash 字符串 === 比对(等长 hex,timing 归一化)。
// 通过认证返回 key 行 id 与 scopes(铸新 key 时做子集校验),否则 throw AppError('unauthorized')。
// requiredScopes 非空时校验 api_keys.scopes;空 scopes 表示没有资源权限。
export async function requireApiKey(
  c: Context<XidHonoEnv>,
  requiredScopes: ApiKeyScope | ApiKeyScope[] = [],
): Promise<{ id: string; scopes: string[] }> {
  const auth = c.req.header('Authorization') ?? ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!bearer || (!bearer.startsWith('sk_live_') && !bearer.startsWith('sk_test_'))) {
    throw new AppError('unauthorized', { longMessage: 'Missing or invalid Authorization header.' })
  }

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)

  const hash = await sha256Hex(bearer)
  // keyHash 是唯一索引,findOne 直接精确命中。
  const found = await db.apiKeys.findOne(
    and(eq(schema.apiKeys.keyHash, hash), eq(schema.apiKeys.tenantId, tenant.tenantId)),
  )

  if (!found) throw new AppError('unauthorized', { longMessage: 'API key not found or revoked.' })
  if (found.revokedAt !== null)
    throw new AppError('unauthorized', { longMessage: 'API key revoked.' })
  if (found.expiresAt !== null && found.expiresAt < new Date()) {
    throw new AppError('unauthorized', { longMessage: 'API key expired.' })
  }
  const required = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes]
  const scopes = normalizeApiKeyScopes(found.scopes)
  if (!apiKeyAllows(scopes, required)) {
    throw new AppError('insufficient_permission', {
      httpStatus: 403,
      longMessage: 'API key scope does not allow this operation.',
    })
  }
  return { id: found.id, scopes }
}

// org_console 调用者的管理角色:membership owner/admin,或平台层 org_manager(视同 owner 级,见 02 章 Manager Roles)。
export type OrgManagerRole = 'owner' | 'admin' | 'org_manager'

export type OrgScopedAuth =
  | { kind: 'api_key'; apiKeyId: string; scopes: string[] }
  | { kind: 'org_console'; session: SessionData; role: OrgManagerRole }

// Org console 与 Management API 共享同一 org 级资源路径:
// - Bearer sk_* 走 Management API key 认证。
// - 无 API key 时走 cookie session + org admin / owner / org_manager 门控。
export async function requireApiKeyOrOrgManager(
  c: Context<XidHonoEnv>,
  orgId: string,
  requiredScope: ApiKeyScope | ApiKeyScope[] = [],
): Promise<OrgScopedAuth> {
  const auth = c.req.header('Authorization') ?? ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (bearer.startsWith('sk_live_') || bearer.startsWith('sk_test_')) {
    const key = await requireApiKey(c, requiredScope)
    await requireOrg(c, orgId)
    return { kind: 'api_key', apiKeyId: key.id, scopes: key.scopes }
  }
  const { session, role } = await requireOrgManager(c, orgId)
  return { kind: 'org_console', session, role }
}

// 租户级资源(applications/webhooks/api-keys 等扁平 /v1 资源,无 org 路径参数)的双认证:
// - Bearer sk_*:走 Management API key(租户隔离已由 key 的 tenant 绑定保证,不再叠加 org 校验,保持与裸 requireApiKey 一致)。
// - 无 key:cookie session 必须是本租户顶层 org(id = tenantId,见 platform/shared topLevelOrgFilter)的 owner/admin/org_manager。
export async function requireApiKeyOrTopLevelOrgManager(
  c: Context<XidHonoEnv>,
  requiredScope: ApiKeyScope | ApiKeyScope[] = [],
): Promise<OrgScopedAuth> {
  const auth = c.req.header('Authorization') ?? ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (bearer.startsWith('sk_live_') || bearer.startsWith('sk_test_')) {
    const key = await requireApiKey(c, requiredScope)
    return { kind: 'api_key', apiKeyId: key.id, scopes: key.scopes }
  }
  const tenant = c.get('tenant')
  const { session, role } = await requireOrgManager(c, tenant.tenantId)
  return { kind: 'org_console', session, role }
}

export async function requireOrgManager(
  c: Context<XidHonoEnv>,
  orgId: string,
): Promise<{ session: SessionData; role: OrgManagerRole }> {
  const session = c.get('session') ?? (await readSession(c))
  if (!session) throw new AppError('unauthorized', { httpStatus: 401 })

  await requireOrg(c, orgId)

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const membership = await db.memberships.findOne(
    and(
      eq(schema.memberships.userId, session.userId),
      eq(schema.memberships.orgId, orgId),
      eq(schema.memberships.status, 'active'),
    ),
  )
  if (membership && (membership.role === 'admin' || membership.role === 'owner')) {
    return { session, role: membership.role }
  }

  const orgManager = await db.managerAssignments.findOne(
    and(
      eq(schema.managerAssignments.userId, session.userId),
      eq(schema.managerAssignments.managerRole, 'org_manager'),
      eq(schema.managerAssignments.scopeType, 'org'),
      eq(schema.managerAssignments.scopeId, orgId),
    ),
  )
  if (orgManager) return { session, role: 'org_manager' }

  throw new AppError('forbidden', { httpStatus: 403 })
}

// checkInvitationRateLimit:批量 invitations 50/hour/tenant 限速,走 tenant 独占 DO 原子计数。
export async function checkInvitationRateLimit(
  c: Context<XidHonoEnv>,
  count: number,
): Promise<void> {
  const tenant = c.get('tenant')
  const key = `invitations:${tenant.tenantId}`
  const ns = c.env.RATE_LIMITER
  const stub = ns.get(ns.idFromName(key))
  const response = await stub.fetch('https://rate-limit/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key,
      count,
      policy: {
        windowMs: 60 * 60 * 1000,
        maxRequests: 50,
        lockDurationMs: 0,
      },
    }),
  })
  const result = (await response.json()) as { allowed: boolean }
  if (!result.allowed) {
    throw new AppError('rate_limited', {
      httpStatus: 429,
      longMessage: 'Bulk invitation limit: 50 per hour.',
    })
  }
}

// requireOrg: 验证 orgId 属于当前租户,返回 org 行;不存在/已暂停均 throw AppError。
export async function requireOrg(
  c: Context<XidHonoEnv>,
  orgId: string,
): Promise<typeof schema.organizations.$inferSelect> {
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const org = await db.organizations.findOne(eq(schema.organizations.id, orgId))
  if (!org || org.status === 'deleted') throw new AppError('org_not_found', { httpStatus: 404 })
  if (org.status === 'suspended') throw new AppError('org_suspended', { httpStatus: 403 })
  return org
}

// emitWebhookAsync: webhook 投递不阻塞响应,但由 execution context 持有失败结果供平台观测。
export function emitWebhookAsync(
  c: Context<XidHonoEnv> | Env,
  msg: { tenantId: string; event: string; payload: Record<string, unknown> },
): void {
  const executionCtx = readExecutionContext(c)
  const env = 'env' in c ? c.env : c
  const task = env.WEBHOOK_QUEUE.send(msg)
  if (executionCtx !== undefined) {
    executionCtx.waitUntil(task)
    return
  }
  void task.catch((error: unknown) => console.error('webhook queue send failed', error))
}

function readExecutionContext(c: Context<XidHonoEnv> | Env) {
  if (!('executionCtx' in c)) return undefined
  try {
    return c.executionCtx
  } catch (error) {
    if (error instanceof Error && error.message === 'This context has no ExecutionContext') {
      return undefined
    }
    throw error
  }
}

// idAfterCursor: id 字典序游标条件(SQLite text PK 字典序 = 插入序)。
// col 接受任意 SQLiteColumn<string>,cursor 为 null 时返回 undefined(首页无过滤)。
export function idAfterCursor(
  col: SQLiteColumn,
  cursor: string | null,
): ReturnType<typeof gt> | undefined {
  if (!cursor) return undefined
  const id = decodeCursor(cursor)
  return gt(col, id)
}
