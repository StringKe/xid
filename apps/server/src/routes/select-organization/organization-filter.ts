// 组织列表的客户端过滤:名称或 slug 包含关键字,按名称排序,最多显示 20 个。

export const VISIBLE_ORGANIZATION_LIMIT = 20

export function filterOrganizations<T extends { name: string; slug: string }>(
  organizations: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLocaleLowerCase()
  return organizations
    .filter(
      (org) =>
        needle === '' ||
        org.name.toLocaleLowerCase().includes(needle) ||
        org.slug.toLocaleLowerCase().includes(needle),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, VISIBLE_ORGANIZATION_LIMIT)
}
