// 平台组织、用户与实例管理员的读写 hook 与类型。列表用游标栈做上一页 / 下一页,
// query key 都挂在已有的平台前缀下,原有失效规则继续命中。

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type {
  GlobalUser,
  InstanceManagerAssignment,
  OrganizationMembershipRole,
  PlatformOrganization,
  PlatformOrganizationStatus,
  PlatformPage,
  XidError,
} from '@xid-kit/types'
import { queryKeyPrefixes, useApiMutation, useApiQuery } from '@xid-kit/web-ui/queries'

export type PlatformOrganizationListItem = PlatformOrganization & {
  primaryHost: string | null
  mauThisMonth: number
  mauQuota: number | null
  statusChangedAt: string | null
}

export type PlatformOrganizationCounts = {
  total: number
  suspended: number
  deleted: number
}

export type PlatformOrganizationsPage = PlatformPage<PlatformOrganizationListItem> & {
  counts: PlatformOrganizationCounts
}

export type PlatformPersonRef = {
  userId: string
  name: string | null
  email: string | null
}

export type PlatformOrganizationDetail = PlatformOrganizationListItem & {
  customHostname: { hostname: string; status: string } | null
  owner: PlatformPersonRef | null
  subOrganizationCount: number
  selfServiceAllowed: boolean
  createdBy: PlatformPersonRef | null
  seatLimit: number | null
  seatsUsed: number
  auditEntryCount: number
}

export type PlatformOrganizationMember = {
  id: string
  user: PlatformPersonRef
  role: OrganizationMembershipRole
  joinedAt: string | null
  organizationId: string
  organizationName: string
}

export type PlatformOrganizationDomain = {
  id: string
  domain: string
  organizationId: string
  verified: boolean
  verifiedAt: string | null
  createdAt: string
}

export type PlatformUserListItem = GlobalUser & {
  lastSignInAt: string | null
  tenantId: string
  organizationName: string | null
  organizationStatus: PlatformOrganizationStatus
}

export type PlatformManagerAssignment = InstanceManagerAssignment & {
  grantedBy: { userId: string; displayName: string | null; email: string | null } | null
  lastActiveAt: string | null
}

export type OrganizationListFilters = {
  q: string
  status: PlatformOrganizationStatus | null
}

export type UserListFilters = {
  q: string
  organizationId: string | null
  status: GlobalUser['status'] | null
}

export const ORGANIZATIONS_PAGE_SIZE = 10
export const USERS_PAGE_SIZE = 50

export function usePlatformOrganizationsPage(
  filters: OrganizationListFilters,
  cursor: string | null,
): UseQueryResult<PlatformOrganizationsPage, XidError> {
  return useApiQuery<PlatformOrganizationsPage>(
    [...queryKeyPrefixes.platformOrganizations, 'page', filters, cursor],
    '/v1/platform/organizations',
    {
      placeholderData: (previous) => previous,
      query: {
        limit: ORGANIZATIONS_PAGE_SIZE,
        sort: 'mau_desc',
        q: filters.q || undefined,
        status: filters.status ?? undefined,
        cursor: cursor ?? undefined,
      },
    },
  )
}

export function usePlatformOrganizationDetail(
  organizationId: string,
): UseQueryResult<PlatformOrganizationDetail, XidError> {
  return useApiQuery<PlatformOrganizationDetail>(
    [...queryKeyPrefixes.platformOrganizations, 'detail', organizationId],
    `/v1/platform/organizations/${encodeURIComponent(organizationId)}`,
    { enabled: organizationId.length > 0 },
  )
}

export function usePlatformOrganizationMembers(
  organizationId: string,
  cursor: string | null,
  enabled: boolean,
): UseQueryResult<PlatformPage<PlatformOrganizationMember>, XidError> {
  return useApiQuery<PlatformPage<PlatformOrganizationMember>>(
    [...queryKeyPrefixes.platformOrganizations, 'members', organizationId, cursor],
    `/v1/platform/organizations/${encodeURIComponent(organizationId)}/members`,
    {
      enabled,
      placeholderData: (previous) => previous,
      query: { limit: USERS_PAGE_SIZE, cursor: cursor ?? undefined },
    },
  )
}

export function usePlatformOrganizationDomains(
  organizationId: string,
  enabled: boolean,
): UseQueryResult<PlatformPage<PlatformOrganizationDomain>, XidError> {
  return useApiQuery<PlatformPage<PlatformOrganizationDomain>>(
    [...queryKeyPrefixes.platformOrganizations, 'domains', organizationId],
    `/v1/platform/organizations/${encodeURIComponent(organizationId)}/domains`,
    { enabled, query: { limit: 100 } },
  )
}

export type CreateOrganizationInput = {
  name: string
  slug: string
  ownerEmail: string
}

export function useCreatePlatformOrganization(): UseMutationResult<
  PlatformOrganizationListItem,
  XidError,
  CreateOrganizationInput
> {
  return useApiMutation<PlatformOrganizationListItem, CreateOrganizationInput>(
    (api, body) => api.post<PlatformOrganizationListItem>('/v1/platform/organizations', body),
    { invalidate: [queryKeyPrefixes.platformOrganizations] },
  )
}

export type OrganizationStatusChange = {
  organizationId: string
  status: PlatformOrganizationStatus
  confirmSlug?: string
}

export function useChangePlatformOrganizationStatus(): UseMutationResult<
  PlatformOrganizationListItem,
  XidError,
  OrganizationStatusChange
> {
  return useApiMutation<PlatformOrganizationListItem, OrganizationStatusChange>(
    (api, { organizationId, ...body }) =>
      api.patch<PlatformOrganizationListItem>(
        `/v1/platform/organizations/${encodeURIComponent(organizationId)}`,
        body,
      ),
    { invalidate: [queryKeyPrefixes.platformOrganizations, queryKeyPrefixes.platformUsers] },
  )
}

export function usePlatformUsersPage(
  filters: UserListFilters,
  cursor: string | null,
): UseQueryResult<PlatformPage<PlatformUserListItem>, XidError> {
  return useApiQuery<PlatformPage<PlatformUserListItem>>(
    [...queryKeyPrefixes.platformUsers, 'page', filters, cursor],
    '/v1/platform/users',
    {
      placeholderData: (previous) => previous,
      query: {
        limit: USERS_PAGE_SIZE,
        q: filters.q || undefined,
        organizationId: filters.organizationId ?? undefined,
        status: filters.status ?? undefined,
        cursor: cursor ?? undefined,
      },
    },
  )
}

export function usePlatformManagerAssignments(): UseQueryResult<
  PlatformPage<PlatformManagerAssignment>,
  XidError
> {
  return useApiQuery<PlatformPage<PlatformManagerAssignment>>(
    [...queryKeyPrefixes.platformManagerAssignments, 'all'],
    '/v1/platform/manager-assignments',
    { query: { limit: 100 } },
  )
}

export function useGrantInstanceManager(): UseMutationResult<
  PlatformManagerAssignment,
  XidError,
  { organization_id: string; email: string }
> {
  return useApiMutation<PlatformManagerAssignment, { organization_id: string; email: string }>(
    (api, body) => api.post<PlatformManagerAssignment>('/v1/platform/manager-assignments', body),
    { invalidate: [queryKeyPrefixes.platformManagerAssignments] },
  )
}

export function useRevokeInstanceManager(): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, assignmentId) =>
      api.del<unknown>(`/v1/platform/manager-assignments/${encodeURIComponent(assignmentId)}`),
    { invalidate: [queryKeyPrefixes.platformManagerAssignments] },
  )
}
