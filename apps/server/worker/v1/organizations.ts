// Management API v1: /v1/organizations 组织资源。
// CRUD + list(cursor) + logo 上传 + 域名管理。
// 认证:sk_live_ Bearer。租户隔离:createTenantDb。
// Instance Manager 跨 org 走独立管理路径(此模块为 Org Admin 视角,见 tenant-isolation rule)。

import { createTenantDb, schema } from '@xid-kit/db'
import { sha256Hex } from '@xid-kit/crypto'
import {
  DEFAULT_SAML_CLOCK_SKEW_MS,
  MAX_SAML_CLOCK_SKEW_MS,
  loadIdpVerifyKeys,
  setSamlEngine,
} from '@xid-kit/saml'
import type {
  DeliveryChannelProviderPolicy,
  HostedAuthPolicy,
  SocialProviderPolicy,
} from '@xid-kit/types'
import {
  DEFAULT_HOSTED_AUTH_POLICY,
  ORGANIZATION_MEMBERSHIP_ROLES,
  SESSION_POLICY_BOUNDS,
  TOKEN_POLICY_BOUNDS,
  normalizeDeliveryChannelsPolicy,
  normalizeHostedAuthPolicy,
  normalizeSocialProviders,
} from '@xid-kit/types'
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import { auditActorDisplay } from '../lib/audit-actor'
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
import { hasProviderSecret, socialProviderSecretBinding } from '../auth/social-providers'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import {
  buildOrganizationQuotaUpsertStatement,
  buildSeatLimitMirrorStatement,
} from '../platform/plans'
import {
  assertHeaderConnectionConfig,
  assertInboundSsoProtocol,
  isInboundSsoProtocol,
} from '../sso/legacy-shared'
import { enqueueScimTargetSync } from '../scim/outbound'
import {
  normalizeScimTargetBaseUrl,
  scimTargetHasToken,
  scimTargetTokenSecretName,
} from '../scim/target-credentials'
import { SCIM_TOKEN_ROTATE_GRACE_MS } from '../lib/ttl'
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
  presetKeyFromAttributeMapping,
  withPresetAttributeMapping,
  type InboundIdpPresetKey,
  type LegacyInboundPresetKey,
  type OutboundSaasPresetKey,
} from '../sso/provider-presets'
import { resolveOrProvisionOutboundSamlSigningCertificate } from '../sso/signing-certificate'
import {
  requireApiKey,
  requireApiKeyOrOrgManager,
  MAX_PAGE_SIZE,
  paginate,
  idAfterCursor,
  encodeCursor,
  decodeCursor,
  requireOrg,
  emitWebhookAsync,
  type OrgScopedAuth,
} from './shared'

const app = new Hono<XidHonoEnv>()
const ORG_STATS_MEMBER_BATCH_SIZE = 100
const ORG_LIST_BATCH_SIZE = 100

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

const createDomainBodySchema = v.object({
  domain: v.pipe(v.string(), v.minLength(1)),
  enrollment_mode: v.optional(enrollmentModeSchema),
})

// branding 走 KV 存储的 ConsoleBranding 七字段;null 与缺省同义(回退当前值)。
const brandingPatchBodySchema = v.object({
  primaryColor: v.optional(v.nullable(v.string())),
  backgroundColor: v.optional(v.nullable(v.string())),
  accentColor: v.optional(v.nullable(v.string())),
  borderRadius: v.optional(v.nullable(v.string())),
  fontFamily: v.optional(v.nullable(v.string())),
  logoUrl: v.optional(v.nullable(v.string())),
  logoDarkUrl: v.optional(v.nullable(v.string())),
})

// auth-policy / delivery-channels / social-providers 的 PATCH body 只要求"是对象":
// 字段级语义由 domain normalize 处理,schema 不做字段约束。
const policyPatchBodySchema = v.record(v.string(), v.unknown())

const createSsoConnectionBodySchema = v.object({
  preset: v.optional(v.string()),
  protocol: v.optional(v.string()),
  idp_entity_id: v.optional(v.string()),
  idp_sso_url: v.optional(publicHttpsUrlSchema),
  idp_slo_url: v.optional(v.nullable(publicHttpsUrlSchema)),
  idp_metadata_url: v.optional(publicHttpsUrlSchema),
  idp_certificates: v.optional(v.array(v.string())),
  oidc_client_id: v.optional(v.string()),
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
  idp_entity_id: v.optional(v.string()),
  idp_sso_url: v.optional(publicHttpsUrlSchema),
  idp_slo_url: v.optional(v.nullable(publicHttpsUrlSchema)),
  idp_metadata_url: v.optional(publicHttpsUrlSchema),
  idp_certificates: v.optional(v.array(v.string())),
  oidc_client_id: v.optional(v.string()),
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

const createDirectoryBodySchema = v.object({
  provider: v.pipe(v.string(), v.minLength(1)),
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

// scim-targets 的三必填项缺失统一报 paramName 'base_url'(既有契约),故 schema 只做类型层,
// 必填守卫留在 handler。
const scimTargetBodySchema = v.object({
  provider: v.optional(v.string()),
  base_url: v.optional(v.string()),
  token_secret_ref: v.optional(v.string()),
  assignment_gate: assignmentGateFieldSchema,
  assignmentGate: assignmentGateFieldSchema,
})

type ConsolePage<T> = {
  data: T[]
  nextCursor: string | null
  total: number
}

type ConsoleBranding = {
  primaryColor: string | null
  backgroundColor: string | null
  accentColor: string | null
  borderRadius: string | null
  fontFamily: string | null
  logoUrl: string | null
  logoDarkUrl: string | null
}

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
}

type ConsoleSocialProviders = {
  socialProviders: Record<string, ConsoleSocialProviderPolicy>
}

type ResolvedDeliveryChannelsPolicy = {
  whatsapp: DeliveryChannelProviderPolicy
  sms: DeliveryChannelProviderPolicy
}

const DEFAULT_BRANDING: ConsoleBranding = {
  primaryColor: null,
  backgroundColor: null,
  accentColor: null,
  borderRadius: null,
  fontFamily: null,
  logoUrl: null,
  logoDarkUrl: null,
}

type OrgStats = {
  dau: number
  mau: number
  loginSuccessRate: number
  mfaAdoptionRate: number
  activeMemberCount: number
  pendingInvitationCount: number
}

const LOGIN_SUCCESS_EVENTS = ['authentication.login_succeeded', 'user.signed_in'] as const
const LOGIN_FAILURE_EVENTS = ['authentication.login_failed', 'user.sign_in_failed'] as const

function toIso(value: Date | number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return new Date(value).toISOString()
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function utcYearMonth(now: Date): string {
  return now.toISOString().slice(0, 7)
}

function ratio(numerator: number, denominator: number, fallback: number): number {
  return denominator === 0 ? fallback : numerator / denominator
}

function consolePage<T>(
  rows: T[],
  getId: (row: T) => string,
  limit: number,
  total = rows.length,
): ConsolePage<T> {
  const hasMore = rows.length > limit
  const data = hasMore ? rows.slice(0, limit) : rows
  const last = data[data.length - 1]
  return {
    data,
    nextCursor: hasMore && last !== undefined ? encodeCursor(getId(last)) : null,
    total,
  }
}

async function readAllById<T extends { id: string }>(
  readPage: (cursor: string | null) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = []
  let cursor: string | null = null
  while (true) {
    const page = await readPage(cursor)
    if (page.length === 0) break
    rows.push(...page)
    cursor = page[page.length - 1]?.id ?? null
    if (page.length < ORG_LIST_BATCH_SIZE) break
  }
  return rows
}

async function readAllByIds<T extends { id: string }>(
  ids: readonly string[],
  readPage: (ids: readonly string[], cursor: string | null) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; offset < ids.length; offset += ORG_LIST_BATCH_SIZE) {
    rows.push(
      ...(await readAllById((cursor) =>
        readPage(ids.slice(offset, offset + ORG_LIST_BATCH_SIZE), cursor),
      )),
    )
  }
  return rows
}

async function buildOrgStats(c: Context<XidHonoEnv>, orgId: string): Promise<OrgStats> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const now = new Date()

  const [usageDay, usageMonth, memberUserIds, pendingInvitationCount] = await Promise.all([
    db.usageDaily.findOne(eq(schema.usageDaily.day, utcDay(now))),
    db.usageMonthly.findOne(eq(schema.usageMonthly.yearMonth, utcYearMonth(now))),
    listActiveMemberUserIds(db, orgId),
    db.forOrg(orgId).invitations.count(eq(schema.invitations.status, 'pending')),
  ])

  const orgAuditFilter = or(eq(schema.auditEvents.orgId, orgId), isNull(schema.auditEvents.orgId))
  const mfaUserCount = await countActiveMfaUsers(db, memberUserIds)
  const [loginSuccesses, loginFailures] = await Promise.all([
    db.auditEvents.count(
      and(orgAuditFilter, inArray(schema.auditEvents.eventType, [...LOGIN_SUCCESS_EVENTS])),
    ),
    db.auditEvents.count(
      and(orgAuditFilter, inArray(schema.auditEvents.eventType, [...LOGIN_FAILURE_EVENTS])),
    ),
  ])
  const totalLogins = loginSuccesses + loginFailures

  return {
    dau: Number(usageDay?.dau ?? 0),
    mau: Number(usageMonth?.mau ?? 0),
    loginSuccessRate: ratio(loginSuccesses, totalLogins, 1),
    mfaAdoptionRate: ratio(mfaUserCount, memberUserIds.length, 0),
    activeMemberCount: memberUserIds.length,
    pendingInvitationCount,
  }
}

async function listActiveMemberUserIds(
  db: ReturnType<typeof createTenantDb>,
  orgId: string,
): Promise<string[]> {
  const orgDb = db.forOrg(orgId)
  const userIds: string[] = []
  let cursor: string | null = null
  while (true) {
    const after = cursor ? gt(schema.memberships.id, cursor) : undefined
    const rows = await orgDb.memberships.findMany(
      after
        ? and(eq(schema.memberships.status, 'active'), after)
        : eq(schema.memberships.status, 'active'),
      { orderBy: asc(schema.memberships.id), limit: ORG_STATS_MEMBER_BATCH_SIZE },
    )
    if (rows.length === 0) break
    userIds.push(...rows.map((row) => row.userId))
    cursor = rows[rows.length - 1]?.id ?? null
    if (rows.length < ORG_STATS_MEMBER_BATCH_SIZE) break
  }
  return [...new Set(userIds)]
}

async function countActiveMfaUsers(
  db: ReturnType<typeof createTenantDb>,
  userIds: readonly string[],
): Promise<number> {
  let count = 0
  for (let offset = 0; offset < userIds.length; offset += ORG_STATS_MEMBER_BATCH_SIZE) {
    const batch = userIds.slice(offset, offset + ORG_STATS_MEMBER_BATCH_SIZE)
    count += await db.mfaFactors.countDistinct(
      schema.mfaFactors.userId,
      and(eq(schema.mfaFactors.status, 'active'), inArray(schema.mfaFactors.userId, batch)),
    )
  }
  return count
}

function toConsoleDomain(row: typeof schema.organizationDomains.$inferSelect) {
  return {
    id: row.id,
    domain: row.domain,
    verified: row.verificationStatus === 'verified',
    enrollmentMode: row.enrollmentMode,
    verificationToken: row.verificationToken,
    verifiedAt: toIso(row.verifiedAt),
  }
}

function readBranding(raw: string | null): ConsoleBranding {
  if (!raw) return DEFAULT_BRANDING
  try {
    const value = JSON.parse(raw) as Partial<ConsoleBranding>
    return { ...DEFAULT_BRANDING, ...value }
  } catch {
    return DEFAULT_BRANDING
  }
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

// org 行转对外响应(白名单):private_metadata 含策略与 secret ref,不直接下发,
// console 需要的策略字段走 auth-policy / delivery-channels / social-providers 显式端点。
function toResponse(row: typeof schema.organizations.$inferSelect) {
  return {
    id: row.id,
    parent_org_id: row.parentOrgId,
    slug: row.slug,
    name: row.name,
    logo_url: row.logoUrl,
    public_metadata: row.publicMetadata,
    enrollment_mode: row.enrollmentMode,
    seat_limit: row.seatLimit,
    seat_used: row.seatUsed,
    allow_org_self_service: row.allowOrgSelfService,
    status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

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

// 域名行 sk 路径响应:verificationToken 属设计保留(域名验证流程要向用户展示),
// 收窄 tenant_id / verification_method / deleted_at 等内部列。
function toDomainResponse(row: typeof schema.organizationDomains.$inferSelect) {
  return {
    id: row.id,
    org_id: row.orgId,
    domain: row.domain,
    verification_token: row.verificationToken,
    verification_status: row.verificationStatus,
    is_wildcard: row.isWildcard,
    enrollment_mode: row.enrollmentMode,
    verified_at: row.verifiedAt,
    status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

// instance_manager 分配在平台层(scope=instance),不经租户查询层,raw drizzle 按 userId 直查
// (同 me.ts isInstanceManager;租户层会注入 tenant_id 漏查他租户分配)。
async function isInstanceManagerUser(c: Context<XidHonoEnv>, userId: string): Promise<boolean> {
  const db = drizzle(c.env.DB, { schema })
  const rows = await db
    .select({ id: schema.managerAssignments.id })
    .from(schema.managerAssignments)
    .where(
      and(
        eq(schema.managerAssignments.userId, userId),
        eq(schema.managerAssignments.managerRole, 'instance_manager'),
        eq(schema.managerAssignments.scopeType, 'instance'),
      ),
    )
    .limit(1)
  return rows.length > 0
}

// 平台关闭 org 自助策略(allow_org_self_service=false)时 org admin 不得改 SSO/MFA/登录策略(见 02 章 6);
// sk 路径与 instance_manager 不受影响,故仅 org_console 分支检查。
async function assertOrgSelfServiceEditable(
  c: Context<XidHonoEnv>,
  auth: OrgScopedAuth,
  org: typeof schema.organizations.$inferSelect,
): Promise<void> {
  if (auth.kind !== 'org_console' || org.allowOrgSelfService !== false) return
  if (await isInstanceManagerUser(c, auth.session.userId)) return
  throw new AppError('forbidden', { httpStatus: 403 })
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

// D1 唯一约束冲突识别:drizzle 会把原始错误包成 DrizzleQueryError(message 只有 Failed query),
// 真实的 UNIQUE constraint 消息在 cause 链上,故沿 cause 递归匹配。
function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (/unique constraint/iu.test(error.message)) return true
  return error.cause !== undefined && isUniqueConstraintError(error.cause)
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

function toConsoleAuthPolicy(
  org: typeof schema.organizations.$inferSelect,
  env: Env,
  policy?: typeof schema.orgPolicies.$inferSelect,
): ConsoleAuthPolicy {
  const metadata = readPrivateMetadata(org)
  return {
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
            redirectUris: policy.redirectUris,
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
    redirectUris: readStringArrayField(
      raw,
      ['redirectUris', 'redirect_uris'],
      existing?.redirectUris,
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
async function upsertOrgSessionTokenPolicy(
  orgDb: ReturnType<ReturnType<typeof createTenantDb>['forOrg']>,
  tenantId: string,
  rawSession: unknown,
  tokenPatch: TokenPolicyPatch | null,
): Promise<typeof schema.orgPolicies.$inferSelect> {
  const updates: Partial<typeof schema.orgPolicies.$inferInsert> = {}
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

function brandingKey(tenantId: string, orgId: string): string {
  return `brand:${tenantId}:${orgId}`
}

async function toConsoleMembers(
  c: Context<XidHonoEnv>,
  rows: readonly (typeof schema.memberships.$inferSelect)[],
) {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  if (rows.length === 0) return []
  const userIds = [...new Set(rows.map((row) => row.userId))]
  const [users, emails] = await Promise.all([
    readAllByIds(userIds, (batch, cursor) =>
      db.users.findMany(
        and(inArray(schema.users.id, batch), ...(cursor ? [gt(schema.users.id, cursor)] : [])),
        { orderBy: asc(schema.users.id), limit: ORG_LIST_BATCH_SIZE },
      ),
    ),
    readAllByIds(userIds, (batch, cursor) =>
      db.userEmails.findMany(
        and(
          inArray(schema.userEmails.userId, batch),
          ...(cursor ? [gt(schema.userEmails.id, cursor)] : []),
        ),
        { orderBy: asc(schema.userEmails.id), limit: ORG_LIST_BATCH_SIZE },
      ),
    ),
  ])
  const userById = new Map(users.map((user) => [user.id, user]))
  const emailsByUser = new Map<string, (typeof schema.userEmails.$inferSelect)[]>()
  for (const email of emails) {
    emailsByUser.set(email.userId, [...(emailsByUser.get(email.userId) ?? []), email])
  }
  return rows.map((row) => {
    const user = userById.get(row.userId)
    const candidates = emailsByUser.get(row.userId) ?? []
    const email =
      candidates.find((candidate) => candidate.id === user?.primaryEmailId) ??
      candidates.find((candidate) => candidate.isPrimary) ??
      candidates[0]
    const parts = [user?.firstName, user?.lastName].filter((part): part is string => Boolean(part))
    return {
      id: row.id,
      userId: row.userId,
      email: email?.email ?? '',
      name: user?.displayName ?? (parts.length > 0 ? parts.join(' ') : null),
      role: row.role,
      status: row.status,
      joinedAt: toIso(row.joinedAt) ?? toIso(row.createdAt) ?? '',
    }
  })
}

async function toConsoleRoles(
  c: Context<XidHonoEnv>,
  rows: readonly (typeof schema.roles.$inferSelect)[],
) {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  if (rows.length === 0) return []
  const links = await readAllByIds(
    rows.map((row) => row.id),
    (batch, cursor) =>
      db.rolePermissions.findMany(
        and(
          inArray(schema.rolePermissions.roleId, batch),
          ...(cursor ? [gt(schema.rolePermissions.id, cursor)] : []),
        ),
        { orderBy: asc(schema.rolePermissions.id), limit: ORG_LIST_BATCH_SIZE },
      ),
  )
  const permissionIds = [...new Set(links.map((link) => link.permissionId))]
  const permissions =
    permissionIds.length === 0
      ? []
      : await readAllByIds(permissionIds, (batch, cursor) =>
          db.permissions.findMany(
            and(
              inArray(schema.permissions.id, batch),
              eq(schema.permissions.status, 'active'),
              ...(cursor ? [gt(schema.permissions.id, cursor)] : []),
            ),
            { orderBy: asc(schema.permissions.id), limit: ORG_LIST_BATCH_SIZE },
          ),
        )
  const permissionKeys = new Map(permissions.map((permission) => [permission.id, permission.key]))
  const permissionsByRole = new Map<string, string[]>()
  for (const link of links) {
    const key = permissionKeys.get(link.permissionId)
    if (key)
      permissionsByRole.set(link.roleId, [...(permissionsByRole.get(link.roleId) ?? []), key])
  }
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    displayName: row.displayName,
    group: row.group,
    permissions: permissionsByRole.get(row.id) ?? [],
  }))
}

function toConsoleSsoConnection(row: typeof schema.ssoConnections.$inferSelect) {
  // attributeMapping 里 `_` 前缀键(_swaVault / _swaVaultEnvelope)存 SWA vault 信封加密的凭证材料,
  // 与 v1/connections.ts stripInternalAttributeMapping 同一约定:响应一律剔除,写路径不受影响。
  const attributeMapping = Object.fromEntries(
    Object.entries(row.attributeMapping).filter(([key]) => !key.startsWith('_')),
  )
  return {
    id: row.id,
    name: row.idpEntityId ?? row.oidcDiscoveryUrl ?? row.protocol.toUpperCase(),
    type: isInboundSsoProtocol(row.protocol) ? row.protocol : 'saml',
    domain: row.idpSsoUrl ?? row.oidcDiscoveryUrl ?? '',
    idp_entity_id: row.idpEntityId,
    idp_sso_url: row.idpSsoUrl,
    idp_slo_url: row.idpSloUrl,
    idp_metadata_url: row.idpMetadataUrl,
    idp_certificates: row.idpCertificates,
    oidc_client_id: row.oidcClientId,
    oidc_discovery_url: row.oidcDiscoveryUrl,
    want_authn_response_signed: row.wantAuthnResponseSigned,
    want_assertions_signed: row.wantAssertionsSigned,
    saml_clock_skew_ms: row.samlClockSkewMs,
    attribute_mapping: attributeMapping,
    role_mapping: row.roleMapping,
    jit_enabled: row.jitEnabled,
    status: row.status === 'active' ? 'active' : 'inactive',
    createdAt: toIso(row.createdAt) ?? '',
  }
}

function genScimToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

async function toConsoleDirectory(
  c: Context<XidHonoEnv>,
  row: typeof schema.directories.$inferSelect,
) {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const [userCount, groupCount] = await Promise.all([
    db.directoryUsers.count(
      and(
        eq(schema.directoryUsers.directoryId, row.id),
        ne(schema.directoryUsers.status, 'deleted'),
        isNull(schema.directoryUsers.deletedAt),
      ),
    ),
    db.directoryGroups.count(
      and(
        eq(schema.directoryGroups.directoryId, row.id),
        ne(schema.directoryGroups.status, 'deleted'),
        isNull(schema.directoryGroups.deletedAt),
      ),
    ),
  ])
  return {
    id: row.id,
    name: row.provider,
    provider: row.provider,
    status: row.status === 'active' ? 'active' : 'inactive',
    lastSyncAt: toIso(row.lastSyncAt),
    userCount,
    groupCount,
  }
}

async function toConsoleDirectories(
  c: Context<XidHonoEnv>,
  rows: readonly (typeof schema.directories.$inferSelect)[],
) {
  if (rows.length === 0) return []
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const userCounts = new Map<string, number>()
  const groupCounts = new Map<string, number>()
  for (let start = 0; start < rows.length; start += ORG_LIST_BATCH_SIZE) {
    const directoryIds = rows.slice(start, start + ORG_LIST_BATCH_SIZE).map((row) => row.id)
    const [userRows, groupRows] = await Promise.all([
      db.directoryUsers.countBy(
        schema.directoryUsers.directoryId,
        and(
          inArray(schema.directoryUsers.directoryId, directoryIds),
          ne(schema.directoryUsers.status, 'deleted'),
          isNull(schema.directoryUsers.deletedAt),
        ),
      ),
      db.directoryGroups.countBy(
        schema.directoryGroups.directoryId,
        and(
          inArray(schema.directoryGroups.directoryId, directoryIds),
          ne(schema.directoryGroups.status, 'deleted'),
          isNull(schema.directoryGroups.deletedAt),
        ),
      ),
    ])
    for (const [directoryId, count] of userRows) userCounts.set(directoryId, count)
    for (const [directoryId, count] of groupRows) groupCounts.set(directoryId, count)
  }
  return rows.map((row) => ({
    id: row.id,
    name: row.provider,
    provider: row.provider,
    status: row.status === 'active' ? 'active' : 'inactive',
    lastSyncAt: toIso(row.lastSyncAt),
    userCount: userCounts.get(row.id) ?? 0,
    groupCount: groupCounts.get(row.id) ?? 0,
  }))
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

// GET /v1/organizations/:id/stats
app.get('/:id/stats', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'organizations:read')
  return c.json(await buildOrgStats(c, id))
})

// GET /v1/organizations/:id
app.get('/:id', async (c) => {
  await requireApiKey(c, 'organizations:read')
  const org = await requireOrg(c, c.req.param('id'))
  return c.json(toResponse(org))
})

// GET /v1/organizations/:id/members
app.get('/:id/members', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'memberships:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const orgDb = db.forOrg(id)
  const query = validateQuery(paginationQuerySchema, c.req.query())
  const limit = query.limit ?? MAX_PAGE_SIZE
  const cursor = query.cursor ?? null
  const active = eq(schema.memberships.status, 'active')
  const afterCond = idAfterCursor(schema.memberships.id, cursor)
  const where = afterCond ? and(active, afterCond) : active
  const [total, rows] = await Promise.all([
    orgDb.memberships.count(active),
    orgDb.memberships.findMany(where, {
      orderBy: asc(schema.memberships.id),
      limit: limit + 1,
    }),
  ])
  const data = await toConsoleMembers(c, rows)
  return c.json(consolePage(data, (row) => row.id, limit, total))
})

// DELETE /v1/organizations/:id/members/:memberId
app.delete('/:id/members/:memberId', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'memberships:write')
  const memberId = c.req.param('memberId')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const orgDb = db.forOrg(id)
  const where = and(eq(schema.memberships.id, memberId), eq(schema.memberships.status, 'active'))
  const existing = await orgDb.memberships.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  await orgDb.memberships.update({ status: 'inactive' }, where)
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organizationMembership.deleted',
    payload: { orgId: id, membershipId: memberId, userId: existing.userId },
  })
  return new Response(null, { status: 204 })
})

// GET /v1/organizations/:id/roles
app.get('/:id/roles', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'roles:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const projects = await readAllById((cursor) =>
    db
      .forOrg(id)
      .projects.findMany(
        cursor
          ? and(
              eq(schema.projects.orgId, id),
              eq(schema.projects.status, 'active'),
              gt(schema.projects.id, cursor),
            )
          : and(eq(schema.projects.orgId, id), eq(schema.projects.status, 'active')),
        { orderBy: asc(schema.projects.id), limit: ORG_LIST_BATCH_SIZE },
      ),
  )
  const projectIds = projects.map((p) => p.id)
  if (projectIds.length === 0) return c.json([])
  const rows = await readAllByIds(projectIds, (batch, cursor) =>
    db.roles.findMany(
      and(
        inArray(schema.roles.projectId, batch),
        eq(schema.roles.status, 'active'),
        ...(cursor ? [gt(schema.roles.id, cursor)] : []),
      ),
      { orderBy: asc(schema.roles.id), limit: ORG_LIST_BATCH_SIZE },
    ),
  )
  return c.json(await toConsoleRoles(c, rows))
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
  return c.json(rows.map(toConsoleSsoConnection))
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
    idpEntityId: body.idp_entity_id ?? preset?.idpEntityId,
    idpSsoUrl,
    idpSloUrl,
    idpMetadataUrl,
    idpCertificates: body.idp_certificates ?? [],
    oidcClientId: body.oidc_client_id,
    oidcDiscoveryUrl,
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
  return c.json(toConsoleSsoConnection(row!), 201)
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
  if (body.idp_entity_id !== undefined) patch.idpEntityId = body.idp_entity_id
  if (body.idp_sso_url !== undefined) patch.idpSsoUrl = body.idp_sso_url
  if (body.idp_slo_url !== undefined) patch.idpSloUrl = body.idp_slo_url
  if (body.idp_metadata_url !== undefined) patch.idpMetadataUrl = body.idp_metadata_url
  if (body.idp_certificates !== undefined) patch.idpCertificates = body.idp_certificates
  if (body.oidc_client_id !== undefined) patch.oidcClientId = body.oidc_client_id
  if (body.oidc_discovery_url !== undefined) patch.oidcDiscoveryUrl = body.oidc_discovery_url
  if (body.attribute_mapping !== undefined) {
    assertHeaderConnectionConfig(existing.protocol, body.attribute_mapping)
    patch.attributeMapping = body.attribute_mapping
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
  return c.json(toConsoleSsoConnection(row))
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
  return new Response(null, { status: 204 })
})

// GET /v1/organizations/:id/directories
app.get('/:id/directories', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'directories:read')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const rows = await readAllById((cursor) =>
    db
      .forOrg(id)
      .directories.findMany(
        cursor
          ? and(eq(schema.directories.status, 'active'), gt(schema.directories.id, cursor))
          : eq(schema.directories.status, 'active'),
        { orderBy: asc(schema.directories.id), limit: ORG_LIST_BATCH_SIZE },
      ),
  )
  return c.json(await toConsoleDirectories(c, rows))
})

// POST /v1/organizations/:id/directories
app.post('/:id/directories', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'directories:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createDirectoryBodySchema, json.value)
  const provider = body.provider
  const token = genScimToken()
  const row = await db.directories.insert({
    id: createPersistedId('directory'),
    tenantId: tenant.tenantId,
    orgId: id,
    provider,
    scimTokenHash: await sha256Hex(token),
    status: 'active',
    syncStatus: 'idle',
  })
  return c.json({ ...(await toConsoleDirectory(c, row)), scimToken: token }, 201)
})

// POST /v1/organizations/:id/directories/:directoryId/rotate-token
app.post('/:id/directories/:directoryId/rotate-token', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'directories:write')
  const directoryId = c.req.param('directoryId')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(
    eq(schema.directories.id, directoryId),
    eq(schema.directories.orgId, id),
    eq(schema.directories.status, 'active'),
  )
  const existing = await db.directories.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  const token = genScimToken()
  await db.directories.update(
    {
      scimTokenHashPrev: existing.scimTokenHash,
      scimTokenPrevExpires: new Date(Date.now() + SCIM_TOKEN_ROTATE_GRACE_MS),
      scimTokenHash: await sha256Hex(token),
    },
    where,
  )
  return c.json({ scimToken: token })
})

// GET /v1/organizations/:id/branding
app.get('/:id/branding', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'branding:read')
  const tenant = c.get('tenant')
  const raw = await c.env.CACHE.get(brandingKey(tenant.tenantId, id))
  return c.json(readBranding(raw))
})

// GET /v1/organizations/:id/auth-policy
app.get('/:id/auth-policy', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'organizations:read')
  const org = await requireOrg(c, id)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const policy = await db.forOrg(id).orgPolicies.findOne()
  return c.json(toConsoleAuthPolicy(org, c.env, policy))
})

// PATCH /v1/organizations/:id/auth-policy
app.patch('/:id/auth-policy', async (c) => {
  const id = c.req.param('id')
  const auth = await requireApiKeyOrOrgManager(c, id, 'organizations:write')
  const org = await requireOrg(c, id)
  await assertOrgSelfServiceEditable(c, auth, org)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(policyPatchBodySchema, json.value)
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
    rawSession !== undefined || tokenPatch !== null
      ? await upsertOrgSessionTokenPolicy(orgDb, tenant.tenantId, rawSession, tokenPatch)
      : await orgDb.orgPolicies.findOne()
  const updated = await db.organizations.update(
    { privateMetadata },
    eq(schema.organizations.id, id),
  )
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organization.auth_policy.updated',
    payload: { orgId: id },
  })
  return c.json(toConsoleAuthPolicy(updated[0]!, c.env, policy))
})

// GET /v1/organizations/:id/delivery-channels
app.get('/:id/delivery-channels', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'organizations:read')
  const org = await requireOrg(c, id)
  return c.json(toConsoleDeliveryChannels(org, c.env))
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
  return c.json(toConsoleDeliveryChannels(updated[0]!, c.env))
})

// GET /v1/organizations/:id/social-providers
app.get('/:id/social-providers', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'organizations:read')
  const org = await requireOrg(c, id)
  return c.json(toConsoleSocialProviders(org, c.env))
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
  const socialProviders = mergeSocialProviders(
    normalizeSocialProviders(currentMetadata['socialProviders']) ?? {},
    body,
    c.env,
  )
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
  return c.json(toConsoleSocialProviders(updated[0]!, c.env))
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

function toConsoleOutboundSamlApp(row: typeof schema.samlServiceProviders.$inferSelect) {
  const mapping = row.attributeMapping as Record<string, unknown>
  const gate = parseAssignmentGate(mapping)
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
    metadataPath: `/sso/outbound/saml/${row.id}/metadata`,
    ssoPath: `/sso/outbound/saml/${row.id}/sso`,
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
  return c.json(rows.map(toConsoleOutboundSamlApp))
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
  return c.json(toConsoleOutboundSamlApp(row), 201)
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
    patch.attributeMapping = body.attribute_mapping
  }
  if (gate) {
    const base = (patch.attributeMapping ?? existing.attributeMapping) as Record<string, unknown>
    patch.attributeMapping = withAssignmentGate(base, gate)
  }
  const updated = await db.samlServiceProviders.update(patch, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  return c.json(toConsoleOutboundSamlApp(row))
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
  return new Response(null, { status: 204 })
})

function toConsoleScimTarget(row: typeof schema.scimTargets.$inferSelect, env: Env) {
  const filter = row.userFilter as Record<string, unknown>
  return {
    id: row.id,
    provider: row.provider,
    baseUrl: row.baseUrl,
    requiredTokenSecretName: scimTargetTokenSecretName(row.id),
    hasTokenSecret: scimTargetHasToken(env, row.id),
    assignmentGate: serializeAssignmentGate(parseAssignmentGate(filter)),
    status: row.status,
    lastSyncAt: row.lastSyncAt ? toIso(row.lastSyncAt) : null,
    syncPath: `/scim/outbound/${row.id}/sync`,
    createdAt: toIso(row.createdAt) ?? '',
  }
}

// GET /v1/organizations/:id/scim-targets
app.get('/:id/scim-targets', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'connections:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const rows = await readAllById((cursor) =>
    db.scimTargets.findMany(
      and(
        eq(schema.scimTargets.orgId, id),
        ne(schema.scimTargets.status, 'deleted'),
        ...(cursor ? [gt(schema.scimTargets.id, cursor)] : []),
      ),
      { orderBy: asc(schema.scimTargets.id), limit: ORG_LIST_BATCH_SIZE },
    ),
  )
  return c.json(rows.map((row) => toConsoleScimTarget(row, c.env)))
})

// POST /v1/organizations/:id/scim-targets
app.post('/:id/scim-targets', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'connections:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(scimTargetBodySchema, json.value)
  const provider = body.provider?.trim() ?? ''
  const rawBaseUrl = body.base_url?.trim() ?? ''
  if (!provider || !rawBaseUrl) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'base_url' } })
  }
  // 拒绝客户端自选 token_secret_ref;服务端派生 SCIM_TARGET_TOKEN_<target id>。
  if (body.token_secret_ref !== undefined) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'token_secret_ref' },
    })
  }
  const baseUrl = normalizeScimTargetBaseUrl(rawBaseUrl)
  const targetId = createPersistedId('scimTarget')
  const tokenSecretRef = scimTargetTokenSecretName(targetId)
  const gate = assignmentGateFromBody(body) ?? parseAssignmentGate({})
  const row = await db.scimTargets.insert({
    id: targetId,
    tenantId: tenant.tenantId,
    orgId: id,
    provider,
    baseUrl,
    tokenSecretRef,
    userFilter: withAssignmentGate({}, gate),
    status: 'active',
  })
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organization.scim_target.created',
    payload: { orgId: id, targetId: row.id, provider },
  })
  return c.json(toConsoleScimTarget(row, c.env), 201)
})

// PATCH /v1/organizations/:id/scim-targets/:targetId
app.patch('/:id/scim-targets/:targetId', async (c) => {
  const id = c.req.param('id')
  const targetId = c.req.param('targetId')
  await requireApiKeyOrOrgManager(c, id, 'connections:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(scimTargetBodySchema, json.value)
  const where = and(
    eq(schema.scimTargets.id, targetId),
    eq(schema.scimTargets.tenantId, tenant.tenantId),
    eq(schema.scimTargets.orgId, id),
    ne(schema.scimTargets.status, 'deleted'),
  )
  const existing = await db.scimTargets.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  const patch: Partial<typeof schema.scimTargets.$inferInsert> = {}
  if (body.provider !== undefined && body.provider.trim()) patch.provider = body.provider.trim()
  if (body.base_url !== undefined && body.base_url.trim()) {
    patch.baseUrl = normalizeScimTargetBaseUrl(body.base_url.trim())
  }
  if (body.token_secret_ref !== undefined) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'token_secret_ref' },
    })
  }
  // 安全更新时把任意旧引用归一到派生 secret 名。
  patch.tokenSecretRef = scimTargetTokenSecretName(existing.id)
  const gate = assignmentGateFromBody(body)
  if (gate) {
    patch.userFilter = withAssignmentGate(existing.userFilter as Record<string, unknown>, gate)
  }
  const updated = await db.scimTargets.update(patch, where)
  return c.json(toConsoleScimTarget(updated[0]!, c.env))
})

// DELETE /v1/organizations/:id/scim-targets/:targetId
app.delete('/:id/scim-targets/:targetId', async (c) => {
  const id = c.req.param('id')
  const targetId = c.req.param('targetId')
  await requireApiKeyOrOrgManager(c, id, 'connections:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(
    eq(schema.scimTargets.id, targetId),
    eq(schema.scimTargets.tenantId, tenant.tenantId),
    eq(schema.scimTargets.orgId, id),
    ne(schema.scimTargets.status, 'deleted'),
  )
  const existing = await db.scimTargets.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  await db.scimTargets.update({ status: 'deleted' }, where)
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organization.scim_target.deleted',
    payload: { orgId: id, targetId },
  })
  return new Response(null, { status: 204 })
})

// POST /v1/organizations/:id/scim-targets/:targetId/sync
app.post('/:id/scim-targets/:targetId/sync', async (c) => {
  const id = c.req.param('id')
  const targetId = c.req.param('targetId')
  const auth = await requireApiKeyOrOrgManager(c, id, 'connections:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const target = await db.scimTargets.findOne(
    and(
      eq(schema.scimTargets.id, targetId),
      eq(schema.scimTargets.tenantId, tenant.tenantId),
      eq(schema.scimTargets.orgId, id),
      eq(schema.scimTargets.status, 'active'),
    ),
  )
  if (!target) throw new AppError('not_found', { httpStatus: 404 })
  const actorId = auth.kind === 'org_console' ? auth.session.userId : auth.apiKeyId
  return c.json(await enqueueScimTargetSync(c, target, actorId), 202)
})

// PATCH /v1/organizations/:id/branding
app.patch('/:id/branding', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'branding:write')
  const tenant = c.get('tenant')
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(brandingPatchBodySchema, json.value)
  const current = readBranding(await c.env.CACHE.get(brandingKey(tenant.tenantId, id)))
  const next: ConsoleBranding = {
    primaryColor: body.primaryColor ?? current.primaryColor,
    backgroundColor: body.backgroundColor ?? current.backgroundColor,
    accentColor: body.accentColor ?? current.accentColor,
    borderRadius: body.borderRadius ?? current.borderRadius,
    fontFamily: body.fontFamily ?? current.fontFamily,
    logoUrl: body.logoUrl ?? current.logoUrl,
    logoDarkUrl: body.logoDarkUrl ?? current.logoDarkUrl,
  }
  await c.env.CACHE.put(brandingKey(tenant.tenantId, id), JSON.stringify(next))
  return c.json(next)
})

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
          enforcement: 'block_creation',
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

// ---- logo 上传 ----

// PUT /v1/organizations/:id/logo  -- multipart/form-data, field: file
app.put('/:id/logo', async (c) => {
  await requireApiKey(c, 'organizations:write')
  const id = c.req.param('id')
  await requireOrg(c, id)

  const tenant = c.get('tenant')
  const formData = await c.req.formData()
  const file = formData.get('file')
  if (!(file instanceof File)) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      longMessage: 'file field required.',
    })
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      longMessage: 'Logo must be <= 5 MB.',
    })
  }

  const key = `logos/${tenant.tenantId}/${id}/${crypto.randomUUID()}`
  const buf = await file.arrayBuffer()
  await c.env.STORAGE.put(key, buf, { httpMetadata: { contentType: file.type } })
  // logo 经 worker 自 serve(GET /storage/logos/*);issuer 随单租户/多租户/自定义域名解析。
  const logoUrl = `${tenant.issuer}/storage/${key}`

  const db = createTenantDb(c.env.DB, tenant)
  const updated = await db.organizations.update({ logoUrl }, eq(schema.organizations.id, id))
  return c.json({ logo_url: logoUrl, organization: toResponse(updated[0]!) })
})

// ---- 域名管理 ----

// GET /v1/organizations/:id/domains
app.get('/:id/domains', async (c) => {
  const id = c.req.param('id')
  const auth = await requireApiKeyOrOrgManager(c, id, 'organization_domains:read')

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const orgDb = db.forOrg(id)
  const domains = await readAllById((cursor) =>
    orgDb.organizationDomains.findMany(
      cursor
        ? and(
            eq(schema.organizationDomains.status, 'active'),
            gt(schema.organizationDomains.id, cursor),
          )
        : eq(schema.organizationDomains.status, 'active'),
      { orderBy: asc(schema.organizationDomains.id), limit: ORG_LIST_BATCH_SIZE },
    ),
  )
  if (auth.kind === 'org_console') return c.json(domains.map(toConsoleDomain))
  return c.json({ data: domains.map(toDomainResponse) })
})

// POST /v1/organizations/:id/domains
app.post('/:id/domains', async (c) => {
  const id = c.req.param('id')
  const auth = await requireApiKeyOrOrgManager(c, id, 'organization_domains:write')

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createDomainBodySchema, json.value)

  // 全局唯一(UNIQUE(domain),见 schema/rbac.ts organizationDomains)
  const existing = await db.organizationDomains.findOne(
    eq(schema.organizationDomains.domain, body.domain),
  )
  if (existing?.status === 'deleted' && existing.orgId === id) {
    const updated = await db.organizationDomains.update(
      {
        enrollmentMode: body.enrollment_mode ?? 'invite_required',
        verificationStatus: 'pending',
        verificationToken: crypto.randomUUID(),
        status: 'active',
        deletedAt: null,
      },
      eq(schema.organizationDomains.id, existing.id),
    )
    const row = updated[0]!
    if (auth.kind === 'org_console') return c.json(toConsoleDomain(row), 201)
    return c.json(toDomainResponse(row), 201)
  }
  if (existing)
    throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'domain' } })

  const token = crypto.randomUUID()
  let domain: typeof schema.organizationDomains.$inferSelect
  try {
    domain = await db.organizationDomains.insert({
      id: createPersistedId('organizationDomain'),
      tenantId: tenant.tenantId,
      orgId: id,
      domain: body.domain,
      verificationToken: token,
      enrollmentMode: body.enrollment_mode ?? 'invite_required',
      verificationStatus: 'pending',
    })
  } catch (error) {
    // 全局 UNIQUE(domain) 但预检只查本租户:他租户已注册时撞约束,映射 409 模糊文案
    // (不指明持有者,枚举防护),不外溢 500。
    if (isUniqueConstraintError(error)) {
      throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'domain' } })
    }
    throw error
  }
  if (auth.kind === 'org_console') return c.json(toConsoleDomain(domain), 201)
  return c.json(toDomainResponse(domain), 201)
})

// DELETE /v1/organizations/:id/domains/:domainId
app.delete('/:id/domains/:domainId', async (c) => {
  await requireApiKey(c, 'organization_domains:write')
  const id = c.req.param('id')
  await requireOrg(c, id)

  const domainId = c.req.param('domainId')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)

  const row = await db.organizationDomains.findOne(
    and(
      eq(schema.organizationDomains.id, domainId),
      eq(schema.organizationDomains.status, 'active'),
    ),
  )
  if (!row || row.orgId !== id) throw new AppError('not_found', { httpStatus: 404 })

  await db.organizationDomains.update(
    { status: 'deleted', deletedAt: new Date() },
    and(
      eq(schema.organizationDomains.id, domainId),
      eq(schema.organizationDomains.status, 'active'),
    ),
  )
  return new Response(null, { status: 204 })
})

// org audit 复合游标解码(occurredAt|id);格式损坏走 422(枚举防护,不泄露细节)。
function decodeOrgAuditCursor(cursor: string): { occurredAt: string; id: string } {
  const raw = decodeCursor(cursor)
  const sep = raw.indexOf('|')
  if (sep === -1) throw new AppError('validation_failed', { httpStatus: 422 })
  return { occurredAt: raw.slice(0, sep), id: raw.slice(sep + 1) }
}

// GET /v1/organizations/:id/audit-events  org 级审计(只读)。
// 双认证:org owner/admin/org_manager(cookie)或 sk_ key(audit_events:read)。
// 过滤:sk(Management API 信任域)与 instance_manager 可见本 org 事件 + 租户级事件(orgId=null,登录类);
// org admin 仅见本 org 事件,不放开 orgId=null(登录类事件含全租户用户登录 IP/时间,放开即跨 org 泄露)。
// 排序 occurred_at DESC, id DESC;复合游标 "occurredAt|id"。查询层按索引分页,不把全量审计记录加载到内存。
app.get('/:id/audit-events', async (c) => {
  const id = c.req.param('id')
  const auth = await requireApiKeyOrOrgManager(c, id, 'audit_events:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const query = validateQuery(paginationQuerySchema, c.req.query())
  const limit = query.limit ?? MAX_PAGE_SIZE
  const cursor = query.cursor ?? null

  const after = cursor ? decodeOrgAuditCursor(cursor) : null
  const includeTenantWide =
    auth.kind === 'api_key' || (await isInstanceManagerUser(c, auth.session.userId))
  const orgFilter = includeTenantWide
    ? or(eq(schema.auditEvents.orgId, id), isNull(schema.auditEvents.orgId))
    : eq(schema.auditEvents.orgId, id)
  const filters = [orgFilter]
  if (after) {
    filters.push(
      or(
        lt(schema.auditEvents.occurredAt, after.occurredAt),
        and(
          eq(schema.auditEvents.occurredAt, after.occurredAt),
          lt(schema.auditEvents.id, after.id),
        ),
      ),
    )
  }
  const [rows, total] = await Promise.all([
    db.auditEvents.findMany(and(...filters), {
      orderBy: [desc(schema.auditEvents.occurredAt), desc(schema.auditEvents.id)],
      limit: limit + 1,
    }),
    db.auditEvents.count(filters[0]),
  ])
  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const last = pageRows[pageRows.length - 1]
  const nextCursor =
    hasMore && last !== undefined ? encodeCursor(`${last.occurredAt}|${last.id}`) : null

  const actorIds = [
    ...new Set(
      pageRows
        .map((row) => row.actorId)
        .filter((actorId): actorId is string => actorId !== null && actorId !== 'system'),
    ),
  ]
  const actorRows =
    actorIds.length === 0
      ? []
      : await db.users.findMany(inArray(schema.users.id, actorIds), { limit: actorIds.length })
  const actors = new Map(actorRows.map((row) => [row.id, row.erasedAt] as const))

  const data = pageRows.map((row) => ({
    id: row.id,
    seq: row.seq,
    organizationId: row.tenantId,
    organizationName: null,
    orgId: row.orgId ?? null,
    eventType: row.eventType,
    actorId: row.actorId ?? null,
    actorDisplay: auditActorDisplay(row.actorId ?? null, {
      found: row.actorId === 'system' || actors.has(row.actorId ?? ''),
      erasedAt: actors.get(row.actorId ?? '') ?? null,
    }),
    actorIp: row.actorIp ?? null,
    targetType: row.targetType ?? null,
    targetId: row.targetId ?? null,
    occurredAt: row.occurredAt,
  }))

  return c.json({ data, nextCursor, total })
})

export function registerOrganizationsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/organizations', app)
}
