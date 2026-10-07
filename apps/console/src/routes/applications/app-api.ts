// /v1/applications 的查询与变更,以及按授权方式、grant 推断出的应用类型。

import { useQueries } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type { XidError } from '@xid-kit/types'
import { useApiMutation, useApiQuery } from '@xid-kit/web-ui/queries'
import { useSession } from '@xid-kit/web-ui/session'

export type AppRecord = {
  id: string
  name: string
  logo_uri: string | null
  project_id: string | null
  application_type: 'web' | 'native' | null
  client_id: string
  client_type: 'confidential' | 'public'
  token_endpoint_auth_method: string
  redirect_uris: string[]
  post_logout_redirect_uris: string[]
  allowed_grant_types: string[]
  allowed_scopes: string[]
  require_pkce: boolean
  access_token_ttl_sec: number | null
  first_party: boolean
  require_org_context: boolean
  backchannel_logout_uri: string | null
  backchannel_logout_session_required: boolean
  frontchannel_logout_uri: string | null
  status: 'active' | 'deleted'
  created_at: string
  updated_at: string
}

export type AppKind = 'web' | 'spa' | 'native' | 'machine' | 'device'

export function appKind(
  app: Pick<AppRecord, 'allowed_grant_types' | 'client_type' | 'application_type'>,
): AppKind {
  const grants = app.allowed_grant_types
  if (grants.includes('client_credentials') && !grants.includes('authorization_code'))
    return 'machine'
  if (
    grants.includes('urn:ietf:params:oauth:grant-type:device_code') &&
    !grants.includes('authorization_code')
  ) {
    return 'device'
  }
  if (app.client_type === 'confidential') return 'web'
  return app.application_type === 'native' ? 'native' : 'spa'
}

type Page<T> = { data: T[]; next_cursor: string | null; has_more: boolean }

export function useApplications({
  projectId,
  enabled = true,
}: { projectId?: string; enabled?: boolean } = {}): UseQueryResult<Page<AppRecord>, XidError> {
  return useApiQuery<Page<AppRecord>>(
    ['applications', 'list', projectId ?? null],
    '/v1/applications',
    {
      enabled,
      query: { limit: 100, ...(projectId ? { project_id: projectId } : {}) },
    },
  )
}

export function useApplication(id: string): UseQueryResult<AppRecord, XidError> {
  return useApiQuery<AppRecord>(['applications', id], `/v1/applications/${id}`, {
    enabled: id.length > 0,
  })
}

// 项目名按 id 逐个解析;无权读取的项目回落为 id。
export function useProjectNames(projectIds: readonly string[]): Map<string, string> {
  const { api } = useSession()
  const ids = [...new Set(projectIds)]
  const results = useQueries({
    queries: ids.map((projectId) => ({
      queryKey: ['managed-projects', projectId, 'nav-name'],
      queryFn: async () => {
        const result = await api.get<{ data: { id: string; name: string }[] }>('/v1/projects', {
          query: { project_id: projectId, status: 'active', limit: 1 },
        })
        if (!result.ok) throw result.error
        return result.value
      },
      staleTime: 60_000,
      retry: false,
    })),
  })
  const names = new Map<string, string>()
  ids.forEach((id, index) => {
    const name = results[index]?.data?.data[0]?.name
    if (name) names.set(id, name)
  })
  return names
}

export type CreateAppInput = {
  name: string
  project_id?: string
  client_type: 'confidential' | 'public'
  application_type?: 'web' | 'native'
  token_endpoint_auth_method?: string
  allowed_grant_types?: string[]
  redirect_uris: string[]
}

export type CreatedApp = AppRecord & { client_secret?: string }

export function useCreateApplication(): UseMutationResult<CreatedApp, XidError, CreateAppInput> {
  return useApiMutation<CreatedApp, CreateAppInput>(
    (api, body) => api.post('/v1/applications', body),
    {
      invalidate: [['applications']],
    },
  )
}

export type UpdateAppInput = Partial<{
  name: string
  logo_uri: string | null
  project_id: string | null
  redirect_uris: string[]
  post_logout_redirect_uris: string[]
  allowed_grant_types: string[]
  access_token_ttl_sec: number | null
  backchannel_logout_uri: string | null
  backchannel_logout_session_required: boolean
  frontchannel_logout_uri: string | null
  first_party: boolean
}>

export function useUpdateApplication(
  id: string,
): UseMutationResult<AppRecord, XidError, UpdateAppInput> {
  return useApiMutation<AppRecord, UpdateAppInput>(
    (api, body) => api.patch(`/v1/applications/${id}`, body),
    {
      invalidate: [['applications']],
    },
  )
}

export function useRotateSecret(
  id: string,
): UseMutationResult<{ client_secret: string }, XidError, void> {
  return useApiMutation<{ client_secret: string }, void>((api) =>
    api.post(`/v1/applications/${id}/rotate-secret`),
  )
}

export function useDeleteApplication(id: string): UseMutationResult<unknown, XidError, void> {
  return useApiMutation<unknown, void>((api) => api.del(`/v1/applications/${id}`), {
    invalidate: [['applications']],
  })
}
