// 出站 SAML persistent NameID 的持久化映射:(tenant, SP, user) 首次签发时生成随机值,之后一直复用。
// 并发首签用 INSERT ... ON CONFLICT DO NOTHING 后读回,两个请求拿到同一个值。

import { createTenantDb, schema } from '@xid-kit/db'
import type { TenantContext } from '@xid-kit/types'
import { and, eq } from 'drizzle-orm'
import { AppError } from '../lib/errors'
import { randomOpaqueNameId } from './outbound-saml-name-id'

export async function resolvePersistentNameId(
  db: D1Database,
  tenant: TenantContext,
  input: { spId: string; userId: string; now?: number },
): Promise<string> {
  // UPSERT 无法经 scoped accessor 表达,raw SQL 显式绑定 tenant_id。
  await db
    .prepare(
      `INSERT INTO saml_persistent_name_ids (tenant_id, sp_id, user_id, name_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .bind(tenant.tenantId, input.spId, input.userId, randomOpaqueNameId(), input.now ?? Date.now())
    .run()
  const row = await createTenantDb(db, tenant).samlPersistentNameIds.findOne(
    and(
      eq(schema.samlPersistentNameIds.spId, input.spId),
      eq(schema.samlPersistentNameIds.userId, input.userId),
    ),
  )
  if (!row) {
    throw new AppError('server_error', { cause: new Error('persistent NameID mapping missing') })
  }
  return row.nameId
}
