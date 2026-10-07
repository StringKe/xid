// 侧栏导航的纯函数:可见项过滤、激活判定、链接参数、分组与文案解析。

import type { I18n } from '@lingui/core'
import type { AuthOrg } from '@xid-kit/web-ui/session'
import type { ConsoleNavItem, NavLabel } from '../../nav'
import { MANAGED_PROJECTS_NAV_ITEM } from '../../nav'

export function navLabelText(i18n: I18n, label: NavLabel): string {
  return typeof label === 'string' ? label : i18n._(label)
}

export function navItemActive(pathname: string, item: ConsoleNavItem): boolean {
  if (item.end) return pathname === item.to
  return pathname === item.to || pathname.startsWith(`${item.to}/`)
}

// 只透传 orgId,勿把列表页 cursor/filter 带到下一页。
export function navItemTo(item: Pick<ConsoleNavItem, 'to'>, search: string): string {
  if (!item.to.startsWith('/console/org')) return item.to
  const match = /(?:^|&)orgId=([^&]*)/.exec(search.startsWith('?') ? search.slice(1) : search)
  return match ? `${item.to}?orgId=${match[1]}` : item.to
}

export function isPlatformNav(items: readonly ConsoleNavItem[]): boolean {
  return items.some((item) => item.to === '/console/platform' && item.end)
}

// 租户级资源只对顶层组织显示;受托项目入口只在有 manager assignment 时出现。
export function visibleNavItems(input: {
  navItems: readonly ConsoleNavItem[]
  activeOrg: AuthOrg | null
  hasManagerAssignments: boolean
}): readonly ConsoleNavItem[] {
  const scoped = input.navItems.filter(
    (item) => !item.tenantScope || input.activeOrg?.parentOrgId === null,
  )
  const listsManagedProjects = scoped.some((item) => item.to === MANAGED_PROJECTS_NAV_ITEM.to)
  if (!input.hasManagerAssignments) {
    return scoped.filter((item) => item.to !== MANAGED_PROJECTS_NAV_ITEM.to)
  }
  return listsManagedProjects ? scoped : [...scoped, MANAGED_PROJECTS_NAV_ITEM]
}

export type NavSegment = {
  key: string | null
  label: NavLabel | null
  items: readonly ConsoleNavItem[]
}

// 相邻相同 groupKey 合并为段;无 key 的项各自独段。
export function segmentNavItems(items: readonly ConsoleNavItem[]): readonly NavSegment[] {
  const segments: NavSegment[] = []
  for (const item of items) {
    const last = segments[segments.length - 1]
    if (last && last.key !== null && last.key === item.groupKey) {
      segments[segments.length - 1] = { ...last, items: [...last.items, item] }
    } else {
      segments.push({ key: item.groupKey ?? null, label: item.groupLabel ?? null, items: [item] })
    }
  }
  return segments
}

// 首字母方块的字母取自原始 name/slug/email,不取 displayName。
export function firstLetter(value: string | null | undefined): string {
  const letter = value?.trim().charAt(0)
  return letter ? letter.toUpperCase() : '?'
}

export function initials(value: string | null | undefined): string {
  const words = (value ?? '')
    .trim()
    .split(/[\s@._-]+/)
    .filter(Boolean)
  const letters = words.slice(0, 2).map((word) => word.charAt(0).toUpperCase())
  return letters.join('') || '?'
}
