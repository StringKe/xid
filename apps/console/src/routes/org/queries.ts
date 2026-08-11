// 读请求 enabled 一律 useCanManageOrg,角色未确认前不发请求。

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type { OrganizationMembershipRole, XidError } from '@xid-kit/types'
import { queryKeyPrefixes, queryKeys, useApiMutation, useApiQuery } from '@xid-kit/web-ui/queries'
import { useCanManageOrg } from './useOrgTarget'
import type {
  ApiKey,
  AuditEventPage,
  CreateManagerAssignmentInput,
  CreateApiKeyInput,
  CreateApplicationInput,
  CreateProjectGrantInput,
  CreateProjectInput,
  CreateProjectPermissionInput,
  CreateProjectRoleInput,
  CreateRolePermissionInput,
  CreatedApiKey,
  CreatedOAuthApplication,
  CreatedScimDirectory,
  CreateScimDirectoryInput,
  CreateScimTargetInput,
  CreateOutboundSamlAppInput,
  CreateSsoConnectionInput,
  CreateWebhookInput,
  CreatedWebhookEndpoint,
  OAuthApplication,
  OutboundSamlApp,
  OrgBranding,
  OrgAuthPolicy,
  OrgComplianceDocument,
  OrgDeliveryChannels,
  OrgDomain,
  OrgInvitation,
  OrgMember,
  OrgRole,
  ManagerAssignment,
  OrgSocialProviders,
  Page,
  Project,
  ProjectGrant,
  ProjectPermission,
  ProjectRole,
  ProjectStatus,
  RolePermission,
  RotateClientSecretResult,
  RotateScimTokenResult,
  RotateWebhookSecretResult,
  ScimDirectory,
  ScimTarget,
  ScimTargetSyncAccepted,
  SsoConnection,
  UpdateOrgAuthPolicyInput,
  UpdateOrgDeliveryChannelsInput,
  UpdateOrgSocialProvidersInput,
  UpdateOutboundSamlAppInput,
  UpdateProjectInput,
  UpdateProjectPermissionInput,
  UpdateProjectRoleInput,
  UpdateRolePermissionInput,
  UserGrant,
  UpdateScimTargetInput,
  UpdateSsoConnectionInput,
  V1Page,
  WebhookEndpoint,
} from './types'

export function useOrgMembersQuery(
  orgId: string,
  cursor?: string,
): UseQueryResult<Page<OrgMember>, XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<Page<OrgMember>>(
    queryKeys.orgMembers(orgId, cursor),
    `/v1/organizations/${orgId}/members`,
    { enabled: canManage, query: { limit: 20, cursor } },
  )
}

export function useOrgInvitationsQuery(
  orgId: string,
  cursor?: string,
): UseQueryResult<Page<OrgInvitation>, XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<Page<OrgInvitation>>(
    queryKeys.orgInvitations(orgId, cursor),
    `/v1/organizations/${orgId}/invitations`,
    { enabled: canManage, query: { limit: 20, cursor } },
  )
}

export function useOrgRolesQuery(orgId: string): UseQueryResult<OrgRole[], XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<OrgRole[]>(queryKeys.orgRoles(orgId), `/v1/organizations/${orgId}/roles`, {
    enabled: canManage,
  })
}

export function useProjectsQuery(
  orgId: string,
  status: ProjectStatus,
  cursor?: string,
): UseQueryResult<V1Page<Project>, XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<V1Page<Project>>(
    queryKeys.orgProjects(orgId, status, cursor),
    '/v1/projects',
    {
      enabled: canManage,
      query: { org_id: orgId, status, limit: 50, cursor },
    },
  )
}

export function useManagedProjectQuery(
  projectId: string,
  grantId?: string,
  status: 'active' | 'all' = 'active',
): UseQueryResult<V1Page<Project>, XidError> {
  return useApiQuery<V1Page<Project>>(
    queryKeys.managedProject(projectId, status, grantId),
    '/v1/projects',
    {
      enabled: projectId.length > 0,
      query: {
        project_id: projectId,
        grant_id: grantId,
        status,
        limit: 1,
      },
    },
  )
}

export function useManagedProjectGrantQuery(
  grantId: string,
): UseQueryResult<ProjectGrant, XidError> {
  return useApiQuery<ProjectGrant>(
    queryKeys.projectGrant(grantId),
    `/v1/project-grants/${grantId}`,
    { enabled: grantId.length > 0 },
  )
}

export function useUpdateManagedProject(): UseMutationResult<
  Project,
  XidError,
  { id: string; payload: UpdateProjectInput }
> {
  return useApiMutation<Project, { id: string; payload: UpdateProjectInput }>(
    (api, { id, payload }) => api.patch<Project>(`/v1/projects/${id}`, payload),
    { invalidate: [queryKeyPrefixes.managedProjects] },
  )
}

export function useDeleteManagedProject(): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, projectId) => api.del<unknown>(`/v1/projects/${projectId}`),
    { invalidate: [queryKeyPrefixes.managedProjects, queryKeys.me] },
  )
}

export function useRestoreManagedProject(): UseMutationResult<Project, XidError, string> {
  return useApiMutation<Project, string>(
    (api, projectId) => api.post<Project>(`/v1/projects/${projectId}/restore`, {}),
    { invalidate: [queryKeyPrefixes.managedProjects, queryKeys.me] },
  )
}

export function useCreateProject(
  orgId: string,
): UseMutationResult<Project, XidError, Omit<CreateProjectInput, 'org_id'>> {
  return useApiMutation<Project, Omit<CreateProjectInput, 'org_id'>>(
    (api, payload) => api.post<Project>('/v1/projects', { ...payload, org_id: orgId }),
    { invalidate: [queryKeyPrefixes.orgProjects(orgId)] },
  )
}

export function useUpdateProject(
  orgId: string,
): UseMutationResult<Project, XidError, { id: string; payload: UpdateProjectInput }> {
  return useApiMutation<Project, { id: string; payload: UpdateProjectInput }>(
    (api, { id, payload }) => api.patch<Project>(`/v1/projects/${id}`, payload),
    { invalidate: [queryKeyPrefixes.orgProjects(orgId)] },
  )
}

export function useDeleteProject(orgId: string): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, projectId) => api.del<unknown>(`/v1/projects/${projectId}`),
    { invalidate: [queryKeyPrefixes.orgProjects(orgId)] },
  )
}

export function useRestoreProject(orgId: string): UseMutationResult<Project, XidError, string> {
  return useApiMutation<Project, string>(
    (api, projectId) => api.post<Project>(`/v1/projects/${projectId}/restore`, {}),
    { invalidate: [queryKeyPrefixes.orgProjects(orgId)] },
  )
}

export function useProjectRolesQuery(
  projectId: string,
  status: ProjectStatus,
  cursor?: string,
  grantId?: string,
): UseQueryResult<V1Page<ProjectRole>, XidError> {
  return useApiQuery<V1Page<ProjectRole>>(
    queryKeys.projectRoles(projectId, status, cursor, grantId),
    '/v1/roles',
    {
      enabled: projectId.length > 0,
      query: { project_id: projectId, grant_id: grantId, status, limit: 50, cursor },
    },
  )
}

export function useCreateProjectRole(
  projectId: string,
): UseMutationResult<ProjectRole, XidError, Omit<CreateProjectRoleInput, 'project_id'>> {
  return useApiMutation<ProjectRole, Omit<CreateProjectRoleInput, 'project_id'>>(
    (api, payload) => api.post<ProjectRole>('/v1/roles', { ...payload, project_id: projectId }),
    { invalidate: [queryKeyPrefixes.projectRoles(projectId)] },
  )
}

export function useUpdateProjectRole(
  projectId: string,
): UseMutationResult<ProjectRole, XidError, { id: string; payload: UpdateProjectRoleInput }> {
  return useApiMutation<ProjectRole, { id: string; payload: UpdateProjectRoleInput }>(
    (api, { id, payload }) => api.patch<ProjectRole>(`/v1/roles/${id}`, payload),
    {
      invalidate: [queryKeyPrefixes.projectRoles(projectId), ['roles'] as const],
    },
  )
}

export function useDeleteProjectRole(
  projectId: string,
): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>((api, roleId) => api.del<unknown>(`/v1/roles/${roleId}`), {
    invalidate: [queryKeyPrefixes.projectRoles(projectId), ['roles'] as const],
  })
}

export function useRestoreProjectRole(
  projectId: string,
): UseMutationResult<ProjectRole, XidError, string> {
  return useApiMutation<ProjectRole, string>(
    (api, roleId) => api.post<ProjectRole>(`/v1/roles/${roleId}/restore`, {}),
    { invalidate: [queryKeyPrefixes.projectRoles(projectId)] },
  )
}

export function useProjectPermissionsQuery(
  projectId: string,
  status: ProjectStatus,
  cursor?: string,
  grantId?: string,
): UseQueryResult<V1Page<ProjectPermission>, XidError> {
  return useApiQuery<V1Page<ProjectPermission>>(
    queryKeys.projectPermissions(projectId, status, cursor, grantId),
    '/v1/permissions',
    {
      enabled: projectId.length > 0,
      query: { project_id: projectId, grant_id: grantId, status, limit: 50, cursor },
    },
  )
}

export function useCreateProjectPermission(
  projectId: string,
): UseMutationResult<
  ProjectPermission,
  XidError,
  Omit<CreateProjectPermissionInput, 'project_id'>
> {
  return useApiMutation<ProjectPermission, Omit<CreateProjectPermissionInput, 'project_id'>>(
    (api, payload) =>
      api.post<ProjectPermission>('/v1/permissions', { ...payload, project_id: projectId }),
    { invalidate: [queryKeyPrefixes.projectPermissions(projectId)] },
  )
}

export function useUpdateProjectPermission(
  projectId: string,
): UseMutationResult<
  ProjectPermission,
  XidError,
  { id: string; payload: UpdateProjectPermissionInput }
> {
  return useApiMutation<ProjectPermission, { id: string; payload: UpdateProjectPermissionInput }>(
    (api, { id, payload }) => api.patch<ProjectPermission>(`/v1/permissions/${id}`, payload),
    { invalidate: [queryKeyPrefixes.projectPermissions(projectId)] },
  )
}

export function useDeleteProjectPermission(
  projectId: string,
): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, permissionId) => api.del<unknown>(`/v1/permissions/${permissionId}`),
    { invalidate: [queryKeyPrefixes.projectPermissions(projectId)] },
  )
}

export function useRestoreProjectPermission(
  projectId: string,
): UseMutationResult<ProjectPermission, XidError, string> {
  return useApiMutation<ProjectPermission, string>(
    (api, permissionId) =>
      api.post<ProjectPermission>(`/v1/permissions/${permissionId}/restore`, {}),
    { invalidate: [queryKeyPrefixes.projectPermissions(projectId)] },
  )
}

export function useRolePermissionsQuery(
  roleId: string,
  cursor?: string,
  grantId?: string,
): UseQueryResult<V1Page<RolePermission>, XidError> {
  return useApiQuery<V1Page<RolePermission>>(
    queryKeys.rolePermissions(roleId, cursor, grantId),
    '/v1/role-permissions',
    {
      enabled: roleId.length > 0,
      query: { role_id: roleId, grant_id: grantId, limit: 50, cursor },
    },
  )
}

export function useCreateRolePermission(
  roleId: string,
): UseMutationResult<RolePermission, XidError, Omit<CreateRolePermissionInput, 'role_id'>> {
  return useApiMutation<RolePermission, Omit<CreateRolePermissionInput, 'role_id'>>(
    (api, payload) =>
      api.post<RolePermission>('/v1/role-permissions', { ...payload, role_id: roleId }),
    { invalidate: [queryKeyPrefixes.rolePermissions(roleId)] },
  )
}

export function useUpdateRolePermission(
  roleId: string,
): UseMutationResult<RolePermission, XidError, { id: string; payload: UpdateRolePermissionInput }> {
  return useApiMutation<RolePermission, { id: string; payload: UpdateRolePermissionInput }>(
    (api, { id, payload }) => api.patch<RolePermission>(`/v1/role-permissions/${id}`, payload),
    { invalidate: [queryKeyPrefixes.rolePermissions(roleId)] },
  )
}

export function useDeleteRolePermission(
  roleId: string,
): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, mappingId) => api.del<unknown>(`/v1/role-permissions/${mappingId}`),
    { invalidate: [queryKeyPrefixes.rolePermissions(roleId)] },
  )
}

export function useProjectGrantsQuery(
  projectId: string,
  cursor?: string,
): UseQueryResult<V1Page<ProjectGrant>, XidError> {
  return useApiQuery<V1Page<ProjectGrant>>(
    queryKeys.projectGrants(projectId, cursor),
    '/v1/project-grants',
    {
      enabled: projectId.length > 0,
      query: { granted_project_id: projectId, limit: 50, cursor },
    },
  )
}

export function useCreateProjectGrant(
  projectId: string,
  orgId: string,
): UseMutationResult<
  ProjectGrant,
  XidError,
  Omit<CreateProjectGrantInput, 'granted_project_id' | 'granted_by_org_id'>
> {
  return useApiMutation<
    ProjectGrant,
    Omit<CreateProjectGrantInput, 'granted_project_id' | 'granted_by_org_id'>
  >(
    (api, payload) =>
      api.post<ProjectGrant>('/v1/project-grants', {
        ...payload,
        granted_project_id: projectId,
        granted_by_org_id: orgId,
      }),
    { invalidate: [queryKeyPrefixes.projectGrants(projectId)] },
  )
}

export function useRevokeProjectGrant(
  projectId: string,
): UseMutationResult<ProjectGrant, XidError, string> {
  return useApiMutation<ProjectGrant, string>(
    (api, grantId) => api.post<ProjectGrant>(`/v1/project-grants/${grantId}/revoke`, {}),
    { invalidate: [queryKeyPrefixes.projectGrants(projectId)] },
  )
}

export function useUserGrantsQuery(
  projectId: string,
  grantId: string,
  cursor?: string,
): UseQueryResult<V1Page<UserGrant>, XidError> {
  return useApiQuery<V1Page<UserGrant>>(
    queryKeys.userGrants(projectId, grantId, cursor),
    '/v1/user-grants',
    {
      enabled: projectId.length > 0 && grantId.length > 0,
      query: {
        project_id: projectId,
        granted_via_grant_id: grantId,
        limit: 50,
        cursor,
      },
    },
  )
}

export function useCreateUserGrant(
  projectId: string,
  grantId: string,
): UseMutationResult<UserGrant, XidError, { user_id: string; role_id: string }> {
  return useApiMutation<UserGrant, { user_id: string; role_id: string }>(
    (api, payload) =>
      api.post<UserGrant>('/v1/user-grants', {
        ...payload,
        project_id: projectId,
        granted_via_grant_id: grantId,
      }),
    { invalidate: [queryKeyPrefixes.userGrants(projectId, grantId)] },
  )
}

export function useRevokeUserGrant(
  projectId: string,
  grantId: string,
): UseMutationResult<UserGrant, XidError, string> {
  return useApiMutation<UserGrant, string>(
    (api, userGrantId) => api.post<UserGrant>(`/v1/user-grants/${userGrantId}/revoke`, {}),
    { invalidate: [queryKeyPrefixes.userGrants(projectId, grantId)] },
  )
}

export function useManagerAssignmentsQuery(
  scopeType: CreateManagerAssignmentInput['scope_type'],
  scopeId: string,
  cursor?: string,
): UseQueryResult<V1Page<ManagerAssignment>, XidError> {
  return useApiQuery<V1Page<ManagerAssignment>>(
    queryKeys.managerAssignments(scopeType, scopeId, cursor),
    '/v1/manager-assignments',
    {
      enabled: scopeId.length > 0,
      query: { scope_type: scopeType, scope_id: scopeId, limit: 50, cursor },
    },
  )
}

export function useCreateManagerAssignment(
  scopeType: CreateManagerAssignmentInput['scope_type'],
  scopeId: string,
): UseMutationResult<
  ManagerAssignment,
  XidError,
  Omit<CreateManagerAssignmentInput, 'scope_type' | 'scope_id'>
> {
  return useApiMutation<
    ManagerAssignment,
    Omit<CreateManagerAssignmentInput, 'scope_type' | 'scope_id'>
  >(
    (api, payload) =>
      api.post<ManagerAssignment>('/v1/manager-assignments', {
        ...payload,
        scope_type: scopeType,
        scope_id: scopeId,
      }),
    { invalidate: [queryKeyPrefixes.managerAssignments(scopeType, scopeId)] },
  )
}

export function useDeleteManagerAssignment(
  scopeType: CreateManagerAssignmentInput['scope_type'],
  scopeId: string,
): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, assignmentId) => api.del<unknown>(`/v1/manager-assignments/${assignmentId}`),
    { invalidate: [queryKeyPrefixes.managerAssignments(scopeType, scopeId)] },
  )
}

export function useOrgSsoConnectionsQuery(
  orgId: string,
): UseQueryResult<SsoConnection[], XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<SsoConnection[]>(
    queryKeys.orgSsoConnections(orgId),
    `/v1/organizations/${orgId}/sso-connections`,
    { enabled: canManage },
  )
}

export function useOrgOutboundSamlAppsQuery(
  orgId: string,
): UseQueryResult<OutboundSamlApp[], XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<OutboundSamlApp[]>(
    queryKeys.orgOutboundSamlApps(orgId),
    `/v1/organizations/${orgId}/outbound-saml-apps`,
    { enabled: canManage },
  )
}

export function useOrgScimDirectoriesQuery(
  orgId: string,
): UseQueryResult<ScimDirectory[], XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<ScimDirectory[]>(
    queryKeys.orgScimDirectories(orgId),
    `/v1/organizations/${orgId}/directories`,
    { enabled: canManage },
  )
}

export function useOrgScimTargetsQuery(orgId: string): UseQueryResult<ScimTarget[], XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<ScimTarget[]>(
    queryKeys.orgScimTargets(orgId),
    `/v1/organizations/${orgId}/scim-targets`,
    { enabled: canManage },
  )
}

export function useOrgDomainsQuery(orgId: string): UseQueryResult<OrgDomain[], XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<OrgDomain[]>(
    queryKeys.orgDomains(orgId),
    `/v1/organizations/${orgId}/domains`,
    { enabled: canManage },
  )
}

export function useOrgBrandingQuery(orgId: string): UseQueryResult<OrgBranding, XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<OrgBranding>(
    queryKeys.orgBranding(orgId),
    `/v1/organizations/${orgId}/branding`,
    { enabled: canManage },
  )
}

export function useOrgAuthPolicyQuery(orgId: string): UseQueryResult<OrgAuthPolicy, XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<OrgAuthPolicy>(
    queryKeys.orgAuthPolicy(orgId),
    `/v1/organizations/${orgId}/auth-policy`,
    { enabled: canManage },
  )
}

export function useOrgDeliveryChannelsQuery(
  orgId: string,
): UseQueryResult<OrgDeliveryChannels, XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<OrgDeliveryChannels>(
    queryKeys.orgDeliveryChannels(orgId),
    `/v1/organizations/${orgId}/delivery-channels`,
    { enabled: canManage },
  )
}

export function useOrgSocialProvidersQuery(
  orgId: string,
): UseQueryResult<OrgSocialProviders, XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<OrgSocialProviders>(
    queryKeys.orgSocialProviders(orgId),
    `/v1/organizations/${orgId}/social-providers`,
    { enabled: canManage },
  )
}

export function useCreateOrgInvitation(
  orgId: string,
): UseMutationResult<OrgInvitation, XidError, { email: string; role: OrganizationMembershipRole }> {
  return useApiMutation<OrgInvitation, { email: string; role: OrganizationMembershipRole }>(
    (api, payload) => api.post<OrgInvitation>(`/v1/organizations/${orgId}/invitations`, payload),
    { invalidate: [queryKeyPrefixes.orgInvitations(orgId)] },
  )
}

export function useRevokeOrgInvitation(
  orgId: string,
): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, invitationId) =>
      api.del<unknown>(`/v1/organizations/${orgId}/invitations/${invitationId}`),
    { invalidate: [queryKeyPrefixes.orgInvitations(orgId)] },
  )
}

export function useRemoveOrgMember(orgId: string): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, memberId) => api.del<unknown>(`/v1/organizations/${orgId}/members/${memberId}`),
    { invalidate: [queryKeyPrefixes.orgMembers(orgId)] },
  )
}

export function useUpdateOrgBranding(
  orgId: string,
): UseMutationResult<OrgBranding, XidError, Partial<OrgBranding>> {
  return useApiMutation<OrgBranding, Partial<OrgBranding>>(
    (api, payload) => api.patch<OrgBranding>(`/v1/organizations/${orgId}/branding`, payload),
    { invalidate: [queryKeys.orgBranding(orgId)] },
  )
}

export function useUpdateOrgAuthPolicy(
  orgId: string,
): UseMutationResult<OrgAuthPolicy, XidError, UpdateOrgAuthPolicyInput> {
  return useApiMutation<OrgAuthPolicy, UpdateOrgAuthPolicyInput>(
    (api, payload) => api.patch<OrgAuthPolicy>(`/v1/organizations/${orgId}/auth-policy`, payload),
    { invalidate: [queryKeys.orgAuthPolicy(orgId)] },
  )
}

export function useUpdateOrgDeliveryChannels(
  orgId: string,
): UseMutationResult<OrgDeliveryChannels, XidError, UpdateOrgDeliveryChannelsInput> {
  return useApiMutation<OrgDeliveryChannels, UpdateOrgDeliveryChannelsInput>(
    (api, payload) =>
      api.patch<OrgDeliveryChannels>(`/v1/organizations/${orgId}/delivery-channels`, payload),
    { invalidate: [queryKeys.orgDeliveryChannels(orgId), queryKeys.orgAuthPolicy(orgId)] },
  )
}

export function useUpdateOrgSocialProviders(
  orgId: string,
): UseMutationResult<OrgSocialProviders, XidError, UpdateOrgSocialProvidersInput> {
  return useApiMutation<OrgSocialProviders, UpdateOrgSocialProvidersInput>(
    (api, payload) =>
      api.patch<OrgSocialProviders>(`/v1/organizations/${orgId}/social-providers`, payload),
    { invalidate: [queryKeys.orgSocialProviders(orgId)] },
  )
}

export function useCreateSsoConnection(
  orgId: string,
): UseMutationResult<SsoConnection, XidError, CreateSsoConnectionInput> {
  return useApiMutation<SsoConnection, CreateSsoConnectionInput>(
    (api, payload) =>
      api.post<SsoConnection>(`/v1/organizations/${orgId}/sso-connections`, payload),
    { invalidate: [queryKeyPrefixes.orgSsoConnections(orgId)] },
  )
}

export function useUpdateSsoConnection(
  orgId: string,
): UseMutationResult<
  SsoConnection,
  XidError,
  { connectionId: string; payload: UpdateSsoConnectionInput }
> {
  return useApiMutation<SsoConnection, { connectionId: string; payload: UpdateSsoConnectionInput }>(
    (api, input) =>
      api.patch<SsoConnection>(
        `/v1/organizations/${orgId}/sso-connections/${input.connectionId}`,
        input.payload,
      ),
    { invalidate: [queryKeyPrefixes.orgSsoConnections(orgId)] },
  )
}

export function useDeleteSsoConnection(
  orgId: string,
): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, connectionId) =>
      api.del<unknown>(`/v1/organizations/${orgId}/sso-connections/${connectionId}`),
    { invalidate: [queryKeyPrefixes.orgSsoConnections(orgId)] },
  )
}

export function useCreateOutboundSamlApp(
  orgId: string,
): UseMutationResult<OutboundSamlApp, XidError, CreateOutboundSamlAppInput> {
  return useApiMutation<OutboundSamlApp, CreateOutboundSamlAppInput>(
    (api, payload) =>
      api.post<OutboundSamlApp>(`/v1/organizations/${orgId}/outbound-saml-apps`, payload),
    { invalidate: [queryKeys.orgOutboundSamlApps(orgId)] },
  )
}

export function useUpdateOutboundSamlApp(
  orgId: string,
): UseMutationResult<
  OutboundSamlApp,
  XidError,
  { appId: string; payload: UpdateOutboundSamlAppInput }
> {
  return useApiMutation<OutboundSamlApp, { appId: string; payload: UpdateOutboundSamlAppInput }>(
    (api, input) =>
      api.patch<OutboundSamlApp>(
        `/v1/organizations/${orgId}/outbound-saml-apps/${input.appId}`,
        input.payload,
      ),
    { invalidate: [queryKeys.orgOutboundSamlApps(orgId)] },
  )
}

export function useDeleteOutboundSamlApp(
  orgId: string,
): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, appId) => api.del<unknown>(`/v1/organizations/${orgId}/outbound-saml-apps/${appId}`),
    { invalidate: [queryKeys.orgOutboundSamlApps(orgId)] },
  )
}

export function useCreateScimDirectory(
  orgId: string,
): UseMutationResult<CreatedScimDirectory, XidError, CreateScimDirectoryInput> {
  return useApiMutation<CreatedScimDirectory, CreateScimDirectoryInput>(
    (api, payload) =>
      api.post<CreatedScimDirectory>(`/v1/organizations/${orgId}/directories`, payload),
    { invalidate: [queryKeyPrefixes.orgScimDirectories(orgId)] },
  )
}

export function useRotateScimToken(
  orgId: string,
): UseMutationResult<RotateScimTokenResult, XidError, string> {
  return useApiMutation<RotateScimTokenResult, string>(
    (api, directoryId) =>
      api.post<RotateScimTokenResult>(
        `/v1/organizations/${orgId}/directories/${directoryId}/rotate-token`,
      ),
    { invalidate: [queryKeyPrefixes.orgScimDirectories(orgId)] },
  )
}

export function useCreateScimTarget(
  orgId: string,
): UseMutationResult<ScimTarget, XidError, CreateScimTargetInput> {
  return useApiMutation<ScimTarget, CreateScimTargetInput>(
    (api, payload) => api.post<ScimTarget>(`/v1/organizations/${orgId}/scim-targets`, payload),
    { invalidate: [queryKeyPrefixes.orgScimTargets(orgId)] },
  )
}

export function useUpdateScimTarget(
  orgId: string,
): UseMutationResult<ScimTarget, XidError, { targetId: string; payload: UpdateScimTargetInput }> {
  return useApiMutation<ScimTarget, { targetId: string; payload: UpdateScimTargetInput }>(
    (api, input) =>
      api.patch<ScimTarget>(
        `/v1/organizations/${orgId}/scim-targets/${input.targetId}`,
        input.payload,
      ),
    { invalidate: [queryKeyPrefixes.orgScimTargets(orgId)] },
  )
}

export function useDeleteScimTarget(orgId: string): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, targetId) => api.del<unknown>(`/v1/organizations/${orgId}/scim-targets/${targetId}`),
    { invalidate: [queryKeyPrefixes.orgScimTargets(orgId)] },
  )
}

export function useSyncScimTarget(
  orgId: string,
): UseMutationResult<ScimTargetSyncAccepted, XidError, string> {
  return useApiMutation<ScimTargetSyncAccepted, string>(
    (api, targetId) =>
      api.post<ScimTargetSyncAccepted>(`/v1/organizations/${orgId}/scim-targets/${targetId}/sync`),
    { invalidate: [queryKeyPrefixes.orgScimTargets(orgId)] },
  )
}

export function useApplicationsQuery(
  cursor?: string,
): UseQueryResult<V1Page<OAuthApplication>, XidError> {
  return useApiQuery<V1Page<OAuthApplication>>(queryKeys.applications(cursor), '/v1/applications', {
    query: { limit: 20, cursor },
  })
}

export function useCreateApplication(): UseMutationResult<
  CreatedOAuthApplication,
  XidError,
  CreateApplicationInput
> {
  return useApiMutation<CreatedOAuthApplication, CreateApplicationInput>(
    (api, payload) => api.post<CreatedOAuthApplication>('/v1/applications', payload),
    { invalidate: [queryKeyPrefixes.applications] },
  )
}

export function useRotateClientSecret(): UseMutationResult<
  RotateClientSecretResult,
  XidError,
  string
> {
  return useApiMutation<RotateClientSecretResult, string>(
    (api, appId) => api.post<RotateClientSecretResult>(`/v1/applications/${appId}/rotate-secret`),
    { invalidate: [queryKeyPrefixes.applications] },
  )
}

export function useDeleteApplication(): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, appId) => api.del<unknown>(`/v1/applications/${appId}`),
    { invalidate: [queryKeyPrefixes.applications] },
  )
}

export function useWebhooksQuery(
  cursor?: string,
): UseQueryResult<V1Page<WebhookEndpoint>, XidError> {
  return useApiQuery<V1Page<WebhookEndpoint>>(queryKeys.webhooks(cursor), '/v1/webhooks', {
    query: { limit: 20, cursor },
  })
}

export function useCreateWebhook(): UseMutationResult<
  CreatedWebhookEndpoint,
  XidError,
  CreateWebhookInput
> {
  return useApiMutation<CreatedWebhookEndpoint, CreateWebhookInput>(
    (api, payload) => api.post<CreatedWebhookEndpoint>('/v1/webhooks', payload),
    { invalidate: [queryKeyPrefixes.webhooks] },
  )
}

export function useRotateWebhookSecret(): UseMutationResult<
  RotateWebhookSecretResult,
  XidError,
  string
> {
  return useApiMutation<RotateWebhookSecretResult, string>(
    (api, webhookId) =>
      api.post<RotateWebhookSecretResult>(`/v1/webhooks/${webhookId}/rotate-secret`),
    { invalidate: [queryKeyPrefixes.webhooks] },
  )
}

export function useDeleteWebhook(): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, webhookId) => api.del<unknown>(`/v1/webhooks/${webhookId}`),
    { invalidate: [queryKeyPrefixes.webhooks] },
  )
}

export function useApiKeysQuery(cursor?: string): UseQueryResult<V1Page<ApiKey>, XidError> {
  return useApiQuery<V1Page<ApiKey>>(queryKeys.apiKeys(cursor), '/v1/api-keys', {
    query: { limit: 20, cursor },
  })
}

export function useCreateApiKey(): UseMutationResult<CreatedApiKey, XidError, CreateApiKeyInput> {
  return useApiMutation<CreatedApiKey, CreateApiKeyInput>(
    (api, payload) => api.post<CreatedApiKey>('/v1/api-keys', payload),
    { invalidate: [queryKeyPrefixes.apiKeys] },
  )
}

export function useRevokeApiKey(): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, keyId) => api.del<unknown>(`/v1/api-keys/${keyId}`),
    { invalidate: [queryKeyPrefixes.apiKeys] },
  )
}

// 审计归属由后端租户/org 隔离,前端不做客户端过滤。
export function useAuditEventsQuery(
  orgId: string,
  cursor?: string,
): UseQueryResult<AuditEventPage, XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<AuditEventPage>(
    queryKeys.orgAuditEvents(orgId, cursor),
    `/v1/organizations/${orgId}/audit-events`,
    { enabled: canManage, query: { limit: 30, cursor } },
  )
}

export function useOrgComplianceDocumentsQuery(
  orgId: string,
): UseQueryResult<OrgComplianceDocument[], XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<OrgComplianceDocument[]>(
    queryKeys.orgComplianceDocuments(orgId),
    '/v1/compliance/documents',
    { enabled: canManage },
  )
}

export function useAcceptDpa(
  orgId: string,
): UseMutationResult<OrgComplianceDocument, XidError, { documentId: string }> {
  return useApiMutation<OrgComplianceDocument, { documentId: string }>(
    (api, { documentId }) =>
      api.post<OrgComplianceDocument>(
        `/v1/compliance/documents/${encodeURIComponent(documentId)}/accept`,
        {},
      ),
    { invalidate: [queryKeyPrefixes.orgComplianceDocuments(orgId)] },
  )
}
