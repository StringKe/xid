// 模拟者是 Instance Manager,通常不在被模拟用户的租户里,租户查询层查不到他。
// 这里按同一实例跨租户只读姓名与主邮箱,并显式绑定 instance_id,不会取到其他实例的用户。

import type { BrowserImpersonator } from '@xid-kit/types'

type ImpersonatorRow = {
  id: string
  displayName: string | null
  firstName: string | null
  lastName: string | null
  email: string | null
}

function displayNameOf(row: ImpersonatorRow): string | null {
  if (row.displayName) return row.displayName
  const parts = [row.firstName, row.lastName].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join(' ') : null
}

export async function loadImpersonators(
  env: Env,
  instanceId: string | undefined,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, BrowserImpersonator>> {
  const ids = [...new Set(userIds)]
  const result = new Map<string, BrowserImpersonator>(
    ids.map((userId) => [userId, { userId, displayName: null, email: null }]),
  )
  if (!instanceId || ids.length === 0) return result
  const placeholders = ids.map(() => '?').join(', ')
  const rows = await env.DB.prepare(
    `SELECT u.id AS id,
            u.display_name AS displayName,
            u.first_name AS firstName,
            u.last_name AS lastName,
            e.email AS email
       FROM users u
       LEFT JOIN user_emails e
         ON e.tenant_id = u.tenant_id
        AND e.id = u.primary_email_id
      WHERE u.id IN (${placeholders})
        AND EXISTS (
          SELECT 1 FROM organizations o
           WHERE o.tenant_id = u.tenant_id
             AND o.instance_id = ?
        )`,
  )
    .bind(...ids, instanceId)
    .all<ImpersonatorRow>()
  for (const row of rows.results) {
    result.set(row.id, { userId: row.id, displayName: displayNameOf(row), email: row.email })
  }
  return result
}
