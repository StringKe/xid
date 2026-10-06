// /v1/organizations 各子模块共用的查询与审计辅助。

import type { schema } from '@xid-kit/db'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { auditActorId, emitManagementAuditAsync, type OrgScopedAuth } from './shared'

export const ORG_LIST_BATCH_SIZE = 100

// org 行转对外响应(白名单):private_metadata 含策略、品牌与 secret ref,不直接下发,
// console 需要的策略字段走 auth-policy / delivery-channels / social-providers / branding 显式端点。
export function toOrganizationResponse(row: typeof schema.organizations.$inferSelect) {
  return {
    id: row.id,
    parent_org_id: row.parentOrgId,
    slug: row.slug,
    name: row.name,
    logo_url: row.logoUrl,
    public_metadata: row.publicMetadata,
    enrollment_mode: row.enrollmentMode,
    seat_limit: row.seatLimit,
    seat_used: row.seatUsed,
    allow_org_self_service: row.allowOrgSelfService,
    status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

export function toIso(value: Date | number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return new Date(value).toISOString()
}

export async function readAllById<T extends { id: string }>(
  readPage: (cursor: string | null) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = []
  let cursor: string | null = null
  while (true) {
    const page = await readPage(cursor)
    if (page.length === 0) break
    rows.push(...page)
    cursor = page[page.length - 1]?.id ?? null
    if (page.length < ORG_LIST_BATCH_SIZE) break
  }
  return rows
}

export async function readAllByIds<T extends { id: string }>(
  ids: readonly string[],
  readPage: (ids: readonly string[], cursor: string | null) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; offset < ids.length; offset += ORG_LIST_BATCH_SIZE) {
    rows.push(
      ...(await readAllById((cursor) =>
        readPage(ids.slice(offset, offset + ORG_LIST_BATCH_SIZE), cursor),
      )),
    )
  }
  return rows
}

// D1 唯一约束冲突识别:drizzle 会把原始错误包成 DrizzleQueryError(message 只有 Failed query),
// 真实的 UNIQUE constraint 消息在 cause 链上,故沿 cause 递归匹配。
export function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (/unique constraint/iu.test(error.message)) return true
  return error.cause !== undefined && isUniqueConstraintError(error.cause)
}

export function auditOrgMutation(
  c: Context<XidHonoEnv>,
  auth: OrgScopedAuth,
  input: {
    action: string
    orgId: string
    targetType: string
    targetId: string
    details?: Record<string, unknown>
  },
): void {
  emitManagementAuditAsync(c, {
    action: input.action,
    actorId: auditActorId(auth),
    orgId: input.orgId,
    targetType: input.targetType,
    targetId: input.targetId,
    ...(input.details ? { details: input.details } : {}),
  })
}
