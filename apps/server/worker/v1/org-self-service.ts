// allow_org_self_service 门控(02 章 6):平台关闭后,org admin 不能改 SSO、MFA 与登录策略、
// 投递通道、社交登录、出站 SAML 应用、入站 SCIM 目录和出站 SCIM 目标;branding 与域名不在锁定范围。

import { schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import type { OrgScopedAuth } from './shared'

// instance_manager 分配在平台层(scope=instance),不经租户查询层,raw drizzle 按 userId 直查
// (同 me.ts isInstanceManager;租户层会注入 tenant_id 漏查他租户分配)。
export async function isInstanceManagerUser(
  c: Context<XidHonoEnv>,
  userId: string,
): Promise<boolean> {
  const db = drizzle(c.env.DB, { schema })
  const rows = await db
    .select({ id: schema.managerAssignments.id })
    .from(schema.managerAssignments)
    .where(
      and(
        eq(schema.managerAssignments.userId, userId),
        eq(schema.managerAssignments.managerRole, 'instance_manager'),
        eq(schema.managerAssignments.scopeType, 'instance'),
      ),
    )
    .limit(1)
  return rows.length > 0
}

// sk 路径与 instance_manager 不受影响,故仅 org_console 分支检查。
export async function assertOrgSelfServiceEditable(
  c: Context<XidHonoEnv>,
  auth: OrgScopedAuth,
  org: typeof schema.organizations.$inferSelect,
): Promise<void> {
  if (auth.kind !== 'org_console' || org.allowOrgSelfService !== false) return
  if (await isInstanceManagerUser(c, auth.session.userId)) return
  throw new AppError('forbidden', { httpStatus: 403 })
}
