// account portal(self-service)/v1/me/* 系列共享工具。
// 认证:cookie session(readSession),不是 sk_live Bearer(那是 Management API)。
// 所有端点先 requireSession 拿 SessionData;无有效 session -> 401 unauthorized(枚举防护不区分缺失/无效)。
// 租户隔离:查询一律走 createTenantDb(自动注入 tenant_id),tenant 从 TenantContext 取。
// 见 tenant-context rule、tenant-isolation rule、api-sdk-conventions rule。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, desc, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
export { readAllById } from '../lib/db-pagination'
import { ACTIVE_SESSION_STATUS, readSession } from '../lib/session'
import type { SessionData, XidHonoEnv } from '../lib/types'

// 读取 cookie session(不抛错):GET /v1/me 匿名探活用。
export async function resolveSession(c: Context<XidHonoEnv>): Promise<SessionData | null> {
  return c.get('session') ?? (await readSession(c))
}

// account portal 默认只接受完整 active session。pending_mfa/pending_mfa_setup 只给 MFA 专用端点显式读取。
export async function resolveActiveSession(c: Context<XidHonoEnv>): Promise<SessionData | null> {
  const current = c.get('session')
  if (current?.status === ACTIVE_SESSION_STATUS) return current
  return readSession(c, [ACTIVE_SESSION_STATUS])
}

// cookie session 守卫:无有效 session 抛 401(unauthorized)。子资源端点仍要求登录。
// 前端 onUnauthorized 仅在已登录态降级;GET /v1/me 匿名探活返回 200 空壳,避免公开页控制台 401 噪声。
export async function requireSession(c: Context<XidHonoEnv>): Promise<SessionData> {
  const session = await resolveActiveSession(c)
  if (!session) throw new AppError('unauthorized', { httpStatus: 401 })
  return session
}

// Date | null -> ISO 字符串 | null(前端契约统一 ISO 时间串)。
export function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

// 取用户 primary email 行(users.primaryEmailId 指向;缺失回退该用户首个邮箱)。
// 前端 user.email/emailVerified 取此行的 email/verified。
export async function loadPrimaryEmail(
  c: Context<XidHonoEnv>,
  userId: string,
  primaryEmailId: string | null,
): Promise<{ email: string; verified: boolean } | null> {
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)

  if (primaryEmailId) {
    const row = await db.userEmails.findOne(eq(schema.userEmails.id, primaryEmailId))
    if (row) return { email: row.email, verified: row.verified }
  }

  const [primary] = await db.userEmails.findMany(eq(schema.userEmails.userId, userId), {
    orderBy: [
      desc(schema.userEmails.isPrimary),
      asc(schema.userEmails.createdAt),
      asc(schema.userEmails.id),
    ],
    limit: 1,
  })
  if (!primary) return null
  return { email: primary.email, verified: primary.verified }
}

// 指纹脱敏:只回展示用前缀,绝不外泄完整哈希(防关联/重放,见 anti-abuse rule 设备指纹)。
export function maskFingerprint(hash: string | null | undefined): string | null {
  if (!hash) return null
  return hash.length <= 8 ? hash : `${hash.slice(0, 8)}...`
}

// 当前用户在某 org 下的有效 membership(status='active');用于 activeOrg 角色解析。
export async function findActiveMembership(
  c: Context<XidHonoEnv>,
  userId: string,
  orgId: string,
): Promise<typeof schema.memberships.$inferSelect | undefined> {
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  return db.memberships.findOne(
    and(
      eq(schema.memberships.userId, userId),
      eq(schema.memberships.orgId, orgId),
      eq(schema.memberships.status, 'active'),
    ),
  )
}
