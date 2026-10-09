// 每日任务共用的租户分页:按 id 顺序遍历 active 顶层组织(tenant)。

const TENANT_PAGE_SIZE = 50

export async function eachActiveTenant(
  env: Env,
  visit: (tenantId: string) => Promise<void>,
): Promise<void> {
  let cursor: string | null = null
  while (true) {
    const where: string = cursor === null ? '' : 'AND id > ?'
    const params: unknown[] = cursor === null ? [TENANT_PAGE_SIZE] : [cursor, TENANT_PAGE_SIZE]
    const tenants: D1Result<{ tenant_id: string }> = await env.DB.prepare(
      `SELECT id AS tenant_id FROM organizations
         WHERE status = 'active' AND parent_org_id IS NULL ${where}
         ORDER BY id
         LIMIT ?`,
    )
      .bind(...params)
      .all<{ tenant_id: string }>()
    if (tenants.results.length === 0) break
    for (const { tenant_id } of tenants.results) {
      await visit(tenant_id)
    }
    cursor = tenants.results[tenants.results.length - 1]?.tenant_id ?? null
    if (tenants.results.length < TENANT_PAGE_SIZE) break
  }
}
