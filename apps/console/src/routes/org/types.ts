// org 管理路由共享类型。对照 /v1 Management API 契约。
// 不含密钥/凭证;tenant_id 从 JWT/session 取不信任请求 body。

import type {
  OrganizationMembershipRole,
  TenantManagerRole as SharedTenantManagerRole,
  TenantManagerRoleScopeWire,
  TenantManagerScopeType as SharedTenantManagerScopeType,
} from '@xid-kit/types'

export type OrgMember = {
  id: string
  userId: string
  email: string
  name: string | null
  role: OrganizationMembershipRole
  status: 'active' | 'inactive' | 'pending'
  joinedAt: string
}

export type OrgInvitation = {
  id: string
  email: string
  role: OrganizationMembershipRole
  status: 'pending' | 'expired' | 'accepted' | 'revoked'
  expiresAt: string
  createdAt: string
}

export type OrgRole = {
  id: string
  key: string
  displayName: string
  group: string | null
  permissions: string[]
}

export type OrgPermission = {
  id: string
  key: string
  displayName: string
  resourceType: string
}

export type ProjectStatus = 'active' | 'deleted'

export type Project = {
  id: string
  org_id: string
  name: string
  description: string | null
  status: ProjectStatus
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export type ProjectRole = {
  id: string
  project_id: string
  key: string
  display_name: string
  group: string | null
  status: ProjectStatus
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export type ProjectPermission = {
  id: string
  project_id: string
  key: string
  description: string | null
  status: ProjectStatus
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export type RolePermission = {
  id: string
  role_id: string
  permission_id: string
  condition_expression: Record<string, unknown> | null
  created_at: string
}

export type ProjectGrant = {
  id: string
  granted_project_id: string
  granted_by_org_id: string
  granted_to_org_id: string
  status: 'active' | 'revoked'
  revoked_at: string | null
  created_at: string
  updated_at: string
}

export type UserGrant = {
  id: string
  user_id: string
  project_id: string
  role_id: string
  granted_via_grant_id: string | null
  revoked_at: string | null
  created_at: string
  updated_at: string
}

export type ManagerScopeType = SharedTenantManagerScopeType
export type TenantManagerRole = SharedTenantManagerRole

export type ManagerAssignment = TenantManagerRoleScopeWire & {
  id: string
  user_id: string
  scope_id: string
  created_at: string
  updated_at: string
}

export type CreateProjectInput = {
  org_id: string
  name: string
  description?: string
}

export type UpdateProjectInput = {
  name?: string
  description?: string | null
}

export type CreateProjectRoleInput = {
  project_id: string
  key: string
  display_name: string
  group?: string
}

export type UpdateProjectRoleInput = {
  display_name?: string
  group?: string
}

export type CreateProjectPermissionInput = {
  project_id: string
  key: string
  description?: string
}

export type UpdateProjectPermissionInput = {
  description?: string
}

export type CreateRolePermissionInput = {
  role_id: string
  permission_id: string
  condition_expression?: Record<string, unknown> | null
}

export type UpdateRolePermissionInput = {
  condition_expression: Record<string, unknown> | null
}

export type CreateProjectGrantInput = {
  granted_project_id: string
  granted_by_org_id: string
  granted_to_org_id: string
}

export type CreateManagerAssignmentInput = TenantManagerRoleScopeWire & {
  user_id: string
  scope_id: string
}

export type InboundSsoProtocol = 'saml' | 'oidc' | 'ldap' | 'wsfed' | 'swa' | 'header'

export type SsoConnection = {
  id: string
  name: string
  type: InboundSsoProtocol
  domain: string
  idp_entity_id?: string | null
  idp_sso_url?: string | null
  idp_slo_url?: string | null
  idp_metadata_url?: string | null
  idp_certificates: string[]
  oidc_client_id?: string | null
  oidc_discovery_url?: string | null
  want_authn_response_signed: boolean
  want_assertions_signed: boolean
  saml_clock_skew_ms: number
  attribute_mapping: Record<string, unknown>
  role_mapping: Record<string, unknown>
  jit_enabled: boolean
  status: 'active' | 'inactive' | 'error'
  createdAt: string
}

export type CreateSsoConnectionInput = {
  preset?: string
  protocol: InboundSsoProtocol
  idp_entity_id?: string
  idp_sso_url?: string
  idp_slo_url?: string | null
  idp_metadata_url?: string
  idp_certificates?: string[]
  oidc_client_id?: string
  oidc_discovery_url?: string
  jit_enabled?: boolean
  attribute_mapping?: Record<string, unknown>
  role_mapping?: Record<string, unknown>
  want_authn_response_signed?: boolean
  want_assertions_signed?: boolean
  saml_clock_skew_ms?: number
}

export type UpdateSsoConnectionInput = Omit<CreateSsoConnectionInput, 'protocol'>

export type AssignmentGate = {
  mode: 'all' | 'restricted'
  allowed_user_ids: string[]
  allowed_roles: string[]
}

export type OutboundSamlApp = {
  id: string
  provider: string
  spEntityId: string
  acsUrl: string
  sloUrl: string | null
  sloBinding: 'redirect' | 'post'
  spCertificates: string[]
  idpSigningCertId: string | null
  attributeMapping: Record<string, unknown>
  assignmentGate: AssignmentGate
  nameIdFormat: string
  metadataPath: string
  ssoPath: string
  createdAt: string
}

export type CreateOutboundSamlAppInput = {
  preset?: string
  sp_entity_id?: string
  acs_url: string
  slo_url?: string | null
  slo_binding?: 'redirect' | 'post'
  sp_certificates?: string[]
  name_id_format?: string
  idp_signing_cert_id?: string | null
  attribute_mapping?: Record<string, string>
  assignment_gate?: AssignmentGate
}

export type UpdateOutboundSamlAppInput = Partial<CreateOutboundSamlAppInput>

export type ScimTarget = {
  id: string
  provider: string
  baseUrl: string
  requiredTokenSecretName: string
  hasTokenSecret: boolean
  assignmentGate: AssignmentGate
  status: string
  lastSyncAt: string | null
  syncPath: string
  createdAt: string
}

export type CreateScimTargetInput = {
  provider: string
  base_url: string
  assignment_gate?: AssignmentGate
}

export type UpdateScimTargetInput = Partial<CreateScimTargetInput>

export type ScimTargetSyncAccepted = {
  runId: string
  targetId: string
  status: 'queued'
}

export type ScimDirectory = {
  id: string
  name: string
  provider: string
  status: 'active' | 'inactive'
  lastSyncAt: string | null
  userCount: number
  groupCount: number
}

export type CreateScimDirectoryInput = {
  provider: string
}

export type CreatedScimDirectory = ScimDirectory & {
  scimToken: string
}

export type RotateScimTokenResult = {
  scimToken: string
}

export type OrgDomain = {
  id: string
  domain: string
  verified: boolean
  enrollmentMode: 'automatic' | 'invite_required'
  verificationToken: string | null
  verifiedAt: string | null
}

export type OrgBranding = {
  primaryColor: string | null
  backgroundColor: string | null
  accentColor: string | null
  borderRadius: string | null
  fontFamily: string | null
  logoUrl: string | null
  logoDarkUrl: string | null
}

export type HostedAuthMethodPolicy = {
  enabled: boolean
  allowLogin: boolean
  allowUserCreation: boolean
  requireEmailVerification?: boolean
}

export type ProfileFieldMode = 'required' | 'optional' | 'hidden'
export type HostedAuthProfileFields = {
  email: ProfileFieldMode
  username: ProfileFieldMode
  phone: ProfileFieldMode
  name: ProfileFieldMode
  givenName: ProfileFieldMode
  familyName: ProfileFieldMode
}

export type AttestationMode = 'none' | 'indirect' | 'direct'

export type HostedAuthPolicy = {
  identifierMode: 'email' | 'username' | 'email_or_username' | 'phone' | 'external_id'
  requireVerifiedEmail: boolean
  allowedEmailDomains: string[]
  blockedEmailDomains: string[]
  forceSso: boolean
  allowUserCreation: boolean
  allowExistingUserLogin: boolean
  profileFields: HostedAuthProfileFields
  password: HostedAuthMethodPolicy
  magicLink: HostedAuthMethodPolicy
  emailOtp: HostedAuthMethodPolicy
  whatsappOtp: HostedAuthMethodPolicy
  smsOtp: HostedAuthMethodPolicy
  passkey: HostedAuthMethodPolicy
  attestationMode?: AttestationMode
  enterpriseSso: {
    enabled: boolean
    allowLogin: boolean
    allowJitUserCreation: boolean
    domainDiscovery: boolean
    allowedEmailDomains: string[]
    blockedEmailDomains: string[]
  }
}

export type OrgSocialProviderPolicy = {
  authorizationEndpoint: string
  tokenEndpoint: string
  clientId: string
  clientSecretRef?: string
  userInfoEndpoint?: string
  scopes: string[]
  usesPkce: boolean
  issuer?: string
  jwksUri?: string
  externalIdClaim?: string
  redirectUris?: string[]
  enabled: boolean
  allowLogin: boolean
  allowUserCreation: boolean
  requireVerifiedEmail: boolean
  allowedEmailDomains: string[]
  blockedEmailDomains: string[]
  hasClientSecret: boolean
  credentialsReady: boolean
}

export type DeliveryChannelReadinessItem = {
  configured: boolean
  channel: string | null
}

export type DeliveryChannelReadiness = {
  whatsappOtp: DeliveryChannelReadinessItem
  smsOtp: DeliveryChannelReadinessItem
}

// org 策略覆盖(API 面):字段为 null 表示未覆盖,回退 instance 默认。
export type OrgSessionPolicyOverride = {
  idleTimeoutMin: number | null
  absoluteTimeoutDays: number | null
}

export type OrgTokenPolicyOverride = {
  accessTokenTtlSec: number | null
  sessionTokenTtlSec: number | null
  refreshIdleTimeoutDays: number | null
  refreshAbsoluteTimeoutDays: number | null
}

export type OrgAuthPolicy = {
  hostedAuth: HostedAuthPolicy
  sessionPolicy: OrgSessionPolicyOverride
  tokenPolicy: OrgTokenPolicyOverride
  deliveryChannelReadiness: DeliveryChannelReadiness
}

export type OrgDeliveryChannelProvider = {
  provider: 'twilio' | 'meta' | 'vonage' | 'infobip' | 'messagebird' | 'test'
  enabled: boolean
  secretRefs: string[]
  hasSecrets: boolean
  credentialsReady: boolean
}

export type OrgDeliveryChannels = {
  whatsapp: {
    provider: 'twilio' | 'meta' | 'test'
    enabled: boolean
    from: string
    secretRefs: string[]
    hasSecrets: boolean
    credentialsReady: boolean
    providers: OrgDeliveryChannelProvider[]
  }
  sms: {
    provider: 'twilio' | 'vonage' | 'infobip' | 'messagebird' | 'test'
    enabled: boolean
    from: string
    secretRefs: string[]
    hasSecrets: boolean
    credentialsReady: boolean
    providers: OrgDeliveryChannelProvider[]
  }
}

export type OrgSocialProviders = {
  socialProviders: Record<string, OrgSocialProviderPolicy>
}

export type UpdateOrgAuthPolicyInput = Pick<
  OrgAuthPolicy,
  'hostedAuth' | 'sessionPolicy' | 'tokenPolicy'
>
export type UpdateOrgDeliveryChannelsInput = OrgDeliveryChannels
export type UpdateOrgSocialProvidersInput = OrgSocialProviders

// cursor 分页通用容器。
export type Page<T> = {
  data: T[]
  nextCursor: string | null
  total: number
}

// Management API v1 扁平资源(/v1/applications、/v1/webhooks、/v1/api-keys)的列表响应。
// 与 org-scoped Page<T> 不同:字段为 next_cursor / has_more,无 total。
export type V1Page<T> = {
  data: T[]
  next_cursor: string | null
  has_more: boolean
}

// OAuth client(/v1/applications),字段对照 worker/v1/applications.ts toResponse。
export type OAuthApplication = {
  id: string
  client_id: string
  client_type: 'confidential' | 'public'
  token_endpoint_auth_method: string
  redirect_uris: string[]
  post_logout_redirect_uris: string[]
  allowed_grant_types: string[]
  allowed_response_types: string[]
  allowed_scopes: string[]
  require_pkce: boolean
  dpop_bound_access_tokens?: boolean
  access_token_format?: string
  access_token_ttl_sec?: number | null
  id_token_signed_alg?: string
  first_party?: boolean
  status: string
  created_at: string
  updated_at: string
}

// 创建/轮换返回 client_secret 一次性明文。
export type CreatedOAuthApplication = OAuthApplication & {
  client_secret?: string
}

export type RotateClientSecretResult = {
  client_secret: string
}

export type CreateApplicationInput = {
  client_type: 'confidential' | 'public'
  redirect_uris: string[]
}

// webhook 端点(/v1/webhooks),字段对照 worker/v1/webhooks.ts toResponse。
export type WebhookEndpoint = {
  id: string
  url: string
  event_types: string[]
  status: string
  created_at: string
  updated_at: string
}

export type CreatedWebhookEndpoint = WebhookEndpoint & {
  signing_secret: string
}

export type RotateWebhookSecretResult = {
  signing_secret: string
}

export type CreateWebhookInput = {
  url: string
  event_types: string[]
}

// API key(/v1/api-keys),字段对照 worker/v1/api-keys.ts toResponse。
export type ApiKey = {
  id: string
  name: string
  key_prefix: string
  environment: string
  scopes: string[]
  last_used_at: string | null
  expires_at: string | null
  revoked_at: string | null
  created_at: string
}

export type CreatedApiKey = ApiKey & {
  key: string
}

export type CreateApiKeyInput = {
  name: string
  environment: 'live' | 'test'
  scopes: string[]
}

// 审计事件(/v1/organizations/:orgId/audit-events),字段对照 worker/v1/organizations.ts 的 org 审计响应。
export type AuditEvent = {
  id: string
  seq: number
  organizationId: string
  organizationName: string | null
  orgId: string | null
  eventType: string
  actorId: string | null
  actorDisplay: string | null
  actorIp: string | null
  targetType: string | null
  targetId: string | null
  occurredAt: string
}

export type AuditEventPage = {
  data: AuditEvent[]
  nextCursor: string | null
  total: number
}

export type OrgComplianceDocument = {
  id: string
  documentType: string
  title: string
  version: string
  status: 'available'
  checksum: string | null
  acceptedBy: string | null
  acceptedAt: string | null
  artifactUrl: string | null
}
