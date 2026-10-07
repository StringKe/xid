// 组织成员与邀请的查询和变更;邀请发送(含单条)统一走 bulk,逐条返回结果。

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type { OrganizationMembershipRole, XidError } from '@xid-kit/types'
import { useApiMutation, useApiQuery } from '@xid-kit/web-ui/queries'
import { useCanManageOrg } from '../org/useOrgTarget'

export type MemberRow = {
  id: string
  userId: string
  email: string
  name: string | null
  role: OrganizationMembershipRole
  status: 'active' | 'inactive'
  joinedAt: string
  lastSignInAt: string | null
  joinedThrough: 'directory_sync' | 'invitation' | 'added'
  invitedByName: string | null
}

export type MembersPage = {
  data: MemberRow[]
  next_cursor: string | null
  has_more: boolean
  total: number
  counts: { owner: number; admin: number }
}

export type InvitationRow = {
  id: string
  email: string
  role: OrganizationMembershipRole
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  invitedByUserId: string | null
  invitedByName: string | null
  expiresAt: string
  createdAt: string
}

export type InvitationsPage = { data: InvitationRow[]; next_cursor: string | null; total: number }

export type BulkInvitationResult = {
  email: string
  result: 'created' | 'already_member' | 'already_invited' | 'failed'
}

export function useMembers(
  orgId: string,
  query: { role: OrganizationMembershipRole | null; search: string; cursor: string | null },
): UseQueryResult<MembersPage, XidError> {
  const enabled = useCanManageOrg(orgId)
  const params = {
    limit: 50,
    role: query.role ?? undefined,
    search: query.search.trim() || undefined,
    cursor: query.cursor ?? undefined,
  }
  return useApiQuery<MembersPage>(
    ['organizations', orgId, 'members', params],
    `/v1/organizations/${orgId}/members`,
    { enabled, query: params, placeholderData: (previous) => previous },
  )
}

export function useInvitations(orgId: string): UseQueryResult<InvitationsPage, XidError> {
  const enabled = useCanManageOrg(orgId)
  return useApiQuery<InvitationsPage>(
    ['organizations', orgId, 'invitations', 'all-pending'],
    `/v1/organizations/${orgId}/invitations`,
    { enabled, query: { limit: 100 } },
  )
}

const membersKey = (orgId: string) => ['organizations', orgId, 'members']
const invitationsKey = (orgId: string) => ['organizations', orgId, 'invitations']

export function useInviteMembers(
  orgId: string,
): UseMutationResult<
  { data: BulkInvitationResult[] },
  XidError,
  { emails: string[]; role: OrganizationMembershipRole }
> {
  return useApiMutation<
    { data: BulkInvitationResult[] },
    { emails: string[]; role: OrganizationMembershipRole }
  >(
    (api, input) =>
      api.post(`/v1/organizations/${orgId}/invitations/bulk`, {
        invitations: input.emails.map((email) => ({ email, role: input.role })),
      }),
    { invalidate: [invitationsKey(orgId)] },
  )
}

export function useResendInvitation(orgId: string): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, id) => api.post(`/v1/organizations/${orgId}/invitations/${id}/resend`),
    { invalidate: [invitationsKey(orgId)] },
  )
}

export function useRevokeInvitation(orgId: string): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, id) => api.del(`/v1/organizations/${orgId}/invitations/${id}`),
    { invalidate: [invitationsKey(orgId)] },
  )
}

export function useChangeMemberRole(
  orgId: string,
  invalidateKey?: readonly unknown[],
): UseMutationResult<
  unknown,
  XidError,
  { membershipId: string; role: OrganizationMembershipRole }
> {
  return useApiMutation<unknown, { membershipId: string; role: OrganizationMembershipRole }>(
    (api, input) =>
      api.patch(`/v1/organizations/${orgId}/memberships/${input.membershipId}`, {
        role: input.role,
      }),
    { invalidate: [membersKey(orgId), ...(invalidateKey ? [invalidateKey] : [])] },
  )
}

export function useRemoveMember(orgId: string): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, membershipId) => api.del(`/v1/organizations/${orgId}/memberships/${membershipId}`),
    { invalidate: [membersKey(orgId)] },
  )
}
