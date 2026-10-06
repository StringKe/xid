// SSO JIT 与入站 SCIM 共用的邮箱关联规则(04 章 4、6)。
// 外部 IdP 可以声明任意邮箱。本地邮箱必须已验证,且 IdP 邮箱可信(IdP 声明已验证或邮箱域已在目标
// org 验证),再满足其一才允许关联:命中用户已是目标 org 的 active 成员,或 IdP 声明已验证且邮箱域
// 已在目标 org 验证。其余命中一律视为冲突,既不登录也不新建(UNIQUE(tenant_id, email) 不允许第二个账号)。

import type { createTenantDb } from '@xid-kit/db'
import { schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'

type TenantDb = ReturnType<typeof createTenantDb>

export type EmailLinkInput = {
  orgId: string
  email: string | null | undefined
  emailVerified: boolean
}

export type EmailLinkResult =
  | { kind: 'none' }
  | { kind: 'linkable'; userId: string }
  | { kind: 'conflict' }

export function normalizeLinkEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase() ?? ''
  return normalized.includes('@') ? normalized : null
}

function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@')
  return at < 0 ? null : email.slice(at + 1).toLowerCase()
}

async function isActiveOrgMember(db: TenantDb, orgId: string, userId: string): Promise<boolean> {
  const membership = await db
    .forOrg(orgId)
    .memberships.findOne(
      and(eq(schema.memberships.userId, userId), eq(schema.memberships.status, 'active')),
    )
  return membership !== undefined
}

// 与 HRD 同一信号:邮箱域命中本 org 已验证且有效的域名,通配域覆盖子域。
export async function isVerifiedOrgEmailDomain(
  db: TenantDb,
  orgId: string,
  email: string,
): Promise<boolean> {
  const domain = emailDomain(email)
  if (!domain) return false
  const rows = await db
    .forOrg(orgId)
    .organizationDomains.findMany(
      and(
        eq(schema.organizationDomains.verificationStatus, 'verified'),
        eq(schema.organizationDomains.status, 'active'),
        isNull(schema.organizationDomains.deletedAt),
      ),
    )
  return rows.some(
    (row) => row.domain === domain || (row.isWildcard && domain.endsWith(`.${row.domain}`)),
  )
}

export async function findLinkableUserByEmail(
  db: TenantDb,
  input: EmailLinkInput,
): Promise<EmailLinkResult> {
  const email = normalizeLinkEmail(input.email)
  if (!email) return { kind: 'none' }
  const row = await db.userEmails.findOne(eq(schema.userEmails.email, email))
  if (!row) return { kind: 'none' }
  if (!row.verified || row.verificationStatus !== 'verified') return { kind: 'conflict' }
  const isMember = await isActiveOrgMember(db, input.orgId, row.userId)
  if (input.emailVerified && isMember) return { kind: 'linkable', userId: row.userId }
  const isDomainVerified = await isVerifiedOrgEmailDomain(db, input.orgId, email)
  if (isDomainVerified && (isMember || input.emailVerified)) {
    return { kind: 'linkable', userId: row.userId }
  }
  return { kind: 'conflict' }
}
