// TenantContext 与租户策略覆盖。issuer/签名密钥/rpId/配置一律从此取，禁止内核全局单例。

import type { SigningAlg, SigningKeyMaterial } from './signing'

// MFA 三层继承（platform/tenant/org），null 回退上层
export const MFA_ENFORCEMENT = ['required', 'optional', 'disabled'] as const
export type MfaEnforcement = (typeof MFA_ENFORCEMENT)[number]

// SMS 不得作为唯一 MFA 因子
export const MFA_METHODS = ['totp', 'sms_otp', 'email_otp', 'passkey'] as const
export type MfaMethod = (typeof MFA_METHODS)[number]

export type PasswordPolicy = {
  minLength: number
  maxLength: number
  requireBreachCheck: boolean
  historyCount: number
}

export type SessionPolicy = {
  idleTimeoutMin: number
  absoluteTimeoutDays: number
  rememberMeDefault?: boolean
}

// refresh 轮换：7d 绝对 + 30d 空闲
export type TokenPolicy = {
  accessTokenTtlSec: number
  sessionTokenTtlSec: number
  refreshIdleTimeoutDays: number
  refreshAbsoluteTimeoutDays: number
}

// forceSso 绑定 SSO 后禁密码登录
export type LoginPolicy = {
  forceSso: boolean
  allowPasswordLogin: boolean
}

export const IDENTIFIER_MODES = [
  'email',
  'username',
  'email_or_username',
  'phone',
  'external_id',
] as const
export type IdentifierMode = (typeof IDENTIFIER_MODES)[number]

export type HostedAuthMethodPolicy = {
  enabled: boolean
  allowLogin: boolean
  allowUserCreation: boolean
  requireEmailVerification?: boolean
}

export const PROFILE_FIELD_MODES = ['required', 'optional', 'hidden'] as const
export type ProfileFieldMode = (typeof PROFILE_FIELD_MODES)[number]

export const HOSTED_AUTH_PROFILE_FIELDS = [
  'email',
  'username',
  'phone',
  'name',
  'givenName',
  'familyName',
] as const
export type HostedAuthProfileField = (typeof HOSTED_AUTH_PROFILE_FIELDS)[number]
export type HostedAuthProfileFields = Record<HostedAuthProfileField, ProfileFieldMode>

export type EnterpriseSsoPolicy = {
  enabled: boolean
  allowLogin: boolean
  allowJitUserCreation: boolean
  domainDiscovery: boolean
  allowedEmailDomains: readonly string[]
  blockedEmailDomains: readonly string[]
}

export const ATTESTATION_MODES = ['none', 'indirect', 'direct'] as const
export type AttestationMode = (typeof ATTESTATION_MODES)[number]

export type HostedAuthPolicy = {
  identifierMode: IdentifierMode
  requireVerifiedEmail: boolean
  allowedEmailDomains: readonly string[]
  blockedEmailDomains: readonly string[]
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
  enterpriseSso: EnterpriseSsoPolicy
}

// 配置来自 TenantContext；client secret 只引用 Workers Secret 名称，不存明文
export type SocialProviderPolicy = {
  authorizationEndpoint: string
  tokenEndpoint: string
  clientId: string
  clientSecretRef?: string
  userInfoEndpoint?: string
  scopes: readonly string[]
  usesPkce: boolean
  issuer?: string
  jwksUri?: string
  externalIdClaim?: string
  redirectUris?: readonly string[]
  enabled: boolean
  allowLogin: boolean
  allowUserCreation: boolean
  requireVerifiedEmail: boolean
  allowedEmailDomains: readonly string[]
  blockedEmailDomains: readonly string[]
}

export type DeliveryChannelProviderPolicy = {
  provider: string
  enabled: boolean
  secretRefs: readonly string[]
  from?: string
}

export type DeliveryChannelsPolicy = {
  whatsapp?: DeliveryChannelProviderPolicy
  sms?: DeliveryChannelProviderPolicy
}

export type OidcProfilePolicy = {
  fapiProfileSupported?: boolean
  browserBasedAppsProfileSupported?: boolean
}

// 未设字段回退 instance 默认
export type TenantPolicy = {
  mfaEnforcement?: MfaEnforcement
  mfaAllowedMethods?: readonly MfaMethod[]
  password?: PasswordPolicy
  session?: SessionPolicy
  token?: TokenPolicy
  login?: LoginPolicy
  hostedAuth?: HostedAuthPolicy
  socialProviders?: Readonly<Record<string, SocialProviderPolicy>>
  deliveryChannels?: DeliveryChannelsPolicy
  oidcProfiles?: OidcProfilePolicy
}

const DEFAULT_METHOD_DISABLED: HostedAuthMethodPolicy = {
  enabled: false,
  allowLogin: false,
  allowUserCreation: false,
}

export const DEFAULT_HOSTED_AUTH_PROFILE_FIELDS: HostedAuthProfileFields = {
  email: 'required',
  username: 'hidden',
  phone: 'hidden',
  name: 'hidden',
  givenName: 'hidden',
  familyName: 'hidden',
}

export const DEFAULT_HOSTED_AUTH_POLICY: HostedAuthPolicy = {
  identifierMode: 'email',
  requireVerifiedEmail: true,
  allowedEmailDomains: [],
  blockedEmailDomains: [],
  forceSso: false,
  allowUserCreation: true,
  allowExistingUserLogin: true,
  profileFields: DEFAULT_HOSTED_AUTH_PROFILE_FIELDS,
  password: DEFAULT_METHOD_DISABLED,
  magicLink: { enabled: true, allowLogin: true, allowUserCreation: true },
  emailOtp: { enabled: true, allowLogin: true, allowUserCreation: true },
  whatsappOtp: DEFAULT_METHOD_DISABLED,
  smsOtp: DEFAULT_METHOD_DISABLED,
  passkey: DEFAULT_METHOD_DISABLED,
  attestationMode: 'none',
  enterpriseSso: {
    enabled: false,
    allowLogin: false,
    allowJitUserCreation: false,
    domainDiscovery: false,
    allowedEmailDomains: [],
    blockedEmailDomains: [],
  },
}

// 默认 idle 3 天 / absolute 30 天（产品拍板；instance/org 可覆盖）
export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  idleTimeoutMin: 4320,
  absoluteTimeoutDays: 30,
}

// session token 60s 是 SDK networkless 验证窗口
export const DEFAULT_TOKEN_POLICY: TokenPolicy = {
  accessTokenTtlSec: 3600,
  sessionTokenTtlSec: 60,
  refreshIdleTimeoutDays: 30,
  refreshAbsoluteTimeoutDays: 7,
}

// normalize clamp 与 worker valibot 共用同一组边界
export const SESSION_POLICY_BOUNDS = {
  idleTimeoutMin: { min: 5, max: 43200 },
  absoluteTimeoutDays: { min: 1, max: 365 },
} as const

export const TOKEN_POLICY_BOUNDS = {
  accessTokenTtlSec: { min: 60, max: 86400 },
  sessionTokenTtlSec: { min: 30, max: 300 },
  refreshIdleTimeoutDays: { min: 1, max: 365 },
  refreshAbsoluteTimeoutDays: { min: 1, max: 90 },
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function identifierModeOr(value: unknown, fallback: IdentifierMode): IdentifierMode {
  return typeof value === 'string' && IDENTIFIER_MODES.includes(value as IdentifierMode)
    ? (value as IdentifierMode)
    : fallback
}

function profileFieldModeOr(value: unknown, fallback: ProfileFieldMode): ProfileFieldMode {
  return typeof value === 'string' && PROFILE_FIELD_MODES.includes(value as ProfileFieldMode)
    ? (value as ProfileFieldMode)
    : fallback
}

function attestationModeOr(value: unknown, fallback: AttestationMode): AttestationMode {
  return typeof value === 'string' && ATTESTATION_MODES.includes(value as AttestationMode)
    ? (value as AttestationMode)
    : fallback
}

export function normalizeDomainList(
  value: unknown,
  fallback: readonly string[] = [],
): readonly string[] {
  const parsed = stringArray(value)
  const source = parsed === undefined ? fallback : parsed
  return [...new Set(source.map((item) => item.trim().toLowerCase()).filter(Boolean))]
}

// 非有限数字（NaN/Infinity）回退默认；有限数字出界 clamp
function clampedNumberOr(value: unknown, fallback: number, bounds: { min: number; max: number }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, bounds.min), bounds.max)
}

// DB JSON 为 snake_case，SDK/console 为 camelCase，两种键都接受
function policyField(source: Record<string, unknown>, camelKey: string, snakeKey: string): unknown {
  return source[camelKey] ?? source[snakeKey]
}

export function normalizeSessionPolicy(input: unknown): SessionPolicy {
  const source = isRecord(input) ? input : {}
  const rememberMeDefault = policyField(source, 'rememberMeDefault', 'remember_me_default')
  return {
    idleTimeoutMin: clampedNumberOr(
      policyField(source, 'idleTimeoutMin', 'idle_timeout_min'),
      DEFAULT_SESSION_POLICY.idleTimeoutMin,
      SESSION_POLICY_BOUNDS.idleTimeoutMin,
    ),
    absoluteTimeoutDays: clampedNumberOr(
      policyField(source, 'absoluteTimeoutDays', 'absolute_timeout_days'),
      DEFAULT_SESSION_POLICY.absoluteTimeoutDays,
      SESSION_POLICY_BOUNDS.absoluteTimeoutDays,
    ),
    ...(typeof rememberMeDefault === 'boolean' ? { rememberMeDefault } : {}),
  }
}

export function normalizeTokenPolicy(input: unknown): TokenPolicy {
  const source = isRecord(input) ? input : {}
  return {
    accessTokenTtlSec: clampedNumberOr(
      policyField(source, 'accessTokenTtlSec', 'access_token_ttl_sec'),
      DEFAULT_TOKEN_POLICY.accessTokenTtlSec,
      TOKEN_POLICY_BOUNDS.accessTokenTtlSec,
    ),
    sessionTokenTtlSec: clampedNumberOr(
      policyField(source, 'sessionTokenTtlSec', 'session_token_ttl_sec'),
      DEFAULT_TOKEN_POLICY.sessionTokenTtlSec,
      TOKEN_POLICY_BOUNDS.sessionTokenTtlSec,
    ),
    refreshIdleTimeoutDays: clampedNumberOr(
      policyField(source, 'refreshIdleTimeoutDays', 'refresh_idle_timeout_days'),
      DEFAULT_TOKEN_POLICY.refreshIdleTimeoutDays,
      TOKEN_POLICY_BOUNDS.refreshIdleTimeoutDays,
    ),
    refreshAbsoluteTimeoutDays: clampedNumberOr(
      policyField(source, 'refreshAbsoluteTimeoutDays', 'refresh_absolute_timeout_days'),
      DEFAULT_TOKEN_POLICY.refreshAbsoluteTimeoutDays,
      TOKEN_POLICY_BOUNDS.refreshAbsoluteTimeoutDays,
    ),
  }
}

export function normalizeHostedAuthMethodPolicy(
  raw: unknown,
  fallback: HostedAuthMethodPolicy,
): HostedAuthMethodPolicy {
  if (!isRecord(raw)) return fallback
  return {
    enabled: booleanOr(raw['enabled'], fallback.enabled),
    allowLogin: booleanOr(raw['allowLogin'], fallback.allowLogin),
    allowUserCreation: booleanOr(raw['allowUserCreation'], fallback.allowUserCreation),
    requireEmailVerification: booleanOr(
      raw['requireEmailVerification'],
      fallback.requireEmailVerification ?? DEFAULT_HOSTED_AUTH_POLICY.requireVerifiedEmail,
    ),
  }
}

export function normalizeHostedAuthProfileFields(
  raw: unknown,
  fallback: HostedAuthProfileFields = DEFAULT_HOSTED_AUTH_PROFILE_FIELDS,
): HostedAuthProfileFields {
  const source = isRecord(raw) ? raw : {}
  return {
    email: profileFieldModeOr(source['email'], fallback.email),
    username: profileFieldModeOr(source['username'], fallback.username),
    phone: profileFieldModeOr(source['phone'], fallback.phone),
    name: profileFieldModeOr(source['name'], fallback.name),
    givenName: profileFieldModeOr(source['givenName'], fallback.givenName),
    familyName: profileFieldModeOr(source['familyName'], fallback.familyName),
  }
}

export function normalizeHostedAuthPolicy(
  raw: unknown,
  fallback: HostedAuthPolicy = DEFAULT_HOSTED_AUTH_POLICY,
): HostedAuthPolicy {
  if (!isRecord(raw)) return fallback
  const enterpriseRaw = raw['enterpriseSso']
  const enterprise = isRecord(enterpriseRaw) ? enterpriseRaw : {}
  return {
    identifierMode: identifierModeOr(raw['identifierMode'], fallback.identifierMode),
    requireVerifiedEmail: booleanOr(raw['requireVerifiedEmail'], fallback.requireVerifiedEmail),
    allowedEmailDomains: normalizeDomainList(
      raw['allowedEmailDomains'],
      fallback.allowedEmailDomains,
    ),
    blockedEmailDomains: normalizeDomainList(
      raw['blockedEmailDomains'],
      fallback.blockedEmailDomains,
    ),
    forceSso: booleanOr(raw['forceSso'], fallback.forceSso),
    allowUserCreation: booleanOr(raw['allowUserCreation'], fallback.allowUserCreation),
    allowExistingUserLogin: booleanOr(
      raw['allowExistingUserLogin'],
      fallback.allowExistingUserLogin,
    ),
    profileFields: normalizeHostedAuthProfileFields(raw['profileFields'], fallback.profileFields),
    password: normalizeHostedAuthMethodPolicy(raw['password'], fallback.password),
    magicLink: normalizeHostedAuthMethodPolicy(raw['magicLink'], fallback.magicLink),
    emailOtp: normalizeHostedAuthMethodPolicy(raw['emailOtp'], fallback.emailOtp),
    whatsappOtp: normalizeHostedAuthMethodPolicy(raw['whatsappOtp'], fallback.whatsappOtp),
    smsOtp: normalizeHostedAuthMethodPolicy(raw['smsOtp'], fallback.smsOtp),
    passkey: normalizeHostedAuthMethodPolicy(raw['passkey'], fallback.passkey),
    attestationMode: attestationModeOr(raw['attestationMode'], fallback.attestationMode ?? 'none'),
    enterpriseSso: {
      enabled: booleanOr(enterprise['enabled'], fallback.enterpriseSso.enabled),
      allowLogin: booleanOr(enterprise['allowLogin'], fallback.enterpriseSso.allowLogin),
      allowJitUserCreation: booleanOr(
        enterprise['allowJitUserCreation'],
        fallback.enterpriseSso.allowJitUserCreation,
      ),
      domainDiscovery: booleanOr(
        enterprise['domainDiscovery'],
        fallback.enterpriseSso.domainDiscovery,
      ),
      allowedEmailDomains: normalizeDomainList(
        enterprise['allowedEmailDomains'],
        fallback.enterpriseSso.allowedEmailDomains,
      ),
      blockedEmailDomains: normalizeDomainList(
        enterprise['blockedEmailDomains'],
        fallback.enterpriseSso.blockedEmailDomains,
      ),
    },
  }
}

export function normalizeSocialProviderPolicy(raw: unknown): SocialProviderPolicy | undefined {
  if (!isRecord(raw)) return undefined
  const scopes = stringArray(raw['scopes'])
  if (
    typeof raw['authorizationEndpoint'] !== 'string' ||
    typeof raw['tokenEndpoint'] !== 'string' ||
    typeof raw['clientId'] !== 'string' ||
    typeof raw['usesPkce'] !== 'boolean' ||
    scopes === undefined
  ) {
    return undefined
  }
  const redirectUris = stringArray(raw['redirectUris'])
  return {
    authorizationEndpoint: raw['authorizationEndpoint'],
    tokenEndpoint: raw['tokenEndpoint'],
    clientId: raw['clientId'],
    clientSecretRef: optionalString(raw['clientSecretRef']),
    userInfoEndpoint: optionalString(raw['userInfoEndpoint']),
    scopes,
    usesPkce: raw['usesPkce'],
    issuer: optionalString(raw['issuer']),
    jwksUri: optionalString(raw['jwksUri']),
    externalIdClaim: optionalString(raw['externalIdClaim']),
    redirectUris,
    enabled: booleanOr(raw['enabled'], true),
    allowLogin: booleanOr(raw['allowLogin'], true),
    allowUserCreation: booleanOr(raw['allowUserCreation'], false),
    requireVerifiedEmail: booleanOr(raw['requireVerifiedEmail'], true),
    allowedEmailDomains: normalizeDomainList(raw['allowedEmailDomains']),
    blockedEmailDomains: normalizeDomainList(raw['blockedEmailDomains']),
  }
}

export function normalizeSocialProviders(
  raw: unknown,
): Readonly<Record<string, SocialProviderPolicy>> | undefined {
  if (!isRecord(raw)) return undefined
  const entries = Object.entries(raw)
    .map(([provider, value]) => [provider, normalizeSocialProviderPolicy(value)] as const)
    .filter((entry): entry is readonly [string, SocialProviderPolicy] => entry[1] !== undefined)
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

function normalizeDeliveryChannelProviderPolicy(
  raw: unknown,
): DeliveryChannelProviderPolicy | undefined {
  if (!isRecord(raw)) return undefined
  if (typeof raw['provider'] !== 'string' || raw['provider'].trim() === '') return undefined
  const secretRefs = stringArray(raw['secretRefs']) ?? stringArray(raw['secret_refs']) ?? []
  return {
    provider: raw['provider'].trim().toLowerCase(),
    enabled: booleanOr(raw['enabled'], false),
    secretRefs: [...new Set(secretRefs.map((item) => item.trim()).filter(Boolean))],
    from: optionalString(raw['from']),
  }
}

export function normalizeDeliveryChannelsPolicy(raw: unknown): DeliveryChannelsPolicy | undefined {
  if (!isRecord(raw)) return undefined
  const whatsapp = normalizeDeliveryChannelProviderPolicy(raw['whatsapp'])
  const sms = normalizeDeliveryChannelProviderPolicy(raw['sms'])
  return whatsapp || sms ? { whatsapp, sms } : undefined
}

// 多 kid 并存；activeKid 为当前签名 kid
export type ActiveSigningKeySet = {
  activeKid: string
  defaultAlg: SigningAlg
  keys: readonly SigningKeyMaterial[]
}

// 多租户唯一上下文；单租户=配置驱动，多租户=按 Host 从 D1 解析
export type TenantContext = {
  tenantId: string
  instanceId?: string
  issuer: string
  rpId: string
  customHostname?: string
  requiresPasskeyReregistration?: boolean
  resolution?: {
    kind: 'tenant' | 'instance_entry'
    primaryDomain?: string
    unresolvedRoot?: boolean
  }
  hostedAuthOrigin?: string
  signingKeys: ActiveSigningKeySet
  policy: TenantPolicy
}
