// SCIM 目录的管理操作(创建、轮换 token、删除、恢复),/v1/directories 与
// /v1/organizations/:id/directories 两组路由共用,各自只负责鉴权与响应格式(04 章 10.2)。

import { base64UrlEncode, sha256Hex } from '@xid-kit/crypto'
import { schema } from '@xid-kit/db'
import type { createTenantDb } from '@xid-kit/db'
import type { TenantContext } from '@xid-kit/types'
import type { SQL } from 'drizzle-orm'
import { and, eq } from 'drizzle-orm'
import { createPersistedId } from '../lib/persisted-id'
import { SCIM_TOKEN_ROTATE_GRACE_MS } from '../lib/ttl'

type TenantDb = ReturnType<typeof createTenantDb>
type DirectoryRecord = typeof schema.directories.$inferSelect

export function generateScimToken(): string {
  return `scim_${base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))}`
}

// SCIM 路径参数是顶级 Organization(tenant)id,根域请求按该 id 解析租户,子组织目录也用同一地址。
export function scimBaseUrl(tenant: Pick<TenantContext, 'issuer' | 'tenantId'>): string {
  return `${new URL(tenant.issuer).origin}/scim/v2/organizations/${tenant.tenantId}`
}

export type CreateDirectoryInput = {
  tenantId: string
  orgId: string
  provider: string
}

export async function createDirectory(
  db: TenantDb,
  input: CreateDirectoryInput,
): Promise<{ row: DirectoryRecord; token: string }> {
  const token = generateScimToken()
  const row = await db.directories.insert({
    id: createPersistedId('directory'),
    tenantId: input.tenantId,
    orgId: input.orgId,
    provider: input.provider,
    scimTokenHash: await sha256Hex(token),
    status: 'active',
    syncStatus: 'idle',
  })
  return { row, token }
}

export async function rotateDirectoryToken(
  db: TenantDb,
  where: SQL | undefined,
): Promise<{ token: string; previousTokenExpiresAt: Date } | null> {
  const activeWhere = and(where, eq(schema.directories.status, 'active'))
  const existing = await db.directories.findOne(activeWhere)
  if (!existing) return null
  const token = generateScimToken()
  const previousTokenExpiresAt = new Date(Date.now() + SCIM_TOKEN_ROTATE_GRACE_MS)
  await db.directories.update(
    {
      scimTokenHashPrev: existing.scimTokenHash,
      scimTokenPrevExpires: previousTokenExpiresAt,
      scimTokenHash: await sha256Hex(token),
    },
    activeWhere,
  )
  return { token, previousTokenExpiresAt }
}

// 删除后当前与宽限期内的旧 token 都立即失效(authBearer 只接受 status=active)。
export async function deleteDirectory(db: TenantDb, where: SQL | undefined): Promise<boolean> {
  const activeWhere = and(where, eq(schema.directories.status, 'active'))
  const updated = await db.directories.update(
    {
      status: 'deleted',
      syncStatus: 'disabled',
      scimTokenHashPrev: null,
      scimTokenPrevExpires: null,
      deletedAt: new Date(),
    },
    activeWhere,
  )
  return updated.length > 0
}

export async function restoreDirectory(
  db: TenantDb,
  where: SQL | undefined,
): Promise<{ row: DirectoryRecord; token: string } | null> {
  const token = generateScimToken()
  const updated = await db.directories.update(
    {
      status: 'active',
      syncStatus: 'idle',
      scimTokenHash: await sha256Hex(token),
      scimTokenHashPrev: null,
      scimTokenPrevExpires: null,
      deletedAt: null,
    },
    and(where, eq(schema.directories.status, 'deleted')),
  )
  const row = updated[0]
  return row ? { row, token } : null
}
