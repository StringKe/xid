// Management API v1: /v1/organizations 组织资源。
// CRUD + list(cursor) + logo 上传 + 域名管理。
// 认证:sk_live_ Bearer。租户隔离:createTenantDb。
// Instance Manager 跨 org 走独立管理路径(此模块为 Org Admin 视角,见 tenant-isolation rule)。

import { createTenantDb, schema } from '@xid-kit/db'
import {
  DEFAULT_SAML_CLOCK_SKEW_MS,
  MAX_SAML_CLOCK_SKEW_MS,
  loadIdpVerifyKeys,
  setSamlEngine,
} from '@xid-kit/saml'
import type {
  DeliveryChannelProviderPolicy,
  HostedAuthPolicy,
  MfaEnforcement,
  SocialProviderPolicy,
  TenantContext,
} from '@xid-kit/types'
import {
  DEFAULT_HOSTED_AUTH_POLICY,
  MFA_ENFORCEMENT,
  ORGANIZATION_MEMBERSHIP_ROLES,
  SESSION_POLICY_BOUNDS,
  TOKEN_POLICY_BOUNDS,
  normalizeDeliveryChannelsPolicy,
  normalizeHostedAuthPolicy,
  normalizeSocialProviders,
} from '@xid-kit/types'
import { and, asc, eq, gt } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import {
  isPublicHttpsUrl,
  paginationQuerySchema,
  publicHttpsUrlSchema,
  readJsonBody,
  validateBody,
  validateQuery,
} from '../lib/validate'
import {
  SMS_PROVIDER_REFS,
  WHATSAPP_PROVIDER_REFS,
  deliveryChannelHasSecrets,
  smsDeliveryCredentialsReady,
  smsDeliverySecretRefs,
  whatsappDeliveryCredentialsReady,
  whatsappDeliverySecretRefs,
} from '../auth/delivery-channels'
import { hasSocialProviderCredentials } from '../auth/hosted-policy'
import {
  hasProviderSecret,
  socialProviderConfigIssue,
  socialProviderSecretBinding,
} from '../auth/social-providers'
import {
  oidcClientSecretConfigured,
  oidcClientSecretInputSchema,
  oidcClientSecretPatch,
} from '../sso/oidc-client-secret'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import {
  buildOrganizationQuotaUpsertStatement,
  buildSeatLimitMirrorStatement,
} from '../platform/quotas'
import {
  assertHeaderConnectionConfig,
  assertInboundSsoProtocol,
  isInboundSsoProtocol,
} from '../sso/legacy-shared'
import { assertOrgSelfServiceEditable } from './org-self-service'
import { registerOrganizationDirectoryRoutes } from './organization-directories'
import { registerOrganizationScimTargetRoutes } from './organization-scim-targets'
import { outboundSamlIdpEndpoints } from '../sso/outbound-saml'
import { acsUrl, sloUrl, spEntityId } from '../sso/saml-connection'
import {
  assignmentGateFromBody,
  parseAssignmentGate,
  serializeAssignmentGate,
  withAssignmentGate,
} from '../sso/assignment-gate'
import {
  INBOUND_IDP_PRESETS,
  LEGACY_INBOUND_PRESETS,
  OUTBOUND_SAAS_PRESETS,
  inboundPresetDisplayName,
  presetKeyFromAttributeMapping,
  withPresetAttributeMapping,
  type InboundIdpPresetKey,
  type LegacyInboundPresetKey,
  type OutboundSaasPresetKey,
} from '../sso/provider-presets'
import { resolveOrProvisionOutboundSamlSigningCertificate } from '../sso/signing-certificate'
import { registerOrgAuditRoutes } from './org-audit'
import { registerOrgBrandingRoutes } from './org-branding'
import { registerOrgDomainsRoutes } from './org-domains'
import { registerOrgMembersRoutes } from './org-members'
import {
  deliveryFailures24h,
  outboundLastSignIns,
  outboundSigningCertificates,
  parseCertificates,
  registerOrgAuthInsightRoutes,
  socialProviderActivity,
  ssoConnectionInsights,
} from './org-auth-insights'
import type { DeliveryFailures24h } from './org-auth-insights'
import {
  ORG_LIST_BATCH_SIZE,
  auditOrgMutation,
  readAllById,
  toIso,
  toOrganizationResponse,
} from './org-shared'
import {
  requireApiKey,
  requireApiKeyOrOrgManager,
  MAX_PAGE_SIZE,
  paginate,
  idAfterCursor,
  requireOrg,
  emitWebhookAsync,
  type OrgScopedAuth,
} from './shared'

const app = new Hono<XidHonoEnv>()

function assertOptionalPublicHttpsUrl(value: string | null | undefined, paramName: string): void {
  if (value === null || value === undefined || isPublicHttpsUrl(value)) return
  throw new AppError('validation_failed', {
    httpStatus: 422,
    meta: { paramName },
  })
}

// 形状校验只管字段类型/必填/边界;三态(missing/null/value)与 camel/snake 双键语义由下方
// domain normalize(readTokenPolicyPatch/mergeAuthPolicy/mergeDeliveryChannels/mergeSocialProviders)处理,
// 它们的语义比 schema 丰富,不并入 schema。
const metadataRecordSchema = v.record(v.string(), v.unknown())
const organizationRoleMappingSchema = v.record(
  v.string(),
  v.picklist(ORGANIZATION_MEMBERSHIP_ROLES),
)
const enrollmentModeSchema = v.picklist(['automatic', 'invite_required'])
const seatLimitSchema = v.pipe(v.number(), v.integer(), v.minValue(0))

const createOrgBodySchema = v.object({
  parent_org_id: v.pipe(v.string(), v.minLength(1)),
  slug: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(1)),
  public_metadata: v.optional(metadataRecordSchema),
  private_metadata: v.optional(metadataRecordSchema),
  enrollment_mode: v.optional(enrollmentModeSchema),
  seat_limit: v.optional(seatLimitSchema),
})

const patchOrgBodySchema = v.object({
  name: v.optional(v.string()),
  slug: v.optional(v.string()),
  public_metadata: v.optional(metadataRecordSchema),
  private_metadata: v.optional(metadataRecordSchema),
  enrollment_mode: v.optional(enrollmentModeSchema),
  seat_limit: v.optional(v.nullable(seatLimitSchema)),
  allow_org_self_service: v.optional(v.boolean()),
})

// auth-policy / delivery-channels / social-providers 的 PATCH body 只要求"是对象":
// 字段级语义由 domain normalize 处理,schema 不做字段约束。
const policyPatchBodySchema = v.record(v.string(), v.unknown())

// null 清除组织覆盖,回落实例默认。
const mfaPolicyPatchSchema = v.object({
  mfaPolicy: v.optional(v.nullable(v.picklist(MFA_ENFORCEMENT))),
})

const ssoConnectionDisplayNameSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(100),
)

const createSsoConnectionBodySchema = v.object({
  preset: v.optional(v.string()),
  protocol: v.optional(v.string()),
  display_name: v.optional(ssoConnectionDisplayNameSchema),
  idp_entity_id: v.optional(v.string()),
  idp_sso_url: v.optional(publicHttpsUrlSchema),
  idp_slo_url: v.optional(v.nullable(publicHttpsUrlSchema)),
  idp_metadata_url: v.optional(publicHttpsUrlSchema),
  idp_certificates: v.optional(v.array(v.string())),
  oidc_client_id: v.optional(v.string()),
  oidc_client_secret: oidcClientSecretInputSchema,
  oidc_discovery_url: v.optional(publicHttpsUrlSchema),
  jit_enabled: v.optional(v.boolean()),
  attribute_mapping: v.optional(metadataRecordSchema),
  role_mapping: v.optional(organizationRoleMappingSchema),
  want_authn_response_signed: v.optional(v.boolean()),
  want_assertions_signed: v.optional(v.boolean()),
  saml_clock_skew_ms: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_SAML_CLOCK_SKEW_MS)),
  ),
})

const patchSsoConnectionBodySchema = v.object({
  display_name: v.optional(v.nullable(ssoConnectionDisplayNameSchema)),
  idp_entity_id: v.optional(v.string()),
  idp_sso_url: v.optional(publicHttpsUrlSchema),
  idp_slo_url: v.optional(v.nullable(publicHttpsUrlSchema)),
  idp_metadata_url: v.optional(publicHttpsUrlSchema),
  idp_certificates: v.optional(v.array(v.string())),
  oidc_client_id: v.optional(v.string()),
  oidc_client_secret: oidcClientSecretInputSchema,
  oidc_discovery_url: v.optional(publicHttpsUrlSchema),
  jit_enabled: v.optional(v.boolean()),
  attribute_mapping: v.optional(metadataRecordSchema),
  role_mapping: v.optional(organizationRoleMappingSchema),
  want_authn_response_signed: v.optional(v.boolean()),
  want_assertions_signed: v.optional(v.boolean()),
  saml_clock_skew_ms: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_SAML_CLOCK_SKEW_MS)),
  ),
})

// assignment_gate 的字段级校验在 assignmentGateFromBody(paramName 契约已固定),schema 只放行键存在性。
const assignmentGateFieldSchema = v.optional(v.unknown())
const outboundSamlCertificatesSchema = v.pipe(
  v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(64 * 1024))),
  v.maxLength(10),
)
const outboundSloBindingSchema = v.picklist(['redirect', 'post'])

const createOutboundSamlAppBodySchema = v.object({
  preset: v.optional(v.string()),
  sp_entity_id: v.optional(v.string()),
  acs_url: v.optional(publicHttpsUrlSchema),
  slo_url: v.optional(v.nullable(publicHttpsUrlSchema)),
  slo_binding: v.optional(outboundSloBindingSchema),
  sp_certificates: v.optional(outboundSamlCertificatesSchema),
  name_id_format: v.optional(v.string()),
  idp_signing_cert_id: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1)))),
  attribute_mapping: v.optional(metadataRecordSchema),
  assignment_gate: assignmentGateFieldSchema,
  assignmentGate: assignmentGateFieldSchema,
})

const patchOutboundSamlAppBodySchema = v.object({
  sp_entity_id: v.optional(v.string()),
  acs_url: v.optional(publicHttpsUrlSchema),
  slo_url: v.optional(v.nullable(publicHttpsUrlSchema)),
  slo_binding: v.optional(outboundSloBindingSchema),
  sp_certificates: v.optional(outboundSamlCertificatesSchema),
  name_id_format: v.optional(v.string()),
  idp_signing_cert_id: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1)))),
  attribute_mapping: v.optional(metadataRecordSchema),
  assignment_gate: assignmentGateFieldSchema,
  assignmentGate: assignmentGateFieldSchema,
})

type ConsoleSocialProviderPolicy = SocialProviderPolicy & {
  hasClientSecret: boolean
  credentialsReady: boolean
}

type ConsoleDeliveryChannelReadinessItem = {
  configured: boolean
  channel: string | null
}

type ConsoleDeliveryChannelReadiness = {
  whatsappOtp: ConsoleDeliveryChannelReadinessItem
  smsOtp: ConsoleDeliveryChannelReadinessItem
}

type ConsoleDeliveryChannelProvider = {
  provider: string
  enabled: boolean
  secretRefs: string[]
  hasSecrets: boolean
  credentialsReady: boolean
}

type ConsoleDeliveryChannels = {
  whatsapp: ConsoleDeliveryChannelProvider & {
    provider: 'twilio' | 'meta' | 'test'
    from: string
    providers: ConsoleDeliveryChannelProvider[]
  }
  sms: ConsoleDeliveryChannelProvider & {
    provider: 'twilio' | 'vonage' | 'infobip' | 'messagebird' | 'test'
    from: string
    providers: ConsoleDeliveryChannelProvider[]
  }
}

// org 策略覆盖的 API 面:字段为 null 表示未覆盖,回退 instance 默认(见 08 章 10.6)。
type ConsoleSessionPolicyOverride = {
  idleTimeoutMin: number | null
  absoluteTimeoutDays: number | null
}

type ConsoleTokenPolicyOverride = {
  accessTokenTtlSec: number | null
  sessionTokenTtlSec: number | null
  refreshIdleTimeoutDays: number | null
  refreshAbsoluteTimeoutDays: number | null
}

type ConsoleAuthPolicy = {
  hostedAuth: HostedAuthPolicy
  sessionPolicy: ConsoleSessionPolicyOverride
  tokenPolicy: ConsoleTokenPolicyOverride
  deliveryChannelReadiness: ConsoleDeliveryChannelReadiness
  mfaPolicy: MfaEnforcement | null
  effectiveMfaPolicy: MfaEnforcement
}

type ConsoleSocialProviders = {
  socialProviders: Record<string, ConsoleSocialProviderPolicy>
}

type ConsoleSocialProvidersWithActivity = {
  socialProviders: Record<
    string,
    ConsoleSocialProviderPolicy & { signIns30d: number; disabledAt: string | null }
  >
}

type ConsoleDeliveryChannelsWithStatus = ConsoleDeliveryChannels & {
  email: { fromAddress: string | null; fromName: string | null }
  failures24h: DeliveryFailures24h
}

type ResolvedDeliveryChannelsPolicy = {
  whatsapp: DeliveryChannelProviderPolicy
  sms: DeliveryChannelProviderPolicy
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function optionalString(value: unknown): string | undefined {
  const parsed = stringOrEmpty(value)
  return parsed === '' ? undefined : parsed
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function readStringField(
  raw: Record<string, unknown>,
  keys: readonly string[],
  existing: string | undefined,
): string {
  for (const key of keys) {
    if (hasOwn(raw, key)) return stringOrEmpty(raw[key])
  }
  return existing ?? ''
}

function readOptionalStringField(
  raw: Record<string, unknown>,
  keys: readonly string[],
  existing: string | undefined,
): string | undefined {
  for (const key of keys) {
    if (hasOwn(raw, key)) return optionalString(raw[key])
  }
  return existing
}

function readStringArrayField(
  raw: Record<string, unknown>,
  keys: readonly string[],
  existing: readonly string[] | undefined,
  normalize = false,
): readonly string[] {
  for (const key of keys) {
    if (hasOwn(raw, key)) {
      const parsed = stringArray(raw[key])
      return normalize ? parsed.map((item) => item.trim().toLowerCase()).filter(Boolean) : parsed
    }
  }
  return existing ?? []
}

function readPrivateMetadata(
  org: typeof schema.organizations.$inferSelect,
): Record<string, unknown> {
  return isRecord(org.privateMetadata) ? org.privateMetadata : {}
}

const toResponse = toOrganizationResponse

async function requireTopLevelParentOrganization(
  c: Context<XidHonoEnv>,
  parentOrgId: string,
): Promise<typeof schema.organizations.$inferSelect> {
  const tenant = c.get('tenant')
  const parent = await requireOrg(c, parentOrgId)
  if (
    parent.id !== tenant.tenantId ||
    parent.tenantId !== tenant.tenantId ||
    parent.parentOrgId !== null
  ) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'parent_org_id' },
    })
  }
  return parent
}

async function requireRestorableChildParent(
  c: Context<XidHonoEnv>,
  organization: typeof schema.organizations.$inferSelect,
): Promise<void> {
  if (organization.parentOrgId === null) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'id' },
    })
  }
  await requireTopLevelParentOrganization(c, organization.parentOrgId)
}

// 保留字:instance 根域解析(default)与平台功能子域不允许业务 org slug 占用(防子域抢占)。
const RESERVED_ORG_SLUGS = new Set(['default', 'www', 'api', 'admin', 'app', 'auth', 'console'])

function assertSlugNotReserved(slug: string): void {
  if (RESERVED_ORG_SLUGS.has(slug.toLowerCase())) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'slug' } })
  }
}

// slug 冲突检查必须按 (instance_id, slug) 实例级全局查:子域解析(resolveMultiTenant)按实例级
// limit(1) 匹配,走 createTenantDb 会注入 tenant_id 漏查他租户占用,导致跨租户子域抢占。
async function findOrgByInstanceSlug(
  c: Context<XidHonoEnv>,
  slug: string,
): Promise<typeof schema.organizations.$inferSelect | undefined> {
  const tenant = c.get('tenant')
  const db = drizzle(c.env.DB, { schema })
  const rows = await db
    .select()
    .from(schema.organizations)
    .where(
      and(
        eq(schema.organizations.instanceId, tenant.instanceId ?? tenant.tenantId),
        eq(schema.organizations.slug, slug),
      ),
    )
    .limit(1)
  return rows[0]
}

function deliveryProviderRows(
  env: Env,
  refsByProvider: Readonly<Record<string, readonly string[]>>,
  channel: 'whatsapp' | 'sms',
  selected?: DeliveryChannelProviderPolicy,
): ConsoleDeliveryChannelProvider[] {
  return Object.entries(refsByProvider).map(([provider, defaultRefs]) => {
    const enabled = selected?.provider === provider ? selected.enabled : false
    const secretRefs = selected?.provider === provider ? [...selected.secretRefs] : [...defaultRefs]
    const hasSecrets = deliveryChannelHasSecrets(env, secretRefs)
    const credentialsReady =
      selected?.provider === provider
        ? channel === 'whatsapp'
          ? whatsappDeliveryCredentialsReady(selected, env)
          : smsDeliveryCredentialsReady(selected, env)
        : false
    return {
      provider,
      enabled,
      secretRefs,
      hasSecrets,
      credentialsReady,
    }
  })
}

function defaultDeliveryChannels(): ResolvedDeliveryChannelsPolicy {
  return {
    whatsapp: {
      provider: 'meta',
      enabled: false,
      from: '',
      secretRefs: [...WHATSAPP_PROVIDER_REFS.meta],
    },
    sms: {
      provider: 'twilio',
      enabled: false,
      from: '',
      secretRefs: [...SMS_PROVIDER_REFS.twilio],
    },
  }
}

function deliveryChannelsFromMetadata(
  metadata: Record<string, unknown>,
): ResolvedDeliveryChannelsPolicy {
  const normalized = normalizeDeliveryChannelsPolicy(metadata['deliveryChannels'])
  const defaults = defaultDeliveryChannels()
  return {
    whatsapp: { ...defaults.whatsapp, ...normalized?.whatsapp },
    sms: { ...defaults.sms, ...normalized?.sms },
  }
}

function toConsoleDeliveryChannels(
  org: typeof schema.organizations.$inferSelect,
  env: Env,
): ConsoleDeliveryChannels {
  const policy = deliveryChannelsFromMetadata(readPrivateMetadata(org))
  const whatsappSecretRefs = whatsappDeliverySecretRefs(policy.whatsapp)
  const smsSecretRefs = smsDeliverySecretRefs(policy.sms)
  const whatsappPolicy = { ...policy.whatsapp, secretRefs: whatsappSecretRefs }
  const smsPolicy = { ...policy.sms, secretRefs: smsSecretRefs }
  const whatsappHasSecrets = deliveryChannelHasSecrets(env, whatsappSecretRefs)
  const smsHasSecrets = deliveryChannelHasSecrets(env, smsSecretRefs)
  const whatsappReady = whatsappDeliveryCredentialsReady(whatsappPolicy, env)
  const smsReady = smsDeliveryCredentialsReady(smsPolicy, env)
  return {
    whatsapp: {
      provider:
        policy.whatsapp.provider === 'twilio'
          ? 'twilio'
          : policy.whatsapp.provider === 'test'
            ? 'test'
            : 'meta',
      enabled: policy.whatsapp.enabled,
      from: policy.whatsapp.from ?? '',
      secretRefs: [...whatsappSecretRefs],
      hasSecrets: whatsappHasSecrets,
      credentialsReady: whatsappReady,
      providers: deliveryProviderRows(env, WHATSAPP_PROVIDER_REFS, 'whatsapp', whatsappPolicy),
    },
    sms: {
      provider:
        policy.sms.provider === 'test'
          ? 'test'
          : policy.sms.provider === 'vonage' ||
              policy.sms.provider === 'infobip' ||
              policy.sms.provider === 'messagebird'
            ? policy.sms.provider
            : 'twilio',
      enabled: policy.sms.enabled,
      from: policy.sms.from ?? '',
      secretRefs: [...smsSecretRefs],
      hasSecrets: smsHasSecrets,
      credentialsReady: smsReady,
      providers: deliveryProviderRows(env, SMS_PROVIDER_REFS, 'sms', smsPolicy),
    },
  }
}

function deliveryChannelReadiness(
  org: typeof schema.organizations.$inferSelect,
  env: Env,
): ConsoleDeliveryChannelReadiness {
  const channels = toConsoleDeliveryChannels(org, env)
  return {
    whatsappOtp: {
      configured: channels.whatsapp.credentialsReady,
      channel: channels.whatsapp.credentialsReady ? channels.whatsapp.provider : null,
    },
    smsOtp: {
      configured: channels.sms.credentialsReady,
      channel: channels.sms.credentialsReady ? channels.sms.provider : null,
    },
  }
}

// token_policy JSON 兼容 snake/camel 两键(见 types normalize 同模式);非法值按未覆盖处理。
function storedPolicyNumber(
  record: Record<string, unknown> | null | undefined,
  camelKey: string,
  snakeKey: string,
): number | null {
  const value = record?.[camelKey] ?? record?.[snakeKey]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asMfaEnforcement(value: string | null | undefined): MfaEnforcement | null {
  return MFA_ENFORCEMENT.find((item) => item === value) ?? null
}

// instances 无 tenant_id,按组织所属 instance_id 直查(同 findOrgByInstanceSlug)。
async function readInstanceMfaPolicy(
  c: Context<XidHonoEnv>,
  org: typeof schema.organizations.$inferSelect,
): Promise<MfaEnforcement> {
  const rows = await drizzle(c.env.DB, { schema })
    .select({ mfaPolicy: schema.instances.mfaPolicy })
    .from(schema.instances)
    .where(eq(schema.instances.id, org.instanceId))
    .limit(1)
  return asMfaEnforcement(rows[0]?.mfaPolicy) ?? 'optional'
}

function toConsoleAuthPolicy(
  org: typeof schema.organizations.$inferSelect,
  env: Env,
  policy: typeof schema.orgPolicies.$inferSelect | undefined,
  instanceMfaPolicy: MfaEnforcement,
): ConsoleAuthPolicy {
  const metadata = readPrivateMetadata(org)
  const mfaPolicy = asMfaEnforcement(policy?.mfaPolicy)
  return {
    mfaPolicy,
    effectiveMfaPolicy: mfaPolicy ?? instanceMfaPolicy,
    hostedAuth: normalizeHostedAuthPolicy(metadata['hostedAuth']),
    sessionPolicy: {
      idleTimeoutMin: policy?.sessionIdleTimeoutMin ?? null,
      absoluteTimeoutDays: policy?.sessionAbsoluteTimeoutDays ?? null,
    },
    tokenPolicy: {
      accessTokenTtlSec: storedPolicyNumber(
        policy?.tokenPolicy,
        'accessTokenTtlSec',
        'access_token_ttl_sec',
      ),
      sessionTokenTtlSec: storedPolicyNumber(
        policy?.tokenPolicy,
        'sessionTokenTtlSec',
        'session_token_ttl_sec',
      ),
      refreshIdleTimeoutDays: storedPolicyNumber(
        policy?.tokenPolicy,
        'refreshIdleTimeoutDays',
        'refresh_idle_timeout_days',
      ),
      refreshAbsoluteTimeoutDays: storedPolicyNumber(
        policy?.tokenPolicy,
        'refreshAbsoluteTimeoutDays',
        'refresh_absolute_timeout_days',
      ),
    },
    deliveryChannelReadiness: deliveryChannelReadiness(org, env),
  }
}

function toConsoleSocialProviders(
  org: typeof schema.organizations.$inferSelect,
  env: Env,
): ConsoleSocialProviders {
  const metadata = readPrivateMetadata(org)
  const providers = normalizeSocialProviders(metadata['socialProviders']) ?? {}
  return {
    socialProviders: Object.fromEntries(
      Object.entries(providers).map(([provider, policy]) => [
        provider,
        (() => {
          const clientSecretRef = socialProviderSecretBinding(env, provider)
          return {
            authorizationEndpoint: policy.authorizationEndpoint,
            tokenEndpoint: policy.tokenEndpoint,
            clientId: policy.clientId,
            clientSecretRef,
            userInfoEndpoint: policy.userInfoEndpoint,
            scopes: policy.scopes,
            usesPkce: policy.usesPkce,
            issuer: policy.issuer,
            jwksUri: policy.jwksUri,
            externalIdClaim: policy.externalIdClaim,
            enabled: policy.enabled,
            allowLogin: policy.allowLogin,
            allowUserCreation: policy.allowUserCreation,
            requireVerifiedEmail: policy.requireVerifiedEmail,
            allowedEmailDomains: policy.allowedEmailDomains,
            blockedEmailDomains: policy.blockedEmailDomains,
            hasClientSecret: Boolean(clientSecretRef),
            credentialsReady: hasSocialProviderCredentials(policy, provider, (p, providerName) =>
              hasProviderSecret(env, p, providerName),
            ),
          }
        })(),
      ]),
    ),
  }
}

function readSocialProviderPatch(
  provider: string,
  raw: unknown,
  env: Env,
  existing?: SocialProviderPolicy,
): SocialProviderPolicy | null {
  if (!isRecord(raw)) return existing ?? null
  const requestedSecretRef = readOptionalStringField(
    raw,
    ['clientSecretRef', 'client_secret_ref'],
    undefined,
  )
  const clientSecretRef = socialProviderSecretBinding(env, provider)
  if (requestedSecretRef !== undefined && requestedSecretRef !== clientSecretRef) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'clientSecretRef' },
    })
  }
  const next: SocialProviderPolicy = {
    authorizationEndpoint: readStringField(
      raw,
      ['authorizationEndpoint', 'authorization_endpoint'],
      existing?.authorizationEndpoint,
    ),
    tokenEndpoint: readStringField(
      raw,
      ['tokenEndpoint', 'token_endpoint'],
      existing?.tokenEndpoint,
    ),
    clientId: readStringField(raw, ['clientId', 'client_id'], existing?.clientId),
    clientSecretRef,
    userInfoEndpoint: readOptionalStringField(
      raw,
      ['userInfoEndpoint', 'user_info_endpoint'],
      existing?.userInfoEndpoint,
    ),
    scopes: readStringArrayField(raw, ['scopes'], existing?.scopes),
    usesPkce: typeof raw['usesPkce'] === 'boolean' ? raw['usesPkce'] : (existing?.usesPkce ?? true),
    issuer: readOptionalStringField(raw, ['issuer'], existing?.issuer),
    jwksUri: readOptionalStringField(raw, ['jwksUri', 'jwks_uri'], existing?.jwksUri),
    externalIdClaim: readOptionalStringField(
      raw,
      ['externalIdClaim', 'external_id_claim'],
      existing?.externalIdClaim,
    ),
    enabled: typeof raw['enabled'] === 'boolean' ? raw['enabled'] : (existing?.enabled ?? false),
    allowLogin:
      typeof raw['allowLogin'] === 'boolean' ? raw['allowLogin'] : (existing?.allowLogin ?? false),
    allowUserCreation:
      typeof raw['allowUserCreation'] === 'boolean'
        ? raw['allowUserCreation']
        : (existing?.allowUserCreation ?? false),
    requireVerifiedEmail:
      typeof raw['requireVerifiedEmail'] === 'boolean'
        ? raw['requireVerifiedEmail']
        : (existing?.requireVerifiedEmail ?? true),
    allowedEmailDomains: readStringArrayField(
      raw,
      ['allowedEmailDomains', 'allowed_email_domains'],
      existing?.allowedEmailDomains,
      true,
    ),
    blockedEmailDomains: readStringArrayField(
      raw,
      ['blockedEmailDomains', 'blocked_email_domains'],
      existing?.blockedEmailDomains,
      true,
    ),
  }
  const issue = socialProviderConfigIssue(provider, next)
  if (issue) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: issue } })
  }
  return next
}

function readDeliveryProviderPatch(
  raw: unknown,
  existing: DeliveryChannelProviderPolicy,
  refsByProvider: Readonly<Record<string, readonly string[]>>,
  allowedProviders: readonly string[],
): DeliveryChannelProviderPolicy {
  if (!isRecord(raw)) return existing
  const rawProvider = readStringField(raw, ['provider'], existing.provider).toLowerCase()
  const provider = allowedProviders.includes(rawProvider) ? rawProvider : existing.provider
  const secretRefs = [...(refsByProvider[provider] ?? [])]
  const requestedSecretRefs = readStringArrayField(raw, ['secretRefs', 'secret_refs'], secretRefs)
  const requestedSet = [...new Set(requestedSecretRefs)].sort()
  const expectedSet = [...secretRefs].sort()
  if (
    requestedSet.length !== expectedSet.length ||
    requestedSet.some((value, index) => value !== expectedSet[index])
  ) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'secretRefs' },
    })
  }
  return {
    provider,
    enabled: typeof raw['enabled'] === 'boolean' ? raw['enabled'] : existing.enabled,
    from: readOptionalStringField(raw, ['from'], existing.from),
    secretRefs,
  }
}

function mergeDeliveryChannels(
  currentChannels: ResolvedDeliveryChannelsPolicy,
  body: Record<string, unknown>,
  env: Env,
): ResolvedDeliveryChannelsPolicy {
  const rawChannels = body['deliveryChannels'] ?? body['delivery_channels'] ?? body
  const channels = isRecord(rawChannels) ? rawChannels : {}
  const testProviders = isDevOrTestEnvironment(env) ? (['test'] as const) : []
  return {
    whatsapp: readDeliveryProviderPatch(
      channels['whatsapp'],
      currentChannels.whatsapp,
      WHATSAPP_PROVIDER_REFS,
      ['twilio', 'meta', ...testProviders],
    ),
    sms: readDeliveryProviderPatch(channels['sms'], currentChannels.sms, SMS_PROVIDER_REFS, [
      'twilio',
      'vonage',
      'infobip',
      'messagebird',
      ...testProviders,
    ]),
  }
}

function mergeAuthPolicy(
  currentHostedAuth: HostedAuthPolicy,
  body: Record<string, unknown>,
): HostedAuthPolicy {
  return normalizeHostedAuthPolicy(
    body['hostedAuth'] ?? body['hosted_auth'] ?? currentHostedAuth,
    DEFAULT_HOSTED_AUTH_POLICY,
  )
}

// 覆盖值语义:字段缺失 -> undefined(不动);显式 null -> null(清除覆盖,回退 instance 默认);
// 数字须落在 BOUNDS 内,越界/非数字 -> 422(paramName 精确到字段)。
function readPolicyOverrideField(
  raw: Record<string, unknown>,
  keys: readonly string[],
  bounds: { min: number; max: number },
  paramName: string,
): number | null | undefined {
  const key = keys.find((candidate) => hasOwn(raw, candidate))
  if (key === undefined) return undefined
  const value = raw[key]
  if (value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < bounds.min ||
    value > bounds.max
  ) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName } })
  }
  return value
}

type TokenPolicyPatch = {
  accessTokenTtlSec: number | null | undefined
  sessionTokenTtlSec: number | null | undefined
  refreshIdleTimeoutDays: number | null | undefined
  refreshAbsoluteTimeoutDays: number | null | undefined
}

function readTokenPolicyPatch(raw: unknown): TokenPolicyPatch | null {
  if (raw === undefined) return null
  if (!isRecord(raw)) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'tokenPolicy' } })
  }
  const patch: TokenPolicyPatch = {
    accessTokenTtlSec: readPolicyOverrideField(
      raw,
      ['accessTokenTtlSec', 'access_token_ttl_sec'],
      TOKEN_POLICY_BOUNDS.accessTokenTtlSec,
      'tokenPolicy.accessTokenTtlSec',
    ),
    sessionTokenTtlSec: readPolicyOverrideField(
      raw,
      ['sessionTokenTtlSec', 'session_token_ttl_sec'],
      TOKEN_POLICY_BOUNDS.sessionTokenTtlSec,
      'tokenPolicy.sessionTokenTtlSec',
    ),
    refreshIdleTimeoutDays: readPolicyOverrideField(
      raw,
      ['refreshIdleTimeoutDays', 'refresh_idle_timeout_days'],
      TOKEN_POLICY_BOUNDS.refreshIdleTimeoutDays,
      'tokenPolicy.refreshIdleTimeoutDays',
    ),
    refreshAbsoluteTimeoutDays: readPolicyOverrideField(
      raw,
      ['refreshAbsoluteTimeoutDays', 'refresh_absolute_timeout_days'],
      TOKEN_POLICY_BOUNDS.refreshAbsoluteTimeoutDays,
      'tokenPolicy.refreshAbsoluteTimeoutDays',
    ),
  }
  if (Object.values(patch).every((value) => value === undefined)) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'tokenPolicy' } })
  }
  return patch
}

// token_policy JSON 逐键合并:undefined 保留已有键,null 删键(回退 instance),数字覆盖;snake_case 落库。
function applyTokenJsonField(
  target: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
  value: number | null | undefined,
): void {
  if (value === undefined) return
  delete target[camelKey]
  if (value === null) {
    delete target[snakeKey]
    return
  }
  target[snakeKey] = value
}

// org_policies upsert:无行则 insert(仅写本次涉及列,其余列靠 schema 默认/null,见 08 章 10.6)。
async function upsertOrgPolicy(
  orgDb: ReturnType<ReturnType<typeof createTenantDb>['forOrg']>,
  tenantId: string,
  patch: {
    rawSession: unknown
    tokenPatch: TokenPolicyPatch | null
    mfaPolicy: MfaEnforcement | null | undefined
  },
): Promise<typeof schema.orgPolicies.$inferSelect> {
  const { rawSession, tokenPatch } = patch
  const updates: Partial<typeof schema.orgPolicies.$inferInsert> = {}
  if (patch.mfaPolicy !== undefined) updates.mfaPolicy = patch.mfaPolicy
  if (rawSession !== undefined) {
    if (!isRecord(rawSession)) {
      throw new AppError('validation_failed', {
        httpStatus: 422,
        meta: { paramName: 'sessionPolicy' },
      })
    }
    const idleTimeoutMin = readPolicyOverrideField(
      rawSession,
      ['idleTimeoutMin', 'idle_timeout_min'],
      SESSION_POLICY_BOUNDS.idleTimeoutMin,
      'sessionPolicy.idleTimeoutMin',
    )
    const absoluteTimeoutDays = readPolicyOverrideField(
      rawSession,
      ['absoluteTimeoutDays', 'absolute_timeout_days'],
      SESSION_POLICY_BOUNDS.absoluteTimeoutDays,
      'sessionPolicy.absoluteTimeoutDays',
    )
    if (idleTimeoutMin === undefined && absoluteTimeoutDays === undefined) {
      throw new AppError('validation_failed', {
        httpStatus: 422,
        meta: { paramName: 'sessionPolicy' },
      })
    }
    if (idleTimeoutMin !== undefined) updates.sessionIdleTimeoutMin = idleTimeoutMin
    if (absoluteTimeoutDays !== undefined) updates.sessionAbsoluteTimeoutDays = absoluteTimeoutDays
  }
  const existing = await orgDb.orgPolicies.findOne()
  if (tokenPatch !== null) {
    const next: Record<string, unknown> = isRecord(existing?.tokenPolicy)
      ? { ...existing.tokenPolicy }
      : {}
    applyTokenJsonField(
      next,
      'accessTokenTtlSec',
      'access_token_ttl_sec',
      tokenPatch.accessTokenTtlSec,
    )
    applyTokenJsonField(
      next,
      'sessionTokenTtlSec',
      'session_token_ttl_sec',
      tokenPatch.sessionTokenTtlSec,
    )
    applyTokenJsonField(
      next,
      'refreshIdleTimeoutDays',
      'refresh_idle_timeout_days',
      tokenPatch.refreshIdleTimeoutDays,
    )
    applyTokenJsonField(
      next,
      'refreshAbsoluteTimeoutDays',
      'refresh_absolute_timeout_days',
      tokenPatch.refreshAbsoluteTimeoutDays,
    )
    updates.tokenPolicy = next
  }
  if (existing) {
    const rows = await orgDb.orgPolicies.update(updates)
    return rows[0] ?? existing
  }
  return orgDb.orgPolicies.insert({
    id: crypto.randomUUID(),
    tenantId,
    orgId: orgDb.orgId,
    ...updates,
  })
}

function mergeSocialProviders(
  currentProviders: Readonly<Record<string, SocialProviderPolicy>>,
  body: Record<string, unknown>,
  env: Env,
): Record<string, SocialProviderPolicy> {
  const rawProviders = body['socialProviders'] ?? body['social_providers']
  if (!isRecord(rawProviders)) return { ...currentProviders }
  const socialProviders: Record<string, SocialProviderPolicy> = {}
  for (const [provider, raw] of Object.entries(rawProviders)) {
    const parsed = readSocialProviderPatch(provider, raw, env, currentProviders[provider])
    if (parsed) socialProviders[provider] = parsed
  }
  return socialProviders
}

// IdP 侧要填写的本端地址。OIDC callback 跟随用户发起登录的 origin(oidc-rp.ts),
// 因此列出实例 issuer、租户主机和 Hosted Auth origin,管理员需要全部登记到 IdP。
function ssoServiceProviderEndpoints(
  tenant: TenantContext,
  row: typeof schema.ssoConnections.$inferSelect,
) {
  if (row.protocol === 'saml') {
    return {
      sp_entity_id: spEntityId(tenant, row.id),
      acs_url: acsUrl(tenant, row.id),
      sp_metadata_url: `${tenant.issuer}/sso/saml/${row.id}/metadata`,
      slo_url: sloUrl(tenant, row.id),
    }
  }
  if (row.protocol !== 'oidc') return {}
  const origins = new Set([
    new URL(tenant.issuer).origin,
    `https://${tenant.rpId}`,
    ...(tenant.hostedAuthOrigin ? [new URL(tenant.hostedAuthOrigin).origin] : []),
  ])
  return {
    oidc_callback_urls: [...origins].map((origin) => `${origin}/sso/oidc/${row.id}/callback`),
  }
}

function toConsoleSsoConnection(
  tenant: TenantContext,
  row: typeof schema.ssoConnections.$inferSelect,
) {
  // attributeMapping 里 `_` 前缀键(_swaVault / _swaVaultEnvelope)存 SWA vault 信封加密的凭证材料,
  // 与 v1/connections.ts stripInternalAttributeMapping 同一约定:响应一律剔除,写路径不受影响。
  const attributeMapping = Object.fromEntries(
    Object.entries(row.attributeMapping).filter(([key]) => !key.startsWith('_')),
  )
  const presetName = inboundPresetDisplayName(presetKeyFromAttributeMapping(row.attributeMapping))
  return {
    id: row.id,
    name:
      row.displayName ??
      presetName ??
      row.idpEntityId ??
      row.oidcDiscoveryUrl ??
      row.protocol.toUpperCase(),
    display_name: row.displayName,
    type: isInboundSsoProtocol(row.protocol) ? row.protocol : 'saml',
    domain: row.idpSsoUrl ?? row.oidcDiscoveryUrl ?? '',
    idp_entity_id: row.idpEntityId,
    idp_sso_url: row.idpSsoUrl,
    idp_slo_url: row.idpSloUrl,
    idp_metadata_url: row.idpMetadataUrl,
    idp_certificates: row.idpCertificates,
    oidc_client_id: row.oidcClientId,
    oidc_discovery_url: row.oidcDiscoveryUrl,
    oidc_client_secret_configured: oidcClientSecretConfigured(row),
    want_authn_response_signed: row.wantAuthnResponseSigned,
    want_assertions_signed: row.wantAssertionsSigned,
    saml_clock_skew_ms: row.samlClockSkewMs,
    attribute_mapping: attributeMapping,
    role_mapping: row.roleMapping,
    jit_enabled: row.jitEnabled,
    status: row.status === 'active' ? 'active' : 'inactive',
    ...ssoServiceProviderEndpoints(tenant, row),
    createdAt: toIso(row.createdAt) ?? '',
  }
}

function auditOrgPolicy(
  c: Context<XidHonoEnv>,
  auth: OrgScopedAuth,
  input: { orgId: string; action: string },
): void {
  auditOrgMutation(c, auth, {
    action: input.action,
    orgId: input.orgId,
    targetType: 'organization',
    targetId: input.orgId,
  })
}

// ---- 列表 ----

// GET /v1/organizations?limit=&cursor=
app.get('/', async (c) => {
  await requireApiKey(c, 'organizations:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const query = validateQuery(paginationQuerySchema, c.req.query())
  const limit = query.limit ?? MAX_PAGE_SIZE
  const cursor = query.cursor ?? null

  const afterCond = idAfterCursor(schema.organizations.id, cursor)
  const active = eq(schema.organizations.status, 'active')
  const where = afterCond ? and(active, afterCond) : active
  const rows = await db.organizations.findMany(where, {
    orderBy: asc(schema.organizations.id),
    limit: limit + 1,
  })
  return c.json(paginate(rows.map(toResponse), (r) => r.id, limit))
})

// ---- 单个 ----

// GET /v1/organizations/:id
app.get('/:id', async (c) => {
  await requireApiKey(c, 'organizations:read')
  const org = await requireOrg(c, c.req.param('id'))
  return c.json(toResponse(org))
})

// GET /v1/organizations/:id/sso-connections
app.get('/:id/sso-connections', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'connections:read')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const rows = await readAllById((cursor) =>
    db
      .forOrg(id)
      .ssoConnections.findMany(
        cursor
          ? and(eq(schema.ssoConnections.status, 'active'), gt(schema.ssoConnections.id, cursor))
          : eq(schema.ssoConnections.status, 'active'),
        { orderBy: asc(schema.ssoConnections.id), limit: ORG_LIST_BATCH_SIZE },
      ),
  )
  const insights = await ssoConnectionInsights(
    c,
    id,
    rows.map((row) => row.id),
  )
  const data = await Promise.all(
    rows.map(async (row) => ({
      ...toConsoleSsoConnection(c.get('tenant'), row),
      idpCertificates: await parseCertificates(row.idpCertificates),
      lastSignInAt: insights.lastSignInAt.get(row.id) ?? null,
      routedDomains: insights.routedDomains,
    })),
  )
  return c.json(data)
})

// POST /v1/organizations/:id/sso-connections
app.post('/:id/sso-connections', async (c) => {
  const id = c.req.param('id')
  const auth = await requireApiKeyOrOrgManager(c, id, 'connections:write')
  await assertOrgSelfServiceEditable(c, auth, await requireOrg(c, id))
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createSsoConnectionBodySchema, json.value)
  const presetKey = body.preset
  const preset = presetKey ? INBOUND_IDP_PRESETS[presetKey as InboundIdpPresetKey] : undefined
  const legacyPreset = presetKey
    ? LEGACY_INBOUND_PRESETS[presetKey as LegacyInboundPresetKey]
    : undefined
  const protocolRaw =
    body.protocol ??
    legacyPreset?.protocol ??
    (preset?.protocol === 'oidc' ? 'oidc' : preset ? 'saml' : undefined)
  if (!protocolRaw) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'protocol' } })
  }
  const protocol = assertInboundSsoProtocol(protocolRaw)
  const existing = await db.forOrg(id).ssoConnections.findOne()
  if (existing && existing.status !== 'deleted') {
    throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'protocol' } })
  }
  const attributeMapping =
    body.attribute_mapping ??
    (legacyPreset
      ? { ...legacyPreset.attributeMapping, _xidPreset: legacyPreset.key }
      : preset
        ? withPresetAttributeMapping(preset.key, preset.attributeMapping)
        : {})
  assertHeaderConnectionConfig(protocol, attributeMapping)
  const roleMapping =
    body.role_mapping ??
    (legacyPreset ? legacyPreset.roleMapping : preset ? preset.roleMapping : {})
  const idpSsoUrl = body.idp_sso_url ?? legacyPreset?.idpSsoUrl ?? preset?.idpSsoUrl
  const idpSloUrl = body.idp_slo_url
  const idpMetadataUrl = body.idp_metadata_url ?? preset?.idpMetadataUrl
  const oidcDiscoveryUrl = body.oidc_discovery_url ?? preset?.oidcDiscoveryUrl
  assertOptionalPublicHttpsUrl(idpSsoUrl, 'idp_sso_url')
  assertOptionalPublicHttpsUrl(idpSloUrl, 'idp_slo_url')
  assertOptionalPublicHttpsUrl(idpMetadataUrl, 'idp_metadata_url')
  assertOptionalPublicHttpsUrl(oidcDiscoveryUrl, 'oidc_discovery_url')
  const patch = {
    protocol,
    displayName: body.display_name ?? preset?.displayName ?? legacyPreset?.displayName ?? null,
    idpEntityId: body.idp_entity_id ?? preset?.idpEntityId,
    idpSsoUrl,
    idpSloUrl,
    idpMetadataUrl,
    idpCertificates: body.idp_certificates ?? [],
    oidcClientId: body.oidc_client_id,
    oidcDiscoveryUrl,
    oidcClientSecretCiphertext: null,
    ...(await oidcClientSecretPatch(c.env, body.oidc_client_secret)),
    attributeMapping,
    roleMapping,
    jitEnabled: body.jit_enabled ?? legacyPreset?.jitEnabled ?? preset?.jitEnabled ?? true,
    wantAuthnResponseSigned: body.want_authn_response_signed ?? preset?.wantAuthnResponseSigned,
    wantAssertionsSigned: body.want_assertions_signed ?? preset?.wantAssertionsSigned,
    samlClockSkewMs: body.saml_clock_skew_ms ?? DEFAULT_SAML_CLOCK_SKEW_MS,
    status: 'active',
  } satisfies Partial<typeof schema.ssoConnections.$inferInsert>
  const row =
    existing?.status === 'deleted'
      ? (
          await db.ssoConnections.update(
            { ...patch, status: 'active' },
            eq(schema.ssoConnections.id, existing.id),
          )
        )[0]
      : await db.ssoConnections.insert({
          id: createPersistedId('ssoConnection'),
          tenantId: tenant.tenantId,
          orgId: id,
          ...patch,
        })
  auditOrgMutation(c, auth, {
    action: 'sso_connection.created',
    orgId: id,
    targetType: 'sso_connection',
    targetId: row!.id,
    details: { protocol: row!.protocol },
  })
  return c.json(toConsoleSsoConnection(c.get('tenant'), row!), 201)
})

// PATCH /v1/organizations/:id/sso-connections/:connectionId
app.patch('/:id/sso-connections/:connectionId', async (c) => {
  const id = c.req.param('id')
  const auth = await requireApiKeyOrOrgManager(c, id, 'connections:write')
  await assertOrgSelfServiceEditable(c, auth, await requireOrg(c, id))
  const connectionId = c.req.param('connectionId')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchSsoConnectionBodySchema, json.value)
  const orgDb = db.forOrg(id)
  const where = and(
    eq(schema.ssoConnections.id, connectionId),
    eq(schema.ssoConnections.status, 'active'),
  )
  const existing = await orgDb.ssoConnections.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })

  const patch: Partial<typeof schema.ssoConnections.$inferInsert> = {}
  if (body.display_name !== undefined) patch.displayName = body.display_name
  if (body.idp_entity_id !== undefined) patch.idpEntityId = body.idp_entity_id
  if (body.idp_sso_url !== undefined) patch.idpSsoUrl = body.idp_sso_url
  if (body.idp_slo_url !== undefined) patch.idpSloUrl = body.idp_slo_url
  if (body.idp_metadata_url !== undefined) patch.idpMetadataUrl = body.idp_metadata_url
  if (body.idp_certificates !== undefined) patch.idpCertificates = body.idp_certificates
  if (body.oidc_client_id !== undefined) patch.oidcClientId = body.oidc_client_id
  if (body.oidc_discovery_url !== undefined) patch.oidcDiscoveryUrl = body.oidc_discovery_url
  Object.assign(patch, await oidcClientSecretPatch(c.env, body.oidc_client_secret))
  if (body.attribute_mapping !== undefined) {
    // 响应剔除了 `_` 前缀的内部键(预设标记、SWA vault 信封),回写时保留请求未带的内部键。
    const internal = Object.fromEntries(
      Object.entries(existing.attributeMapping).filter(([key]) => key.startsWith('_')),
    )
    const attributeMapping = { ...internal, ...body.attribute_mapping }
    assertHeaderConnectionConfig(existing.protocol, attributeMapping)
    patch.attributeMapping = attributeMapping
  }
  if (body.role_mapping !== undefined) patch.roleMapping = body.role_mapping
  if (body.jit_enabled !== undefined) patch.jitEnabled = body.jit_enabled
  if (body.want_authn_response_signed !== undefined)
    patch.wantAuthnResponseSigned = body.want_authn_response_signed
  if (body.want_assertions_signed !== undefined)
    patch.wantAssertionsSigned = body.want_assertions_signed
  if (body.saml_clock_skew_ms !== undefined) patch.samlClockSkewMs = body.saml_clock_skew_ms

  const updated = await orgDb.ssoConnections.update(patch, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  auditOrgMutation(c, auth, {
    action: 'sso_connection.updated',
    orgId: id,
    targetType: 'sso_connection',
    targetId: row.id,
    details: { fields: Object.keys(patch) },
  })
  return c.json(toConsoleSsoConnection(c.get('tenant'), row))
})

// DELETE /v1/organizations/:id/sso-connections/:connectionId
app.delete('/:id/sso-connections/:connectionId', async (c) => {
  const id = c.req.param('id')
  const auth = await requireApiKeyOrOrgManager(c, id, 'connections:write')
  await assertOrgSelfServiceEditable(c, auth, await requireOrg(c, id))
  const connectionId = c.req.param('connectionId')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const orgDb = db.forOrg(id)
  const where = and(
    eq(schema.ssoConnections.id, connectionId),
    eq(schema.ssoConnections.status, 'active'),
  )
  const existing = await orgDb.ssoConnections.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  await orgDb.ssoConnections.update({ status: 'deleted' }, where)
  auditOrgMutation(c, auth, {
    action: 'sso_connection.deleted',
    orgId: id,
    targetType: 'sso_connection',
    targetId: existing.id,
  })
  return new Response(null, { status: 204 })
})

registerOrganizationDirectoryRoutes(app)
registerOrgAuthInsightRoutes(app)

// GET /v1/organizations/:id/auth-policy
app.get('/:id/auth-policy', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'organizations:read')
  const org = await requireOrg(c, id)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const [policy, instanceMfaPolicy] = await Promise.all([
    db.forOrg(id).orgPolicies.findOne(),
    readInstanceMfaPolicy(c, org),
  ])
  return c.json(toConsoleAuthPolicy(org, c.env, policy, instanceMfaPolicy))
})

function changedAuthPolicyFields(body: Record<string, unknown>): string[] {
  const groups: Record<string, readonly string[]> = {
    hostedAuth: ['hostedAuth', 'hosted_auth'],
    sessionPolicy: ['sessionPolicy', 'session_policy'],
    tokenPolicy: ['tokenPolicy', 'token_policy'],
    mfaPolicy: ['mfaPolicy'],
  }
  return Object.entries(groups)
    .filter(([, keys]) => keys.some((key) => hasOwn(body, key)))
    .map(([field]) => field)
}

// PATCH /v1/organizations/:id/auth-policy
app.patch('/:id/auth-policy', async (c) => {
  const id = c.req.param('id')
  const auth = await requireApiKeyOrOrgManager(c, id, 'organizations:write')
  const org = await requireOrg(c, id)
  await assertOrgSelfServiceEditable(c, auth, org)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(policyPatchBodySchema, json.value)
  const { mfaPolicy } = validateBody(mfaPolicyPatchSchema, body)
  const currentMetadata = readPrivateMetadata(org)
  const hostedAuth = mergeAuthPolicy(normalizeHostedAuthPolicy(currentMetadata['hostedAuth']), body)
  const privateMetadata = {
    ...currentMetadata,
    hostedAuth,
  }
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const orgDb = db.forOrg(id)
  const tokenPatch = readTokenPolicyPatch(body['tokenPolicy'] ?? body['token_policy'])
  const rawSession = body['sessionPolicy'] ?? body['session_policy']
  const policy =
    rawSession !== undefined || tokenPatch !== null || mfaPolicy !== undefined
      ? await upsertOrgPolicy(orgDb, tenant.tenantId, { rawSession, tokenPatch, mfaPolicy })
      : await orgDb.orgPolicies.findOne()
  const [updated, instanceMfaPolicy] = await Promise.all([
    db.organizations.update({ privateMetadata }, eq(schema.organizations.id, id)),
    readInstanceMfaPolicy(c, org),
  ])
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organization.auth_policy.updated',
    payload: { orgId: id },
  })
  auditOrgMutation(c, auth, {
    action: 'organization.auth_policy.updated',
    orgId: id,
    targetType: 'organization',
    targetId: id,
    details: { fields: changedAuthPolicyFields(body) },
  })
  return c.json(toConsoleAuthPolicy(updated[0]!, c.env, policy, instanceMfaPolicy))
})

async function withDeliveryStatus(
  c: Context<XidHonoEnv>,
  org: typeof schema.organizations.$inferSelect,
): Promise<ConsoleDeliveryChannelsWithStatus> {
  return {
    ...toConsoleDeliveryChannels(org, c.env),
    email: {
      fromAddress: c.env.EMAIL_FROM_ADDRESS ?? null,
      fromName: c.env.EMAIL_FROM_NAME ?? null,
    },
    failures24h: await deliveryFailures24h(c),
  }
}

// GET /v1/organizations/:id/delivery-channels
app.get('/:id/delivery-channels', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'organizations:read')
  const org = await requireOrg(c, id)
  return c.json(await withDeliveryStatus(c, org))
})

// PATCH /v1/organizations/:id/delivery-channels
app.patch('/:id/delivery-channels', async (c) => {
  const id = c.req.param('id')
  const auth = await requireApiKeyOrOrgManager(c, id, 'organizations:write')
  const org = await requireOrg(c, id)
  await assertOrgSelfServiceEditable(c, auth, org)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(policyPatchBodySchema, json.value)
  const currentMetadata = readPrivateMetadata(org)
  const deliveryChannels = mergeDeliveryChannels(
    deliveryChannelsFromMetadata(currentMetadata),
    body,
    c.env,
  )
  const privateMetadata = {
    ...currentMetadata,
    deliveryChannels,
  }
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const updated = await db.organizations.update(
    { privateMetadata },
    eq(schema.organizations.id, id),
  )
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organization.delivery_channels.updated',
    payload: { orgId: id },
  })
  auditOrgPolicy(c, auth, { orgId: id, action: 'organization.delivery_channels.updated' })
  return c.json(await withDeliveryStatus(c, updated[0]!))
})

async function withSocialActivity(
  c: Context<XidHonoEnv>,
  org: typeof schema.organizations.$inferSelect,
): Promise<ConsoleSocialProvidersWithActivity> {
  const { socialProviders } = toConsoleSocialProviders(org, c.env)
  const activity = await socialProviderActivity(c, org.id, socialProviders)
  return {
    socialProviders: Object.fromEntries(
      Object.entries(socialProviders).map(([provider, policy]) => [
        provider,
        { ...policy, ...(activity[provider] ?? { signIns30d: 0, disabledAt: null }) },
      ]),
    ),
  }
}

function providerToggles(
  before: Readonly<Record<string, SocialProviderPolicy>>,
  after: Readonly<Record<string, SocialProviderPolicy>>,
): { enabledProviders: string[]; disabledProviders: string[] } {
  const keys = Object.keys(after)
  return {
    enabledProviders: keys.filter((key) => after[key]?.enabled && !before[key]?.enabled),
    disabledProviders: keys.filter((key) => !after[key]?.enabled && before[key]?.enabled),
  }
}

// GET /v1/organizations/:id/social-providers
app.get('/:id/social-providers', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'organizations:read')
  const org = await requireOrg(c, id)
  return c.json(await withSocialActivity(c, org))
})

// PATCH /v1/organizations/:id/social-providers
app.patch('/:id/social-providers', async (c) => {
  const id = c.req.param('id')
  const auth = await requireApiKeyOrOrgManager(c, id, 'organizations:write')
  const org = await requireOrg(c, id)
  await assertOrgSelfServiceEditable(c, auth, org)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(policyPatchBodySchema, json.value)
  const currentMetadata = readPrivateMetadata(org)
  const currentProviders = normalizeSocialProviders(currentMetadata['socialProviders']) ?? {}
  const socialProviders = mergeSocialProviders(currentProviders, body, c.env)
  const privateMetadata = {
    ...currentMetadata,
    socialProviders,
  }
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const updated = await db.organizations.update(
    { privateMetadata },
    eq(schema.organizations.id, id),
  )
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organization.social_providers.updated',
    payload: { orgId: id },
  })
  auditOrgMutation(c, auth, {
    action: 'organization.social_providers.updated',
    orgId: id,
    targetType: 'organization',
    targetId: id,
    details: providerToggles(currentProviders, socialProviders),
  })
  return c.json(await withSocialActivity(c, updated[0]!))
})

async function assertValidOutboundSpCertificates(certificates: readonly string[]): Promise<void> {
  if (certificates.length === 0) return
  setSamlEngine(globalThis.crypto)
  const verified = await loadIdpVerifyKeys(certificates)
  if (!verified.ok) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'sp_certificates' },
    })
  }
}

function assertOutboundSloConfiguration(
  sloUrl: string | null | undefined,
  certificates: readonly string[],
): void {
  if (sloUrl && certificates.length === 0) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'sp_certificates' },
    })
  }
}

function toConsoleOutboundSamlApp(
  tenant: TenantContext,
  row: typeof schema.samlServiceProviders.$inferSelect,
) {
  const mapping = row.attributeMapping as Record<string, unknown>
  const gate = parseAssignmentGate(mapping)
  const idp = outboundSamlIdpEndpoints(tenant.issuer, row.id)
  return {
    id: row.id,
    provider: presetKeyFromAttributeMapping(mapping) ?? 'custom',
    spEntityId: row.spEntityId,
    acsUrl: row.acsUrl,
    sloUrl: row.sloUrl,
    sloBinding: row.sloBinding ?? 'redirect',
    spCertificates: row.spCertificates ?? [],
    idpSigningCertId: row.idpSigningCertId,
    attributeMapping: mapping,
    assignmentGate: serializeAssignmentGate(gate),
    nameIdFormat: row.nameIdFormat,
    idpEntityId: idp.entityId,
    idpMetadataUrl: idp.metadataUrl,
    idpSsoUrl: idp.ssoUrl,
    idpSloUrl: idp.sloUrl,
    createdAt: toIso(row.createdAt) ?? '',
  }
}

// GET /v1/organizations/:id/outbound-saml-apps
app.get('/:id/outbound-saml-apps', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'connections:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const rows = await readAllById((cursor) =>
    db.samlServiceProviders.findMany(
      cursor
        ? and(eq(schema.samlServiceProviders.orgId, id), gt(schema.samlServiceProviders.id, cursor))
        : eq(schema.samlServiceProviders.orgId, id),
      { orderBy: asc(schema.samlServiceProviders.id), limit: ORG_LIST_BATCH_SIZE },
    ),
  )
  const [lastSignIns, signingCertificates] = await Promise.all([
    outboundLastSignIns(
      c,
      rows.map((row) => row.id),
    ),
    rows.length === 0 ? Promise.resolve([]) : outboundSigningCertificates(c),
  ])
  return c.json(
    rows.map((row) => ({
      ...toConsoleOutboundSamlApp(c.get('tenant'), row),
      lastSignInAt: lastSignIns.get(row.id) ?? null,
      signingCertificates,
    })),
  )
})

// POST /v1/organizations/:id/outbound-saml-apps
app.post('/:id/outbound-saml-apps', async (c) => {
  const id = c.req.param('id')
  const auth = await requireApiKeyOrOrgManager(c, id, 'connections:write')
  await assertOrgSelfServiceEditable(c, auth, await requireOrg(c, id))
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createOutboundSamlAppBodySchema, json.value)
  const presetKey = body.preset
  const preset = presetKey ? OUTBOUND_SAAS_PRESETS[presetKey as OutboundSaasPresetKey] : undefined
  const spEntityId = body.sp_entity_id ?? preset?.spEntityId
  if (!spEntityId) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'sp_entity_id' },
    })
  }
  const acsUrl = body.acs_url
  if (!acsUrl) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'acs_url' },
    })
  }
  const sloUrl = body.slo_url !== undefined ? body.slo_url : (preset?.sloUrl ?? null)
  const spCertificates = body.sp_certificates ?? []
  assertOptionalPublicHttpsUrl(acsUrl, 'acs_url')
  assertOptionalPublicHttpsUrl(sloUrl, 'slo_url')
  await assertValidOutboundSpCertificates(spCertificates)
  assertOutboundSloConfiguration(sloUrl, spCertificates)
  const signingCertificate = await resolveOrProvisionOutboundSamlSigningCertificate(
    c,
    body.idp_signing_cert_id ?? undefined,
  )
  let attributeMapping: Record<string, unknown> =
    body.attribute_mapping ??
    (preset ? withPresetAttributeMapping(preset.key, preset.attributeMapping) : {})
  const gate = assignmentGateFromBody(body)
  if (gate) attributeMapping = withAssignmentGate(attributeMapping, gate)
  const row = await db.samlServiceProviders.insert({
    id: createPersistedId('samlServiceProvider'),
    tenantId: tenant.tenantId,
    orgId: id,
    spEntityId,
    acsUrl,
    sloUrl,
    sloBinding: body.slo_binding ?? 'redirect',
    spCertificates,
    attributeMapping,
    nameIdFormat:
      body.name_id_format ??
      preset?.nameIdFormat ??
      'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
    idpSigningCertId: signingCertificate.id,
  })
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organization.outbound_saml_app.created',
    payload: { orgId: id, appId: row.id, preset: presetKey ?? null },
  })
  auditOrgMutation(c, auth, {
    action: 'outbound_saml_app.created',
    orgId: id,
    targetType: 'outbound_saml_app',
    targetId: row.id,
  })
  return c.json(toConsoleOutboundSamlApp(c.get('tenant'), row), 201)
})

// PATCH /v1/organizations/:id/outbound-saml-apps/:appId
app.patch('/:id/outbound-saml-apps/:appId', async (c) => {
  const id = c.req.param('id')
  const appId = c.req.param('appId')
  const auth = await requireApiKeyOrOrgManager(c, id, 'connections:write')
  await assertOrgSelfServiceEditable(c, auth, await requireOrg(c, id))
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchOutboundSamlAppBodySchema, json.value)
  const where = and(
    eq(schema.samlServiceProviders.id, appId),
    eq(schema.samlServiceProviders.tenantId, tenant.tenantId),
    eq(schema.samlServiceProviders.orgId, id),
  )
  const existing = await db.samlServiceProviders.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  const nextSloUrl = body.slo_url === undefined ? existing.sloUrl : body.slo_url
  const nextSpCertificates = body.sp_certificates ?? existing.spCertificates ?? []
  if (body.sp_certificates !== undefined || nextSloUrl) {
    await assertValidOutboundSpCertificates(nextSpCertificates)
  }
  assertOutboundSloConfiguration(nextSloUrl, nextSpCertificates)
  const requestedSigningCertificateId =
    body.idp_signing_cert_id === undefined
      ? (existing.idpSigningCertId ?? undefined)
      : (body.idp_signing_cert_id ?? undefined)
  const signingCertificate = await resolveOrProvisionOutboundSamlSigningCertificate(
    c,
    requestedSigningCertificateId,
  )
  const patch: Partial<typeof schema.samlServiceProviders.$inferInsert> = {}
  if (body.sp_entity_id !== undefined) patch.spEntityId = body.sp_entity_id
  if (body.acs_url !== undefined) patch.acsUrl = body.acs_url
  if (body.slo_url !== undefined) patch.sloUrl = body.slo_url
  if (body.slo_binding !== undefined) patch.sloBinding = body.slo_binding
  if (body.sp_certificates !== undefined) patch.spCertificates = body.sp_certificates
  if (body.name_id_format !== undefined) patch.nameIdFormat = body.name_id_format
  if (signingCertificate.id !== existing.idpSigningCertId) {
    patch.idpSigningCertId = signingCertificate.id
  }
  const gate = assignmentGateFromBody(body)
  if (body.attribute_mapping !== undefined) {
    // 预设标记与分配门槛存于 `_` 前缀内部键,请求未带时沿用已有值。
    const internal = Object.fromEntries(
      Object.entries(existing.attributeMapping).filter(([key]) => key.startsWith('_')),
    )
    patch.attributeMapping = { ...internal, ...body.attribute_mapping }
  }
  if (gate) {
    const base = (patch.attributeMapping ?? existing.attributeMapping) as Record<string, unknown>
    patch.attributeMapping = withAssignmentGate(base, gate)
  }
  const updated = await db.samlServiceProviders.update(patch, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  auditOrgMutation(c, auth, {
    action: 'outbound_saml_app.updated',
    orgId: id,
    targetType: 'outbound_saml_app',
    targetId: row.id,
    details: { fields: Object.keys(patch) },
  })
  return c.json(toConsoleOutboundSamlApp(c.get('tenant'), row))
})

// DELETE /v1/organizations/:id/outbound-saml-apps/:appId
app.delete('/:id/outbound-saml-apps/:appId', async (c) => {
  const id = c.req.param('id')
  const appId = c.req.param('appId')
  const auth = await requireApiKeyOrOrgManager(c, id, 'connections:write')
  await assertOrgSelfServiceEditable(c, auth, await requireOrg(c, id))
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(
    eq(schema.samlServiceProviders.id, appId),
    eq(schema.samlServiceProviders.tenantId, tenant.tenantId),
    eq(schema.samlServiceProviders.orgId, id),
  )
  const existing = await db.samlServiceProviders.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  await db.samlServiceProviders.hardDelete(where)
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organization.outbound_saml_app.deleted',
    payload: { orgId: id, appId },
  })
  auditOrgMutation(c, auth, {
    action: 'outbound_saml_app.deleted',
    orgId: id,
    targetType: 'outbound_saml_app',
    targetId: appId,
  })
  return new Response(null, { status: 204 })
})

registerOrganizationScimTargetRoutes(app)

// ---- 创建 ----

// POST /v1/organizations
app.post('/', async (c) => {
  await requireApiKey(c, 'organizations:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createOrgBodySchema, json.value)
  if (body.seat_limit !== undefined) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'seat_limit' },
    })
  }
  assertSlugNotReserved(body.slug)
  const parent = await requireTopLevelParentOrganization(c, body.parent_org_id)

  // slug 实例级唯一:子域解析按 (instance_id, slug) 全局 limit(1)(见 tenant-context.ts resolveMultiTenant),
  // 冲突检查必须同域;仅同租户 deleted 行允许复活,他租户占用一律 409(不指明持有者,枚举防护)。
  const existing = await findOrgByInstanceSlug(c, body.slug)
  if (existing?.status === 'deleted' && existing.tenantId === tenant.tenantId) {
    if (existing.parentOrgId !== parent.id) {
      throw new AppError('already_exists', {
        httpStatus: 409,
        meta: { paramName: 'slug' },
      })
    }
    const updated = await db.organizations.update(
      {
        name: body.name,
        publicMetadata: body.public_metadata ?? {},
        privateMetadata: body.private_metadata ?? {},
        enrollmentMode: body.enrollment_mode ?? 'invite_required',
        status: 'active',
        deletedAt: null,
      },
      eq(schema.organizations.id, existing.id),
    )
    emitWebhookAsync(c, {
      tenantId: tenant.tenantId,
      event: 'organization.created',
      payload: { orgId: existing.id },
    })
    return c.json(toResponse(updated[0]!), 201)
  }
  if (existing)
    throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'slug' } })

  const id = createPersistedId('organization')
  const org = await db.organizations.insert({
    id,
    tenantId: tenant.tenantId,
    // instance_id 取 TenantContext.instanceId(buildContext 产出);缺省回退 tenantId 兼容旧上下文。
    instanceId: tenant.instanceId ?? tenant.tenantId,
    parentOrgId: parent.id,
    slug: body.slug,
    name: body.name,
    publicMetadata: body.public_metadata ?? {},
    privateMetadata: body.private_metadata ?? {},
    enrollmentMode: body.enrollment_mode ?? 'invite_required',
    status: 'active',
  })
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organization.created',
    payload: { orgId: id },
  })
  return c.json(toResponse(org), 201)
})

// ---- 更新 ----

// PATCH /v1/organizations/:id
app.patch('/:id', async (c) => {
  const apiKey = await requireApiKey(c, 'organizations:write')
  const id = c.req.param('id')
  await requireOrg(c, id)

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchOrgBodySchema, json.value)
  if (body.seat_limit !== undefined && id !== tenant.tenantId) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'seat_limit' },
    })
  }

  const patch: Partial<typeof schema.organizations.$inferInsert> = {}
  if (body.name !== undefined) patch.name = body.name
  if (body.slug !== undefined) {
    assertSlugNotReserved(body.slug)
    // 与 POST 同一实例级冲突检查(排除自身):不改这里,改 slug 即可抢占他租户子域。
    const conflict = await findOrgByInstanceSlug(c, body.slug)
    if (conflict && conflict.id !== id) {
      throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'slug' } })
    }
    patch.slug = body.slug
  }
  if (body.public_metadata !== undefined) patch.publicMetadata = body.public_metadata
  if (body.private_metadata !== undefined) patch.privateMetadata = body.private_metadata
  if (body.enrollment_mode !== undefined) patch.enrollmentMode = body.enrollment_mode
  if (body.allow_org_self_service !== undefined)
    patch.allowOrgSelfService = body.allow_org_self_service

  if (body.seat_limit !== undefined) {
    const now = Date.now()
    await c.env.DB.batch([
      buildSeatLimitMirrorStatement(c.env, {
        tenantId: tenant.tenantId,
        seatLimit: body.seat_limit,
        now,
      }),
      buildOrganizationQuotaUpsertStatement(c.env, {
        tenantId: tenant.tenantId,
        quota: {
          key: 'seats',
          limit: body.seat_limit,
          enforcement: 'observe',
        },
        updatedBy: apiKey.id,
        now,
      }),
    ])
  }
  const updated =
    Object.keys(patch).length === 0
      ? [await db.organizations.findOne(eq(schema.organizations.id, id))]
      : await db.organizations.update(patch, eq(schema.organizations.id, id))
  if (!updated[0]) throw new AppError('not_found', { httpStatus: 404 })
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organization.updated',
    payload: { orgId: id },
  })
  return c.json(toResponse(updated[0]!))
})

// ---- 删除 ----

// DELETE /v1/organizations/:id
app.delete('/:id', async (c) => {
  await requireApiKey(c, 'organizations:write')
  const id = c.req.param('id')
  const organization = await requireOrg(c, id)
  await requireRestorableChildParent(c, organization)

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  // 软删除
  await db.organizations.update(
    { deletedAt: new Date(), status: 'deleted' },
    eq(schema.organizations.id, id),
  )
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organization.deleted',
    payload: { orgId: id },
  })
  return new Response(null, { status: 204 })
})

// POST /v1/organizations/:id/restore
app.post('/:id/restore', async (c) => {
  await requireApiKey(c, 'organizations:write')
  const id = c.req.param('id')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(eq(schema.organizations.id, id), eq(schema.organizations.status, 'deleted'))
  const existing = await db.organizations.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  await requireRestorableChildParent(c, existing)

  const updated = await db.organizations.update({ status: 'active', deletedAt: null }, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organization.restored',
    payload: { orgId: id },
  })
  return c.json(toResponse(row))
})

// /v1/organizations 家族统一在此注册,子模块按资源拆分。
export function registerOrganizationsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/organizations', app)
  registerOrgMembersRoutes(honoApp)
  registerOrgDomainsRoutes(honoApp)
  registerOrgBrandingRoutes(honoApp)
  registerOrgAuditRoutes(honoApp)
}
