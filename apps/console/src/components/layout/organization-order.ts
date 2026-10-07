type HierarchyOrg = {
  id: string
  name: string
  slug: string
  parentOrgId: string | null
}

function byName(a: HierarchyOrg, b: HierarchyOrg): number {
  return (a.name || a.slug).localeCompare(b.name || b.slug)
}

// 父组织在前、各自的子组织紧随其后;父组织不在列表里的子组织按顶层处理。
export function orderByHierarchy<T extends HierarchyOrg>(organizations: readonly T[]): T[] {
  const ids = new Set(organizations.map((org) => org.id))
  const isRoot = (org: T) => org.parentOrgId === null || !ids.has(org.parentOrgId)
  const childrenOf = (parentId: string) =>
    organizations.filter((org) => org.parentOrgId === parentId && !isRoot(org)).sort(byName)
  const ordered: T[] = []
  const visit = (org: T) => {
    ordered.push(org)
    for (const child of childrenOf(org.id)) visit(child)
  }
  for (const root of organizations.filter(isRoot).sort(byName)) visit(root)
  return ordered
}
