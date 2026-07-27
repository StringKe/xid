// org 管理路由具体 hooks。复用 useApiGet;各 hook 封装端点路径。
// cursor 分页:调用方维护 cursor state,变化时传入新 cursor。

import { useApiGet } from './useApiGet'
import type { ApiGetState } from './useApiGet'
import type {
  OrgBranding,
  OrgDomain,
  OrgInvitation,
  OrgMember,
  OrgRole,
  Page,
  ScimDirectory,
  SsoConnection,
} from './types'

export type { ApiGetState }

export function useOrgMembers(
  orgId: string,
  cursor?: string,
): ApiGetState<Page<OrgMember>> & { reload: () => void } {
  const params = new URLSearchParams({ limit: '20' })
  if (cursor) params.set('cursor', cursor)
  return useApiGet<Page<OrgMember>>(`/v1/organizations/${orgId}/members?${params}`, !orgId)
}

export function useOrgInvitations(
  orgId: string,
  cursor?: string,
): ApiGetState<Page<OrgInvitation>> & { reload: () => void } {
  const params = new URLSearchParams({ limit: '20' })
  if (cursor) params.set('cursor', cursor)
  return useApiGet<Page<OrgInvitation>>(`/v1/organizations/${orgId}/invitations?${params}`, !orgId)
}

export function useOrgRoles(orgId: string): ApiGetState<OrgRole[]> & { reload: () => void } {
  return useApiGet<OrgRole[]>(`/v1/organizations/${orgId}/roles`, !orgId)
}

export function useOrgSsoConnections(
  orgId: string,
): ApiGetState<SsoConnection[]> & { reload: () => void } {
  return useApiGet<SsoConnection[]>(`/v1/organizations/${orgId}/sso-connections`, !orgId)
}

export function useOrgScimDirectories(
  orgId: string,
): ApiGetState<ScimDirectory[]> & { reload: () => void } {
  return useApiGet<ScimDirectory[]>(`/v1/organizations/${orgId}/directories`, !orgId)
}

export function useOrgDomains(orgId: string): ApiGetState<OrgDomain[]> & { reload: () => void } {
  return useApiGet<OrgDomain[]>(`/v1/organizations/${orgId}/domains`, !orgId)
}

export function useOrgBranding(orgId: string): ApiGetState<OrgBranding> & { reload: () => void } {
  return useApiGet<OrgBranding>(`/v1/organizations/${orgId}/branding`, !orgId)
}
