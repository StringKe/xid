// org 管理数据层(TanStack Query):/v1/organizations/:orgId/* 读写。
// 替代 ./hooks(useApiGet)三态;cursor 分页由调用方维护 cursor state 传入。
// 读请求的 enabled 一律走 useCanManageOrg(与服务端 requireOrgManager 同源判角色,
// 见 ./useOrgTarget):角色未确认为 org manager 前不发请求;错误为 XidError。

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type { XidError } from '@xid-kit/types'
import { queryKeyPrefixes, queryKeys, useApiMutation, useApiQuery } from '../../lib/queries'
import { useCanManageOrg } from './useOrgTarget'
import type {
  ApiKey,
  AuditEventPage,
  CreateApiKeyInput,
  CreateApplicationInput,
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
  OrgDeliveryChannels,
  OrgDomain,
  OrgInvitation,
  OrgMember,
  OrgRole,
  OrgSocialProviders,
  Page,
  RotateClientSecretResult,
  RotateScimTokenResult,
  RotateWebhookSecretResult,
  ScimDirectory,
  ScimTarget,
  ScimTargetSyncSummary,
  SsoConnection,
  UpdateOrgAuthPolicyInput,
  UpdateOrgDeliveryChannelsInput,
  UpdateOrgSocialProvidersInput,
  UpdateOutboundSamlAppInput,
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

// --- 写操作 ---

export function useCreateOrgInvitation(
  orgId: string,
): UseMutationResult<OrgInvitation, XidError, { email: string; role: string }> {
  return useApiMutation<OrgInvitation, { email: string; role: string }>(
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
): UseMutationResult<ScimTargetSyncSummary, XidError, string> {
  return useApiMutation<ScimTargetSyncSummary, string>(
    (api, targetId) =>
      api.post<ScimTargetSyncSummary>(`/v1/organizations/${orgId}/scim-targets/${targetId}/sync`),
    { invalidate: [queryKeyPrefixes.orgScimTargets(orgId)] },
  )
}

// --- OAuth applications(/v1/applications,扁平租户级资源,非 org-scoped) ---

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

// --- Webhooks(/v1/webhooks,扁平租户级资源) ---

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

// --- API keys(/v1/api-keys,扁平租户级资源) ---

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

// --- Audit events(只读,org-scoped /v1/organizations/:orgId/audit-events) ---
// 后端按 org 归属 + 租户隔离过滤,前端不再客户端过滤归属。

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
