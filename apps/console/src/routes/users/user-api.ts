// /v1/users 与 /v1/sessions 的 Console 查询和变更。读请求只在顶层组织管理员身份确认后发出。

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type { OrganizationMembershipRole, XidError } from '@xid-kit/types'
import { useApiMutation, useApiQuery } from '@xid-kit/web-ui/queries'
import { useAuth } from '@xid-kit/web-ui/session'
import { isOrgManagerRole } from '@xid-kit/web-ui/org-route-access'
import type { UserFilters } from './user-filters'
import { userFilterQuery } from './user-filters'

export type UserStatus = 'active' | 'banned' | 'deleted'

export type SignInMethod = {
  type: 'password' | 'passkey' | 'social' | 'sso' | 'guest'
  provider?: string
}

export type ConsoleUser = {
  id: string
  username: string | null
  externalId: string | null
  firstName: string | null
  lastName: string | null
  displayName: string | null
  locale: string | null
  timezone: string | null
  publicMetadata: Record<string, unknown>
  privateMetadata: Record<string, unknown>
  unsafeMetadata: Record<string, unknown>
  status: UserStatus
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

export type UserListRow = ConsoleUser & {
  primaryEmail: string | null
  primaryPhone: string | null
  signInMethods: SignInMethod[]
  organizations: { id: string; name: string }[]
}

export type UserCounts = { active: number; banned: number; deleted: number; guest: number }

export type UserListPage = {
  data: UserListRow[]
  next_cursor: string | null
  has_more: boolean
  total: number
  counts: UserCounts
}

export type UserSource = 'directory_sync' | 'sso' | 'self_signup' | 'guest' | 'admin'

export type UserDetail = ConsoleUser & {
  isGuest: boolean
  source: UserSource
  emails: { id: string; email: string; verified: boolean; isPrimary: boolean }[]
  phones: { id: string; phone: string; verified: boolean; isPrimary: boolean }[]
}

export type UserSignInMethods = {
  hasPassword: boolean
  passwordUpdatedAt: string | null
  passkeys: {
    id: string
    deviceName: string | null
    deviceType: string
    backedUp: boolean
    lastUsedAt: string | null
    createdAt: string
  }[]
  mfaFactors: {
    id: string
    type: string
    status: string
    lastUsedAt: string | null
    createdAt: string
  }[]
  backupCodesRemaining: number
  identities: {
    id: string
    type: 'social' | 'sso'
    provider: string | null
    providerUserId: string | null
    lastUsedAt: string | null
    createdAt: string
  }[]
}

export type UserMembership = {
  id: string
  orgId: string
  organizationName: string | null
  organizationSlug: string | null
  parentOrgId: string | null
  role: OrganizationMembershipRole
  status: 'active' | 'inactive'
  joinedAt: string
}

export type UserGrantRow = {
  id: string
  project_id: string
  role_id: string
  role_key: string | null
  role_name: string | null
  project_name: string | null
  granted_via: 'direct' | 'project_grant'
  created_at: string
}

export type UserSession = {
  id: string
  userAgent: string | null
  location: string | null
  ip: string | null
  isImpersonation: boolean
  impersonatorDisplayName: string | null
  amr: string[] | null
  authenticatedAt: string
  lastActiveAt: string
  expiresAt: string
}

export type UserAuditEvent = {
  id: string
  eventType: string
  actorId: string | null
  actorName: string | null
  actorIp: string | null
  targetType: string | null
  targetId: string | null
  meta: Record<string, unknown>
  occurredAt: string
}

type Page<T> = { data: T[]; next_cursor: string | null; has_more: boolean }

// 用户目录是租户级资源:只有顶层组织的 owner / admin(或 org_manager)才能读。
export function useCanReadUsers(): boolean {
  const { activeOrg } = useAuth()
  return activeOrg !== null && activeOrg.parentOrgId === null && isOrgManagerRole(activeOrg.role)
}

export function useUserList(
  filters: UserFilters,
  cursor: string | null,
): UseQueryResult<UserListPage, XidError> {
  const enabled = useCanReadUsers()
  const query = { ...userFilterQuery(filters), limit: 50, cursor: cursor ?? undefined }
  return useApiQuery<UserListPage>(['users', 'list', query], '/v1/users', {
    enabled,
    query,
    placeholderData: (previous) => previous,
  })
}

export function useUser(userId: string): UseQueryResult<UserDetail, XidError> {
  const enabled = useCanReadUsers() && userId.length > 0
  return useApiQuery<UserDetail>(['users', userId], `/v1/users/${userId}`, {
    enabled,
    query: { include_deleted: true },
  })
}

function useUserResource<T>(userId: string, path: string, extra?: Record<string, string>) {
  const enabled = useCanReadUsers() && userId.length > 0
  return useApiQuery<T>(['users', userId, path, extra ?? null], `/v1/users/${userId}/${path}`, {
    enabled,
    ...(extra ? { query: extra } : {}),
  })
}

export function useUserSignInMethods(userId: string): UseQueryResult<UserSignInMethods, XidError> {
  return useUserResource<UserSignInMethods>(userId, 'sign-in-methods')
}

export function useUserMemberships(
  userId: string,
): UseQueryResult<{ data: UserMembership[] }, XidError> {
  return useUserResource<{ data: UserMembership[] }>(userId, 'memberships')
}

export function useUserAuditEvents(
  userId: string,
  cursor: string | null,
): UseQueryResult<Page<UserAuditEvent>, XidError> {
  return useUserResource<Page<UserAuditEvent>>(
    userId,
    'audit-events',
    cursor ? { limit: '50', cursor } : { limit: '50' },
  )
}

export function useUserSessions(userId: string): UseQueryResult<Page<UserSession>, XidError> {
  const enabled = useCanReadUsers() && userId.length > 0
  return useApiQuery<Page<UserSession>>(['users', userId, 'sessions'], '/v1/sessions', {
    enabled,
    query: { user_id: userId, limit: 100 },
  })
}

export function useUserGrants(userId: string): UseQueryResult<Page<UserGrantRow>, XidError> {
  const enabled = useCanReadUsers() && userId.length > 0
  return useApiQuery<Page<UserGrantRow>>(['users', userId, 'user-grants'], '/v1/user-grants', {
    enabled,
    query: { user_id: userId, limit: 100 },
  })
}

const USERS_PREFIX = [['users']] as const

export type UserAction =
  | 'password_reset'
  | 'mfa_reset'
  | 'sign_out'
  | 'suspend'
  | 'resume'
  | 'delete'

const ACTION_REQUEST: Record<
  UserAction,
  (userId: string) => { method: 'POST' | 'DELETE'; path: string }
> = {
  password_reset: (id) => ({ method: 'POST', path: `/v1/users/${id}/password-reset` }),
  mfa_reset: (id) => ({ method: 'POST', path: `/v1/users/${id}/mfa/reset` }),
  sign_out: (id) => ({ method: 'POST', path: `/v1/sessions/users/${id}/revoke_all` }),
  suspend: (id) => ({ method: 'POST', path: `/v1/users/${id}/ban` }),
  resume: (id) => ({ method: 'POST', path: `/v1/users/${id}/unban` }),
  delete: (id) => ({ method: 'DELETE', path: `/v1/users/${id}` }),
}

export function useUserAction(): UseMutationResult<
  unknown,
  XidError,
  { action: UserAction; userId: string }
> {
  return useApiMutation<unknown, { action: UserAction; userId: string }>(
    (api, { action, userId }) => {
      const request = ACTION_REQUEST[action](userId)
      return request.method === 'DELETE' ? api.del(request.path) : api.post(request.path)
    },
    { invalidate: USERS_PREFIX },
  )
}

export function useRevokeSession(userId: string): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, sessionId) => api.post(`/v1/sessions/${sessionId}/revoke`),
    { invalidate: [['users', userId, 'sessions']] },
  )
}

export type UpdateUserInput = {
  first_name?: string
  last_name?: string
  username?: string
  external_id?: string
  locale?: string
  timezone?: string
  public_metadata?: Record<string, unknown>
}

export function useUpdateUser(
  userId: string,
): UseMutationResult<ConsoleUser, XidError, UpdateUserInput> {
  return useApiMutation<ConsoleUser, UpdateUserInput>(
    (api, body) => api.patch(`/v1/users/${userId}`, body),
    { invalidate: USERS_PREFIX },
  )
}

export type CreateUserInput = {
  email?: string
  phone?: string
  first_name?: string
  last_name?: string
  username?: string
  send_password_setup?: boolean
}

export function useCreateUser(): UseMutationResult<ConsoleUser, XidError, CreateUserInput> {
  return useApiMutation<ConsoleUser, CreateUserInput>((api, body) => api.post('/v1/users', body), {
    invalidate: USERS_PREFIX,
  })
}

export function useRevokeUserGrant(userId: string): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>((api, grantId) => api.del(`/v1/user-grants/${grantId}`), {
    invalidate: [['users', userId, 'user-grants']],
  })
}
