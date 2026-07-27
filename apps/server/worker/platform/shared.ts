// platform-console 共享工具:Instance Manager 门控守卫 + 跨租户独立管理 db 路径 + 分页解析。
// 区别于 v1/shared.ts(sk_live_ Bearer + createTenantDb 单租户注入):
//   - 认证走 cookie session(readSession),门控按 managerAssignments(instance_manager / scope=instance)。
//   - 数据访问跨所有租户(Instance Manager 跨 org,见 tenant-isolation rule):用 raw drizzle(独立管理路径),
//     不走 createTenantDb(那会强制注入单一 tenant_id,无法跨租户聚合)。这是 02 章/07 章明确的管理路径例外。
// 前端契约(冻结):Page<T> 输出 { data, nextCursor, total }(camelCase + total),不复用 v1 paginate 的 { next_cursor, has_more }。

import { schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { Context } from 'hono'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { requireVerifiedManagementMutation } from '../lib/management-access'
import { readSession } from '../lib/session'
import { decodeCursor, encodeCursor } from '../v1/shared'

// 前端 Page<T> 容器(契约冻结:nextCursor camelCase + total,见 platform console/types.ts)。
export type PlatformPage<T> = {
  data: T[]
  nextCursor: string | null
  total: number
}

// 跨租户独立管理 db:raw drizzle(无 tenant_id 注入)。仅供 Instance Manager 路径用,
// 调用前必须先过 requireInstanceManager 守卫(否则越权)。与 bootstrap.ts 同款 raw drizzle 管理路径。
export function managementDb(env: Env): ReturnType<typeof drizzle<typeof schema>> {
  return drizzle(env.DB, { schema })
}

// Instance Manager 门控守卫(契约:cookie-session + instance_manager)。
// 1. readSession(c):无 session -> 401 unauthorized(前端 api.ts onUnauthorized 触发登出)。
// 2. managerAssignments 查 (userId, managerRole='instance_manager', scopeType='instance'):
//    无分配 -> 403 forbidden。Instance Manager 分配本身跨租户(平台层,见 02 章 3、08 章 13.5),
//    用 raw drizzle 按 userId 查(不按 tenant 收窄),命中即放行。
// 返回当前 session(含 userId,供审计 actorId 用)。
export async function requireInstanceManager(c: Context<XidHonoEnv>): Promise<SessionData> {
  const session = c.get('session') ?? (await readSession(c))
  if (!session) throw new AppError('unauthorized', { httpStatus: 401 })

  const db = managementDb(c.env)
  const rows = await db
    .select({ id: schema.managerAssignments.id })
    .from(schema.managerAssignments)
    .where(
      and(
        eq(schema.managerAssignments.userId, session.userId),
        eq(schema.managerAssignments.managerRole, 'instance_manager'),
        eq(schema.managerAssignments.scopeType, 'instance'),
      ),
    )
    .limit(1)

  if (rows.length === 0) throw new AppError('forbidden', { httpStatus: 403 })
  await requireVerifiedManagementMutation(c, session)
  return session
}

// 平台分页参数解析。前端各页固定传 limit(stats 无分页;tenants/users/billing=20;audit=30),
// 缺省回退 fallback;clamp 到 [1, MAX_PLATFORM_PAGE_SIZE]。cursor 直读 query。
export const MAX_PLATFORM_PAGE_SIZE = 100

export function parsePlatformPagination(
  c: Context<XidHonoEnv>,
  fallbackLimit: number,
): { limit: number; cursor: string | null } {
  const raw = Number(c.req.query('limit') ?? String(fallbackLimit))
  const limit = Math.min(
    MAX_PLATFORM_PAGE_SIZE,
    Math.max(1, Number.isNaN(raw) ? fallbackLimit : raw),
  )
  const cursor = c.req.query('cursor') ?? null
  return { limit, cursor }
}

// 顶层 org = 租户(parent_org_id IS NULL,见 08 章 10.2 顶层 org 的 tenant_id = 自身 id)。
export function topLevelOrgFilter(): ReturnType<typeof isNull> {
  return isNull(schema.organizations.parentOrgId)
}

export { decodeCursor, encodeCursor }
