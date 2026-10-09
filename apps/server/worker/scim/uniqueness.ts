// 目录内唯一性(RFC 7643 userName caseExact=false,externalId caseExact=true):
// 只在未删除的资源之间判断,与 0024 的部分唯一索引一致。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, ne, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

type TenantDb = ReturnType<typeof createTenantDb>

// 字面量谓词与部分索引的 WHERE 一致,SQLite 才能选用这些索引;绑定参数无法证明蕴含关系。
export const LIVE_DIRECTORY_USER = sql`${schema.directoryUsers.status} <> 'deleted' AND ${schema.directoryUsers.deletedAt} IS NULL`
export const LIVE_DIRECTORY_GROUP = sql`${schema.directoryGroups.status} <> 'deleted' AND ${schema.directoryGroups.deletedAt} IS NULL`

// 未给出的属性不检查
type UserIdentity = { userName?: string; externalId?: string | null }

function excludeSelf(
  column: typeof schema.directoryUsers.id,
  id: string | undefined,
): SQL | undefined {
  return id === undefined ? undefined : ne(column, id)
}

// 返回冲突的属性名,无冲突返回 null。
export async function directoryUserConflict(
  db: TenantDb,
  scope: { directoryId: string; excludeId?: string },
  identity: UserIdentity,
): Promise<'userName' | 'externalId' | null> {
  const live = and(
    eq(schema.directoryUsers.directoryId, scope.directoryId),
    LIVE_DIRECTORY_USER,
    excludeSelf(schema.directoryUsers.id, scope.excludeId),
  )
  if (identity.userName !== undefined) {
    const sameName = await db.directoryUsers.findOne(
      and(live, sql`lower(${schema.directoryUsers.userName}) = lower(${identity.userName})`),
    )
    if (sameName) return 'userName'
  }
  if (identity.externalId === undefined || identity.externalId === null) return null
  const sameExternal = await db.directoryUsers.findOne(
    and(live, eq(schema.directoryUsers.externalId, identity.externalId)),
  )
  return sameExternal ? 'externalId' : null
}

export async function directoryGroupNameTaken(
  db: TenantDb,
  scope: { directoryId: string; excludeId?: string },
  displayName: string,
): Promise<boolean> {
  const found = await db.directoryGroups.findOne(
    and(
      eq(schema.directoryGroups.directoryId, scope.directoryId),
      LIVE_DIRECTORY_GROUP,
      scope.excludeId === undefined ? undefined : ne(schema.directoryGroups.id, scope.excludeId),
      sql`lower(${schema.directoryGroups.displayName}) = lower(${displayName})`,
    ),
  )
  return found !== undefined
}
