// 入站 SCIM User 写路径(POST/PUT/PATCH/DELETE)共用的生命周期:落 directory_users、
// 绑定或新建 XID User、停用与恢复。停用走两阶段(deprovisioning -> deactivated/deleted),
// 撤销失败返回 503,IdP 重试时会再次执行撤销(04 章 10.1.2)。

import { createTenantDb, schema } from '@xid-kit/db'
import type { Result, TenantContext } from '@xid-kit/types'
import { and, eq, ne } from 'drizzle-orm'
import type { Context } from 'hono'
import { createPersistedId } from '../lib/persisted-id'
import { logWorkerError } from '../lib/safe-log'
import type { XidHonoEnv } from '../lib/types'
import { emitWebhookAsync, scimError, versionGuardFromRow } from './shared'
import type { DirectoryRow } from './shared'
import { deactivateDirectoryAccount, reactivateDirectoryAccount } from './user-deprovisioning'
import type { DeactivateDirectoryAccountInput } from './user-deprovisioning'
import {
  applyDirectoryUserLink,
  planDirectoryUserLink,
  scimUserProfile,
  syncScimUserProfile,
} from './user-provisioning'
import type {
  DirectoryLinkScope,
  DirectoryUserLinkPlan,
  ScimUserProfile,
} from './user-provisioning'

type DirectoryUserRecord = typeof schema.directoryUsers.$inferSelect
type LinkPlan = Exclude<DirectoryUserLinkPlan, { kind: 'conflict' }>

export type DirectoryUserScope = {
  c: Context<XidHonoEnv>
  tenant: TenantContext
  directory: DirectoryRow
}

export type DirectoryUserFields = {
  userName: string
  externalId?: string | null
  active: boolean
  scimRaw: Record<string, unknown>
}

function linkScope(scope: DirectoryUserScope): DirectoryLinkScope {
  return {
    db: createTenantDb(scope.c.env.DB, scope.tenant),
    tenantId: scope.tenant.tenantId,
    orgId: scope.directory.orgId,
  }
}

function conflictResponse(c: Context<XidHonoEnv>): Response {
  return scimError(c, 409, 'userName or email already belongs to another account', 'uniqueness')
}

function directoryUserWhere(scope: DirectoryUserScope, id: string) {
  return and(
    eq(schema.directoryUsers.id, id),
    eq(schema.directoryUsers.directoryId, scope.directory.id),
  )
}

type LinkDirectoryUserInput = {
  row: DirectoryUserRecord
  plan: LinkPlan
  profile: ScimUserProfile
}

async function linkDirectoryUser(
  scope: DirectoryUserScope,
  { row, plan, profile }: LinkDirectoryUserInput,
): Promise<DirectoryUserRecord> {
  const ls = linkScope(scope)
  const link = await applyDirectoryUserLink(ls, { plan, profile, directoryUserId: row.id })
  if (link.created) {
    emitWebhookAsync(scope.c, {
      tenantId: scope.tenant.tenantId,
      event: 'user.created',
      payload: {
        userId: link.userId,
        directoryId: scope.directory.id,
        orgId: scope.directory.orgId,
      },
    })
  }
  return (await ls.db.directoryUsers.findOne(directoryUserWhere(scope, row.id))) ?? row
}

// 撤销失败时记录日志并返回 503;directory_users 保持 deprovisioning,IdP 重试会重新撤销。
export async function deactivateLinkedAccount(
  scope: DirectoryUserScope,
  input: Pick<DeactivateDirectoryAccountInput, 'userId' | 'reason'>,
): Promise<Response | null> {
  try {
    await deactivateDirectoryAccount(scope.c, {
      tenant: scope.tenant,
      orgId: scope.directory.orgId,
      directoryId: scope.directory.id,
      ...input,
    })
    return null
  } catch (error) {
    logWorkerError('scim.user.deprovision_failed', error, { component: 'scim' })
    return scimError(scope.c, 503, 'Session revocation unavailable')
  }
}

export async function createDirectoryUser(
  scope: DirectoryUserScope,
  fields: DirectoryUserFields,
): Promise<Result<DirectoryUserRecord, Response>> {
  const ls = linkScope(scope)
  const profile = scimUserProfile(fields.scimRaw, fields.userName)
  const plan = fields.active ? await planDirectoryUserLink(ls, profile) : null
  if (plan?.kind === 'conflict') return { ok: false, error: conflictResponse(scope.c) }

  const row = await ls.db.directoryUsers.insert({
    id: createPersistedId('directoryUser'),
    tenantId: scope.tenant.tenantId,
    directoryId: scope.directory.id,
    userName: fields.userName,
    externalId: fields.externalId ?? undefined,
    active: fields.active,
    status: fields.active ? 'active' : 'deactivated',
    scimRaw: fields.scimRaw,
  })
  if (!plan) return { ok: true, value: row }
  return { ok: true, value: await linkDirectoryUser(scope, { row, plan, profile }) }
}

export async function updateDirectoryUser(
  scope: DirectoryUserScope,
  existing: DirectoryUserRecord,
  fields: DirectoryUserFields,
): Promise<Result<DirectoryUserRecord, Response>> {
  const ls = linkScope(scope)
  const profile = scimUserProfile(fields.scimRaw, fields.userName)
  const plan = fields.active && !existing.userId ? await planDirectoryUserLink(ls, profile) : null
  if (plan?.kind === 'conflict') return { ok: false, error: conflictResponse(scope.c) }
  const revoking =
    !fields.active &&
    existing.userId !== null &&
    (existing.active || existing.status === 'deprovisioning')

  const updated = await ls.db.directoryUsers.update(
    {
      userName: fields.userName,
      ...(fields.externalId === undefined ? {} : { externalId: fields.externalId }),
      active: fields.active,
      status: revoking ? 'deprovisioning' : fields.active ? 'active' : 'deactivated',
      scimRaw: fields.scimRaw,
    },
    and(
      directoryUserWhere(scope, existing.id),
      ne(schema.directoryUsers.status, 'deleted'),
      eq(schema.directoryUsers.updatedAt, versionGuardFromRow(existing.updatedAt)),
    ),
  )
  const row = updated[0]
  if (!row) return { ok: false, error: scimError(scope.c, 412, 'Resource version mismatch') }

  if (revoking && existing.userId) {
    const failure = await deactivateLinkedAccount(scope, {
      userId: existing.userId,
      reason: 'deactivated',
    })
    if (failure) return { ok: false, error: failure }
    const finalized = await ls.db.directoryUsers.update(
      { status: 'deactivated' },
      and(
        directoryUserWhere(scope, existing.id),
        eq(schema.directoryUsers.status, 'deprovisioning'),
      ),
    )
    emitWebhookAsync(scope.c, {
      tenantId: scope.tenant.tenantId,
      event: 'user.deactivated',
      payload: {
        userId: existing.userId,
        directoryId: scope.directory.id,
        orgId: scope.directory.orgId,
      },
    })
    return { ok: true, value: finalized[0] ?? row }
  }
  if (plan) return { ok: true, value: await linkDirectoryUser(scope, { row, plan, profile }) }
  if (fields.active && existing.userId) {
    const target = {
      tenant: scope.tenant,
      userId: existing.userId,
      orgId: scope.directory.orgId,
      directoryId: scope.directory.id,
    }
    if (existing.active) await syncScimUserProfile(ls, existing.userId, profile)
    else await reactivateDirectoryAccount(scope.c, target)
  }
  return { ok: true, value: row }
}
