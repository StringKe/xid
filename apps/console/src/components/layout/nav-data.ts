// 侧栏用到的远程数据:Users / Members 计数,与只有项目委派的用户看到的项目入口(带项目名)。

import { useQueries } from '@tanstack/react-query'
import type { BrowserManagerAssignment } from '@xid-kit/types'
import { useApiQuery } from '@xid-kit/web-ui/queries'
import { useSession } from '@xid-kit/web-ui/session'
import type { AuthOrg } from '@xid-kit/web-ui/session'
import { isOrgManagerRole } from '@xid-kit/web-ui/org-route-access'
import { msg } from '@lingui/core/macro'
import type { ConsoleNavItem } from '../../nav'
import { ORG_MEMBERS_PATH, ORG_USERS_PATH } from '../../nav'

const COUNT_STALE_MS = 60_000

export function useNavCounts(
  activeOrg: AuthOrg | null,
  items: readonly ConsoleNavItem[],
): Record<string, number | undefined> {
  const manages = activeOrg !== null && isOrgManagerRole(activeOrg.role)
  const showsUsers = manages && items.some((item) => item.to === ORG_USERS_PATH)
  const showsMembers = manages && items.some((item) => item.to === ORG_MEMBERS_PATH)
  const users = useApiQuery<{ total?: number }>(['users', 'nav-count'], '/v1/users', {
    enabled: showsUsers,
    query: { limit: 1 },
    staleTime: COUNT_STALE_MS,
  })
  const orgId = activeOrg?.id ?? ''
  const members = useApiQuery<{ total?: number }>(
    ['organizations', orgId, 'members', 'nav-count'],
    `/v1/organizations/${orgId}/members`,
    { enabled: showsMembers, query: { limit: 1 }, staleTime: COUNT_STALE_MS },
  )
  return {
    [ORG_USERS_PATH]: showsUsers ? users.data?.total : undefined,
    [ORG_MEMBERS_PATH]: showsMembers ? members.data?.total : undefined,
  }
}

type ProjectPage = { data: { id: string; name: string }[] }

// 项目经理委派:每个被委派的 active 项目一项,放在 Applications 分组下。
export function useDelegatedProjectItems(
  assignments: readonly BrowserManagerAssignment[],
): readonly ConsoleNavItem[] {
  const { api } = useSession()
  const projectIds = assignments
    .filter((item) => item.managerRole === 'project_manager' && item.scopeStatus === 'active')
    .map((item) => item.scopeId)
  const results = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ['managed-projects', projectId, 'nav-name'],
      queryFn: async () => {
        const result = await api.get<ProjectPage>('/v1/projects', {
          query: { project_id: projectId, status: 'active', limit: 1 },
        })
        if (!result.ok) throw result.error
        return result.value
      },
      staleTime: COUNT_STALE_MS,
    })),
  })
  return projectIds.map((projectId, index) => ({
    to: `/console/org/projects/${projectId}`,
    label: results[index]?.data?.data[0]?.name ?? projectId,
    groupKey: 'applications',
    groupLabel: msg`Applications`,
  }))
}
