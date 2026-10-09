// 认证设置页(Sign-in & MFA、Social login、Enterprise SSO、SAML apps、Messaging)的读写。
// 与共享 queries.ts 用同一 query key,保存后共享 hook 的缓存一起失效。

import type {
  UseInfiniteQueryResult,
  UseMutationResult,
  UseQueryResult,
} from '@tanstack/react-query'
import type { XidError } from '@xid-kit/types'
import {
  queryKeyPrefixes,
  queryKeys,
  useApiInfiniteQuery,
  useApiMutation,
  useApiQuery,
} from '@xid-kit/web-ui/queries'
import { useCanManageOrg } from './useOrgTarget'
import type {
  OrgAuthPolicy,
  OrgDeliveryChannels,
  OrgSocialProviderPolicy,
  OutboundSamlApp,
  SsoConnection,
  UpdateOrgAuthPolicyInput,
  V1Page,
} from './types'

export const MFA_POLICIES = ['disabled', 'optional', 'required'] as const
export type MfaPolicy = (typeof MFA_POLICIES)[number]

export type OrgAuthPolicyView = OrgAuthPolicy & {
  mfaPolicy: MfaPolicy | null
  effectiveMfaPolicy: MfaPolicy
}

export type SaveOrgAuthPolicyInput = Partial<UpdateOrgAuthPolicyInput> & {
  mfaPolicy?: MfaPolicy | null
}

export type RoutedDomain = {
  domain: string
  verified: boolean
  verificationStatus: string
  verifiedAt: string | null
  memberCount: number
}

export type AuthPolicyInsights = {
  passkeySignIns30d: number
  passwordUserCount: number
  usersWithoutSecondFactor: number
  routedDomains: RoutedDomain[]
}

export type SocialProviderView = OrgSocialProviderPolicy & {
  signIns30d: number
  disabledAt: string | null
}

export type OrgSocialProvidersView = {
  socialProviders: Record<string, SocialProviderView>
}

export type CertificateSummary = {
  fingerprintSha256: string
  notBefore: string
  notAfter: string
}

export type SsoConnectionView = SsoConnection & {
  idpCertificates: CertificateSummary[]
  lastSignInAt: string | null
  routedDomains: RoutedDomain[]
}

export type SigningCertificate = {
  id: string
  status: 'active' | 'retiring'
  notBefore: string | null
  notAfter: string | null
  fingerprint: string
  algorithm: { key: string; size: number | null; hash: string | null }
}

export type OutboundSamlAppView = OutboundSamlApp & {
  lastSignInAt: string | null
  signingCertificates: SigningCertificate[]
}

export type DeliveryFailureSummary = { count: number; topReason: string | null }

export type OrgDeliveryChannelsView = OrgDeliveryChannels & {
  email: { fromAddress: string | null; fromName: string | null }
  failures24h: Record<'email' | 'sms' | 'whatsapp', DeliveryFailureSummary>
}

export type ActivityEvent = {
  id: string
  seq: number
  eventType: string
  actorId: string | null
  actorDisplay: string | null
  occurredAt: string
}

export function useOrgAuthPolicyView(orgId: string): UseQueryResult<OrgAuthPolicyView, XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<OrgAuthPolicyView>(
    queryKeys.orgAuthPolicy(orgId),
    `/v1/organizations/${orgId}/auth-policy`,
    { enabled: canManage },
  )
}

export function useOrgAuthInsights(orgId: string): UseQueryResult<AuthPolicyInsights, XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<AuthPolicyInsights>(
    [...queryKeys.orgAuthPolicy(orgId), 'insights'],
    `/v1/organizations/${orgId}/auth-policy/insights`,
    { enabled: canManage },
  )
}

export function useSaveOrgAuthPolicy(
  orgId: string,
): UseMutationResult<OrgAuthPolicyView, XidError, SaveOrgAuthPolicyInput> {
  return useApiMutation<OrgAuthPolicyView, SaveOrgAuthPolicyInput>(
    (api, payload) =>
      api.patch<OrgAuthPolicyView>(`/v1/organizations/${orgId}/auth-policy`, payload),
    { invalidate: [queryKeys.orgAuthPolicy(orgId)] },
  )
}

export type TrustedRoot = {
  fingerprint: string
  notBefore: string
  notAfter: string
}

export type TrustedRootsView = {
  configured: boolean
  data: TrustedRoot[]
}

const TRUSTED_ROOTS_PATH = '/v1/webauthn/trusted-roots'
const trustedRootsKey = ['webauthn-trusted-roots'] as const

// 可信根属于整个租户,服务端只允许顶层组织管理员读写。
export function useTrustedRoots(enabled: boolean): UseQueryResult<TrustedRootsView, XidError> {
  return useApiQuery<TrustedRootsView>(trustedRootsKey, TRUSTED_ROOTS_PATH, { enabled })
}

export function useReplaceTrustedRoots(
  orgId: string,
): UseMutationResult<TrustedRootsView, XidError, string> {
  return useApiMutation<TrustedRootsView, string>(
    (api, pem) =>
      api.request<TrustedRootsView>(TRUSTED_ROOTS_PATH, { method: 'PUT', body: { pem } }),
    { invalidate: [trustedRootsKey, queryKeys.orgAuthPolicy(orgId)] },
  )
}

export function useRemoveTrustedRoots(orgId: string): UseMutationResult<void, XidError, void> {
  return useApiMutation<void, void>((api) => api.del<void>(TRUSTED_ROOTS_PATH), {
    invalidate: [trustedRootsKey, queryKeys.orgAuthPolicy(orgId)],
  })
}

export function useOrgSocialProvidersView(
  orgId: string,
): UseQueryResult<OrgSocialProvidersView, XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<OrgSocialProvidersView>(
    queryKeys.orgSocialProviders(orgId),
    `/v1/organizations/${orgId}/social-providers`,
    { enabled: canManage },
  )
}

export function useOrgSsoConnectionsView(
  orgId: string,
): UseQueryResult<SsoConnectionView[], XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<SsoConnectionView[]>(
    queryKeys.orgSsoConnections(orgId),
    `/v1/organizations/${orgId}/sso-connections`,
    { enabled: canManage },
  )
}

export function useOrgOutboundSamlAppsView(
  orgId: string,
): UseQueryResult<OutboundSamlAppView[], XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<OutboundSamlAppView[]>(
    queryKeys.orgOutboundSamlApps(orgId),
    `/v1/organizations/${orgId}/outbound-saml-apps`,
    { enabled: canManage },
  )
}

export function useOrgDeliveryChannelsView(
  orgId: string,
): UseQueryResult<OrgDeliveryChannelsView, XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<OrgDeliveryChannelsView>(
    queryKeys.orgDeliveryChannels(orgId),
    `/v1/organizations/${orgId}/delivery-channels`,
    { enabled: canManage },
  )
}

export function useSsoConnectionActivity(
  orgId: string,
  connectionId: string,
  enabled: boolean,
): UseInfiniteQueryResult<V1Page<ActivityEvent>, XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiInfiniteQuery<V1Page<ActivityEvent>>(
    [...queryKeyPrefixes.orgSsoConnections(orgId), connectionId, 'activity'],
    `/v1/organizations/${orgId}/sso-connections/${connectionId}/activity`,
    { enabled: canManage && enabled && connectionId.length > 0, query: { limit: 25 } },
  )
}

export function useOutboundSamlAppActivity(
  orgId: string,
  appId: string,
  enabled: boolean,
): UseInfiniteQueryResult<V1Page<ActivityEvent>, XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiInfiniteQuery<V1Page<ActivityEvent>>(
    [...queryKeys.orgOutboundSamlApps(orgId), appId, 'activity'],
    `/v1/organizations/${orgId}/outbound-saml-apps/${appId}/activity`,
    { enabled: canManage && enabled && appId.length > 0, query: { limit: 25 } },
  )
}
