// RBAC permission 解析(02 章 7.2/7.4):UserGrant -> Role -> RolePermission -> Permission,实时查 D1。
// 普通路径按 (user_id, project_id) 取 role;Grant 路径再加 granted_via_grant_id(tenant_id = org A)。
// 铁律:所有查询走 @xid-kit/db 租户查询层(自动注入 tenant_id);不缓存 permission(撤权 1h 内生效)。

import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm'
import { createTenantDb, schema } from '@xid-kit/db'
import type { TenantContext } from '@xid-kit/types'
import { readAllById } from '../lib/db-pagination'

// 单条权限解析结果:key + 可选 ABAC condition(condition 为 null 表示无条件授予)。
export type ResolvedPermission = {
  key: string
  condition: Record<string, unknown> | null
  // raw D1 condition_expression 不是合法 JSON object 时标记,下游 deny 并审计但继续签发。
  invalidCondition?: true
}

// 解析输入:普通 RBAC 路径或 Project Grant 跨 org 路径(grantId 非空)。
export type ResolvePermissionsInput = {
  userId: string
  projectId: string
  // Project Grant 路径:仅取该 grant 下的 UserGrant(02 章 7.4 step 1);普通路径为 null。
  grantId?: string | null
}

// 注入端口:permission 解析依赖的最小查询面,真实实现走租户查询层,测试可注入 fake。
export type RbacStore = {
  // 取用户在 project 下未撤销且未过期(expires_at)的 role_id(普通或 grant 路径)。
  findRoleIds: (input: ResolvePermissionsInput) => Promise<string[]>
  // 取一组 role 关联的 (permission.key, condition_expression)。
  findRolePermissions: (roleIds: string[], projectId: string) => Promise<ResolvedPermission[]>
}

type TenantDb = ReturnType<typeof createTenantDb>
type PermissionRow = typeof schema.permissions.$inferSelect

type RawRolePermissionRow = {
  id: string
  permission_id: string
  condition_expression: string | null
}

const RBAC_BATCH_SIZE = 90
const RBAC_PAGE_SIZE = 100

// condition_expression 使用 Drizzle JSON mapper 时,损坏的 legacy/import 数据会在 row mapper
// 阶段直接 throw。此处是明确的安全边界:raw text 读取仍显式绑定 tenant_id,逐行安全解析。
async function readRolePermissionLinks(
  d1: D1Database,
  tenantId: string,
  roleIds: readonly string[],
): Promise<RawRolePermissionRow[]> {
  const links: RawRolePermissionRow[] = []
  for (let start = 0; start < roleIds.length; start += RBAC_BATCH_SIZE) {
    const roleBatch = roleIds.slice(start, start + RBAC_BATCH_SIZE)
    const placeholders = roleBatch.map(() => '?').join(', ')
    let cursor: string | null = null
    while (true) {
      const cursorClause: string = cursor === null ? '' : ' AND id > ?'
      const result: D1Result<RawRolePermissionRow> = await d1
        .prepare(
          `SELECT id, permission_id, condition_expression
           FROM role_permissions
           WHERE tenant_id = ? AND role_id IN (${placeholders})${cursorClause}
           ORDER BY id ASC
           LIMIT ?`,
        )
        .bind(tenantId, ...roleBatch, ...(cursor === null ? [] : [cursor]), RBAC_PAGE_SIZE)
        .all<RawRolePermissionRow>()
      const rows: RawRolePermissionRow[] = result.results ?? []
      links.push(...rows)
      if (rows.length < RBAC_PAGE_SIZE) break
      cursor = rows.at(-1)?.id ?? null
      if (cursor === null) break
    }
  }
  return links
}

function parseConditionExpression(raw: unknown): {
  condition: Record<string, unknown> | null
  invalidCondition?: true
} {
  if (raw === null) return { condition: null }
  if (typeof raw !== 'string') return { condition: null, invalidCondition: true }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { condition: null, invalidCondition: true }
    }
    return { condition: parsed as Record<string, unknown> }
  } catch {
    return { condition: null, invalidCondition: true }
  }
}

async function readPermissions(
  db: TenantDb,
  permissionIds: readonly string[],
  projectId: string,
): Promise<PermissionRow[]> {
  const permissions: PermissionRow[] = []
  for (let start = 0; start < permissionIds.length; start += RBAC_BATCH_SIZE) {
    const batch = permissionIds.slice(start, start + RBAC_BATCH_SIZE)
    permissions.push(
      ...(await db.permissions.findMany(
        and(
          inArray(schema.permissions.id, batch),
          eq(schema.permissions.projectId, projectId),
          eq(schema.permissions.status, 'active'),
          isNull(schema.permissions.deletedAt),
        ),
        { limit: batch.length },
      )),
    )
  }
  return permissions
}

async function readActiveRoleIds(
  db: TenantDb,
  roleIds: readonly string[],
  projectId: string,
): Promise<Set<string>> {
  const active = new Set<string>()
  for (let start = 0; start < roleIds.length; start += RBAC_BATCH_SIZE) {
    const batch = roleIds.slice(start, start + RBAC_BATCH_SIZE)
    const rows = await db.roles.findMany(
      and(
        inArray(schema.roles.id, batch),
        eq(schema.roles.projectId, projectId),
        eq(schema.roles.status, 'active'),
        isNull(schema.roles.deletedAt),
      ),
      { limit: batch.length },
    )
    for (const row of rows) active.add(row.id)
  }
  return active
}

// 真实 RbacStore:绑定 D1 + TenantContext,所有查询自动注入 tenant_id(P0 隔离)。
// Grant 场景的 tenant 即 org A 的 tenant(调用方用 org A 的 TenantContext,见 02 章 7.4)。
export function createRbacStore(d1: D1Database, ctx: TenantContext): RbacStore {
  const db = createTenantDb(d1, ctx)
  return {
    findRoleIds: async (input) => {
      const filters = [
        eq(schema.userGrants.userId, input.userId),
        eq(schema.userGrants.projectId, input.projectId),
        isNull(schema.userGrants.revokedAt),
        // 过期 JIT grant 视同不存在(isGrantEffective 同语义):null = 永久,否则须未到期。
        or(isNull(schema.userGrants.expiresAt), gt(schema.userGrants.expiresAt, new Date())),
      ]
      filters.push(
        input.grantId
          ? eq(schema.userGrants.grantedViaGrantId, input.grantId)
          : isNull(schema.userGrants.grantedViaGrantId),
      )
      const baseFilter = and(...filters)
      const rows = await readAllById((cursor, limit) =>
        db.userGrants.findMany(
          cursor ? and(baseFilter, gt(schema.userGrants.id, cursor)) : baseFilter,
          { orderBy: asc(schema.userGrants.id), limit },
        ),
      )
      const candidateIds = [...new Set(rows.map((r) => r.roleId))]
      const activeIds = await readActiveRoleIds(db, candidateIds, input.projectId)
      return candidateIds.filter((id) => activeIds.has(id))
    },
    findRolePermissions: async (roleIds, projectId) => {
      const uniqueRoleIds = [...new Set(roleIds)]
      if (uniqueRoleIds.length === 0) return []
      const links = await readRolePermissionLinks(d1, ctx.tenantId, uniqueRoleIds)
      const permissionIds = [...new Set(links.map((l) => l.permission_id))]
      if (permissionIds.length === 0) return []
      const perms = await readPermissions(db, permissionIds, projectId)
      const keyById = new Map(perms.map((p) => [p.id, p.key]))
      const out: ResolvedPermission[] = []
      for (const link of links) {
        const key = keyById.get(link.permission_id)
        if (key === undefined) continue
        out.push({ key, ...parseConditionExpression(link.condition_expression) })
      }
      return out
    },
  }
}

// 解析用户在某 project 的 permission 集(02 章 7.2):多角色取并集,同 key 多 condition 全部保留(下游各自求值)。
// 返回 (key, condition) 列表(未去重 key:同 key 不同 condition 等价 OR,见 02 章 7.3);condition 求值在 action 层。
export async function resolveUserPermissions(
  store: RbacStore,
  input: ResolvePermissionsInput,
): Promise<ResolvedPermission[]> {
  const roleIds = [...new Set(await store.findRoleIds(input))]
  if (roleIds.length === 0) return []
  return store.findRolePermissions(roleIds, input.projectId)
}
