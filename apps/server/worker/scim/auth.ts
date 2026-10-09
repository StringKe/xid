// 入站 SCIM Bearer token 鉴权(04 章 9.2):只存 SHA-256 哈希,30 分钟宽限期,常量时间比较。
// directory 查找限定在路径 organization_id 对应的租户内(P0)。

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, gt } from 'drizzle-orm'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'

export type DirectoryRow = {
  id: string
  orgId: string
  tenantId: string
  scimTokenHash: string
  scimTokenHashPrev: string | null
  scimTokenPrevExpires: Date | null
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function authBearer(
  c: Context<XidHonoEnv>,
  tenantId: string,
): Promise<DirectoryRow | null> {
  const authHeader = c.req.header('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return null
  const token = authHeader.slice('Bearer '.length).trim()
  if (!token) return null

  const h = await sha256Hex(token)
  const db = createTenantDb(c.env.DB, c.get('tenant'))

  const current = await db.directories.findOne(
    and(
      eq(schema.directories.tenantId, tenantId),
      eq(schema.directories.status, 'active'),
      eq(schema.directories.scimTokenHash, h),
    ),
  )
  if (current && constantTimeEq(h, current.scimTokenHash)) return current as DirectoryRow

  const previous = await db.directories.findOne(
    and(
      eq(schema.directories.tenantId, tenantId),
      eq(schema.directories.status, 'active'),
      eq(schema.directories.scimTokenHashPrev, h),
      gt(schema.directories.scimTokenPrevExpires, new Date()),
    ),
  )
  if (previous && constantTimeEq(h, previous.scimTokenHashPrev ?? '')) {
    return previous as DirectoryRow
  }
  return null
}
