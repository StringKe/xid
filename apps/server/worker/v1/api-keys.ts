// Management API v1: apiKeys(sk_live_ 生成/列出/吊销)
// 见 06 章 7、09 章 DX。key 明文只返回一次,之后只存 SHA-256 哈希。
// 路由前缀:/v1/api-keys

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { API_KEY_ENVIRONMENTS, type ApiKeyEnvironment } from '@xid-kit/types'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import {
  auditActorId,
  emitManagementAuditAsync,
  idAfterCursor,
  requireApiKeyOrTopLevelOrgManager,
  isApiKeyScopeLexical,
  apiKeyScopesCover,
  paginate,
  parsePagination,
  type OrgScopedAuth,
} from './shared'

const app = new Hono<XidHonoEnv>()

// environment 只决定前缀,live 与 test key 权限相同,权限由 scopes 决定。
const createApiKeyBodySchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  environment: v.optional(v.picklist(API_KEY_ENVIRONMENTS)),
  scopes: v.optional(v.array(v.string())),
  expires_at: v.optional(
    v.pipe(
      v.string(),
      v.check((value) => !Number.isNaN(Date.parse(value))),
    ),
  ),
})

// 生成 sk_live_/sk_test_ key(格式:sk_live_<32字符随机字母数字>)。
function genKey(env: ApiKeyEnvironment): string {
  const prefix = env === 'test' ? 'sk_test_' : 'sk_live_'
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  const suffix = Array.from(bytes)
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 32)
  return `${prefix}${suffix}`
}

function toResponse(row: typeof schema.apiKeys.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.keyPrefix,
    environment: row.environment,
    scopes: row.scopes,
    last_used_at: row.lastUsedAt,
    expires_at: row.expiresAt,
    revoked_at: row.revokedAt,
    created_at: row.createdAt,
  }
}

// 顶层 org 的 owner/admin/org_manager(cookie)或 sk_ key 均可管理本租户 API key。
// requireApiKeyOrTopLevelOrgManager 统一处理 sk_ key 与 cookie session 两路。
async function requireApiKeyManager(
  c: Context<XidHonoEnv>,
  scope: 'api_keys:read' | 'api_keys:write',
): Promise<OrgScopedAuth> {
  return requireApiKeyOrTopLevelOrgManager(c, scope)
}

function auditApiKey(
  c: Context<XidHonoEnv>,
  auth: OrgScopedAuth,
  input: { action: string; keyId: string; details?: Record<string, unknown> },
): void {
  emitManagementAuditAsync(c, {
    action: input.action,
    actorId: auditActorId(auth),
    orgId: c.get('tenant').tenantId,
    targetType: 'api_key',
    targetId: input.keyId,
    ...(input.details ? { details: input.details } : {}),
  })
}

// 铸 key 防提权:
// - scope 必须在白名单词法内(拒绝乱码入库,入库后 apiKeyAllows 永不命中等于废 key)。
// - sk 路径新 key scope 不得超出 caller key(caller 有 '*' 不受限),否则窄 key 可铸全量 key 提权。
// - cookie 路径调用者已是顶层 org owner/admin/org_manager,管理面即全量 scope,不再叠加子集校验。
function assertScopesCreatable(auth: OrgScopedAuth, scopes: string[]): void {
  for (const scope of scopes) {
    if (!isApiKeyScopeLexical(scope)) {
      throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'scopes' } })
    }
  }
  if (auth.kind === 'api_key' && !apiKeyScopesCover(auth.scopes, scopes)) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'scopes' } })
  }
}

// GET /v1/api-keys
app.get('/', async (c) => {
  await requireApiKeyManager(c, 'api_keys:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const { limit, cursor } = parsePagination(c)
  const active = isNull(schema.apiKeys.revokedAt)
  const after = idAfterCursor(schema.apiKeys.id, cursor)
  const rows = await db.apiKeys.findMany(after ? and(active, after) : active, {
    orderBy: asc(schema.apiKeys.id),
    limit: limit + 1,
  })
  return c.json(paginate(rows.map(toResponse), (r) => r.id, limit))
})

// POST /v1/api-keys - 创建新 key,明文只此一次返回
app.post('/', async (c) => {
  const auth = await requireApiKeyManager(c, 'api_keys:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createApiKeyBodySchema, json.value)

  const name = body.name
  const environment = body.environment ?? 'live'
  const scopes = body.scopes ?? []
  assertScopesCreatable(auth, scopes)

  const key = genKey(environment)
  const keyHash = await sha256Hex(key)
  const keyPrefix = key.slice(0, 16)

  const expiresAt = body.expires_at === undefined ? undefined : new Date(body.expires_at)
  if (expiresAt !== undefined && expiresAt.getTime() <= Date.now()) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'expires_at' } })
  }

  const row = await db.apiKeys.insert({
    id: createPersistedId('apiKey'),
    tenantId: tenant.tenantId,
    name,
    keyHash,
    keyPrefix,
    environment,
    scopes,
    expiresAt,
  })
  auditApiKey(c, auth, {
    action: 'api_key.created',
    keyId: row.id,
    details: { environment, scopes, expiresAt: expiresAt?.toISOString() ?? null },
  })

  return c.json({ ...toResponse(row), key }, 201)
})

// GET /v1/api-keys/:id
app.get('/:id', async (c) => {
  await requireApiKeyManager(c, 'api_keys:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const row = await db.apiKeys.findOne(
    and(eq(schema.apiKeys.id, c.req.param('id')), isNull(schema.apiKeys.revokedAt)),
  )
  if (!row) throw new AppError('not_found')
  return c.json(toResponse(row))
})

// DELETE /v1/api-keys/:id - 吊销(设 revoked_at,不物理删除)
app.delete('/:id', async (c) => {
  const auth = await requireApiKeyManager(c, 'api_keys:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = eq(schema.apiKeys.id, c.req.param('id'))
  const existing = await db.apiKeys.findOne(where)
  if (!existing) throw new AppError('not_found')
  if (existing.revokedAt) throw new AppError('conflict', { longMessage: 'API key already revoked' })

  const updated = await db.apiKeys.update({ revokedAt: new Date() }, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found')
  auditApiKey(c, auth, { action: 'api_key.revoked', keyId: row.id })
  return c.json(toResponse(row))
})

export function registerApiKeys(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/api-keys', app)
}
