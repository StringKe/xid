// Cmd/Ctrl+K 命令菜单:跳转到可见页面;顶层组织管理员还可按姓名、邮箱、手机号或 ID 检索用户,
// 并按名称或 client ID 检索应用。只用现有接口(/v1/users?search=、/v1/applications)。

import { useLingui } from '@lingui/react/macro'
import { useDeferredValue, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { useApiQuery } from '@xid-kit/web-ui/queries'
import { CommandMenu, type CommandGroup } from '@xid-kit/web-ui/ui'
import type { ConsoleNavItem } from '../../nav'
import { ORG_APPLICATIONS_PATH, ORG_USERS_PATH } from '../../nav'
import { navItemTo, navLabelText } from './nav-model'

type SearchUser = {
  id: string
  firstName: string | null
  lastName: string | null
  displayName: string | null
  username: string | null
  primaryEmail: string | null
  primaryPhone: string | null
}

type SearchApplication = { id: string; name: string; client_id: string }

const MIN_QUERY_LENGTH = 2

function userName(user: SearchUser): string {
  return (
    user.displayName ??
    ([user.firstName, user.lastName].filter(Boolean).join(' ') ||
      user.username ||
      user.primaryEmail ||
      user.primaryPhone ||
      user.id)
  )
}

export type ConsoleCommandMenuProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  navItems: readonly ConsoleNavItem[]
  search: string
}

export function ConsoleCommandMenu({
  open,
  onOpenChange,
  navItems,
  search,
}: ConsoleCommandMenuProps): ReactNode {
  const { t, i18n } = useLingui()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query.trim())
  const canSearchUsers = navItems.some((item) => item.to === ORG_USERS_PATH)
  const canSearchApps = navItems.some((item) => item.to === ORG_APPLICATIONS_PATH)
  const users = useApiQuery<{ data: SearchUser[] }>(
    ['users', 'command-search', deferred],
    '/v1/users',
    {
      enabled: open && canSearchUsers && deferred.length >= MIN_QUERY_LENGTH,
      query: { search: deferred, limit: 5 },
      staleTime: 30_000,
    },
  )
  const applications = useApiQuery<{ data: SearchApplication[] }>(
    ['applications', 'command-search'],
    '/v1/applications',
    { enabled: open && canSearchApps, query: { limit: 100 }, staleTime: 60_000 },
  )

  const go = (path: string) => navigate(navItemTo({ to: path }, search))
  const groups: CommandGroup[] = [
    {
      label: t`Pages`,
      items: navItems.map((item) => ({
        id: `page:${item.to}`,
        label: navLabelText(i18n, item.label),
        keywords: item.groupLabel ? [navLabelText(i18n, item.groupLabel)] : [],
        onSelect: () => go(item.to),
      })),
    },
  ]
  const foundUsers = users.data?.data ?? []
  if (foundUsers.length > 0) {
    groups.push({
      label: t`Users`,
      items: foundUsers.map((user) => ({
        id: `user:${user.id}`,
        label: userName(user),
        description: user.primaryEmail ?? user.primaryPhone ?? user.id,
        keywords: [deferred, user.id, user.primaryEmail ?? '', user.primaryPhone ?? ''],
        onSelect: () => go(`${ORG_USERS_PATH}/${user.id}`),
      })),
    })
  }
  const foundApps = applications.data?.data ?? []
  if (foundApps.length > 0) {
    groups.push({
      label: t`Applications`,
      items: foundApps.map((app) => ({
        id: `app:${app.id}`,
        label: app.name,
        description: app.client_id,
        keywords: [app.client_id, app.id],
        onSelect: () => go(`${ORG_APPLICATIONS_PATH}/${app.id}`),
      })),
    })
  }

  return (
    <CommandMenu
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery('')
        onOpenChange(next)
      }}
      groups={groups}
      placeholder={t`Search users, apps, or jump to a page`}
      onQueryChange={setQuery}
    />
  )
}
