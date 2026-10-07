// 项目详情用到的查询与变更。项目经理只看到被委派的项目,接口仍按 project-access 授权。

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type { XidError } from '@xid-kit/types'
import { useApiMutation, useApiQuery } from '@xid-kit/web-ui/queries'

export type ProjectRecord = {
  id: string
  org_id: string
  name: string
  description: string | null
  status: 'active' | 'deleted'
  access_policy: 'open' | 'restricted' | 'approval_required'
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export type ProjectUserGrant = {
  id: string
  user_id: string
  role_id: string
  role_key: string | null
  role_name: string | null
  granted_via: 'direct' | 'project_grant'
  created_at: string
}

type Page<T> = { data: T[]; next_cursor: string | null; has_more: boolean }

const projectKey = (projectId: string) => ['managed-projects', projectId]

export function useProject(projectId: string): UseQueryResult<ProjectRecord | null, XidError> {
  const query = useApiQuery<Page<ProjectRecord>>(
    [...projectKey(projectId), 'detail'],
    '/v1/projects',
    {
      enabled: projectId.length > 0,
      query: { project_id: projectId, status: 'all', limit: 1 },
    },
  )
  return {
    ...query,
    data: query.data ? (query.data.data[0] ?? null) : undefined,
  } as UseQueryResult<ProjectRecord | null, XidError>
}

export type ProjectPatch = {
  name?: string
  description?: string | null
  access_policy?: 'open' | 'restricted'
}

export function useUpdateProjectRecord(
  projectId: string,
): UseMutationResult<ProjectRecord, XidError, ProjectPatch> {
  return useApiMutation<ProjectRecord, ProjectPatch>(
    (api, body) => api.patch(`/v1/projects/${projectId}`, body),
    {
      invalidate: [projectKey(projectId), ['organizations']],
    },
  )
}

export function useProjectLifecycle(projectId: string): {
  remove: UseMutationResult<unknown, XidError, void>
  restore: UseMutationResult<unknown, XidError, void>
} {
  const invalidate = [projectKey(projectId), ['organizations'], ['me']]
  return {
    remove: useApiMutation<unknown, void>((api) => api.del(`/v1/projects/${projectId}`), {
      invalidate,
    }),
    restore: useApiMutation<unknown, void>(
      (api) => api.post(`/v1/projects/${projectId}/restore`, {}),
      {
        invalidate,
      },
    ),
  }
}

export function useProjectUserGrants(
  projectId: string,
): UseQueryResult<Page<ProjectUserGrant>, XidError> {
  return useApiQuery<Page<ProjectUserGrant>>(
    [...projectKey(projectId), 'user-grants'],
    '/v1/user-grants',
    {
      enabled: projectId.length > 0,
      query: { project_id: projectId, limit: 100 },
    },
  )
}

export function useGiveRole(
  projectId: string,
): UseMutationResult<unknown, XidError, { user_id: string; role_id: string }> {
  return useApiMutation<unknown, { user_id: string; role_id: string }>(
    (api, body) => api.post('/v1/user-grants', { ...body, project_id: projectId }),
    { invalidate: [[...projectKey(projectId), 'user-grants']] },
  )
}

export function useTakeRole(projectId: string): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>((api, id) => api.del(`/v1/user-grants/${id}`), {
    invalidate: [[...projectKey(projectId), 'user-grants']],
  })
}
