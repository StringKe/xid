// RBAC permission 解析(02 章 7.2/7.4):UserGrant -> Role -> RolePermission -> Permission,实时查 D1。
// 普通路径按 (user_id, project_id) 取 role;Grant 路径再加 granted_via_grant_id(tenant_id = org A)。
// 铁律:所有查询走 @xid-kit/db 租户查询层(自动注入 tenant_id);不缓存 permission(撤权 1h 内生效)。

import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm'
import { createTenantDb, schema } from '@xid-kit/db'
import type { TenantContext } from '@xid-kit/types'
import { readAllById } from '../lib/db-pagination'

// 单条权限解析结果:key + 可选 ABAC condition(condition 为 null 表示无条件授予)。
export type ResolvedPermission = {
  key: string
  condition: Record<string, unknown> | null
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
  // 取用户在 project 下未撤销的 role_id(普通或 grant 路径)。
  findRoleIds: (input: ResolvePermissionsInput) => Promise<string[]>
  // 取一组 role 关联的 (permission.key, condition_expression)。
  findRolePermissions: (roleIds: string[]) => Promise<ResolvedPermission[]>
}

type TenantDb = ReturnType<typeof createTenantDb>
type RolePermissionRow = typeof schema.rolePermissions.$inferSelect
type PermissionRow = typeof schema.permissions.$inferSelect

const RBAC_BATCH_SIZE = 100

async function readRolePermissionLinks(
  db: TenantDb,
  roleIds: readonly string[],
): Promise<RolePermissionRow[]> {
  const links: RolePermissionRow[] = []
  for (let start = 0; start < roleIds.length; start += RBAC_BATCH_SIZE) {
    const roleBatch = roleIds.slice(start, start + RBAC_BATCH_SIZE)
    const roleFilter = inArray(schema.rolePermissions.roleId, roleBatch)
    links.push(
      ...(await readAllById((cursor, limit) =>
        db.rolePermissions.findMany(
          cursor ? and(roleFilter, gt(schema.rolePermissions.id, cursor)) : roleFilter,
          { orderBy: asc(schema.rolePermissions.id), limit },
        ),
      )),
    )
  }
  return links
}

async function readPermissions(
  db: TenantDb,
  permissionIds: readonly string[],
): Promise<PermissionRow[]> {
  const permissions: PermissionRow[] = []
  for (let start = 0; start < permissionIds.length; start += RBAC_BATCH_SIZE) {
    const batch = permissionIds.slice(start, start + RBAC_BATCH_SIZE)
    permissions.push(
      ...(await db.permissions.findMany(inArray(schema.permissions.id, batch), {
        limit: batch.length,
      })),
    )
  }
  return permissions
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
      return rows.map((r) => r.roleId)
    },
    findRolePermissions: async (roleIds) => {
      const uniqueRoleIds = [...new Set(roleIds)]
      if (uniqueRoleIds.length === 0) return []
      const links = await readRolePermissionLinks(db, uniqueRoleIds)
      const permissionIds = [...new Set(links.map((l) => l.permissionId))]
      if (permissionIds.length === 0) return []
      const perms = await readPermissions(db, permissionIds)
      const keyById = new Map(perms.map((p) => [p.id, p.key]))
      const out: ResolvedPermission[] = []
      for (const link of links) {
        const key = keyById.get(link.permissionId)
        if (key === undefined) continue
        out.push({ key, condition: link.conditionExpression ?? null })
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
  return store.findRolePermissions(roleIds)
}
