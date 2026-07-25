// TenantContext 解析工厂(见 tenant-context rule、00 章 5):
// 单租户=配置驱动单例(instances.mode='single_tenant');多租户=按 Host 头从 D1 动态解析。
// 一份代码两模式,差别只在解析路径。issuer/rpId/签名密钥/策略一律从此产出,内核禁止全局单例。
//
// 边界:本层只组装 TenantContext 的结构(含签名私钥密文,明文不解密);私钥解密走 crypto 包(见 signing-keys rule)。
// 可预期失败(租户不存在/被暂停)走 Result 判别联合;意外不可恢复才 throw。

import type {
  ActiveSigningKeySet,
  XidError,
  Result,
  SigningAlg,
  SigningKeyMaterial,
  SigningKeyStatus,
  TenantContext,
  TenantPolicy,
} from '@xid-kit/types'
import {
  normalizeDeliveryChannelsPolicy,
  normalizeHostedAuthPolicy,
  normalizeSessionPolicy,
  normalizeSocialProviders,
  normalizeTokenPolicy,
} from '@xid-kit/types'
import { and, eq, gt, inArray, isNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'

type Db = ReturnType<typeof drizzle<typeof schema>>

type ResolveEnv = {
  DB: D1Database
}

export type LoginIdentifierKind = 'email' | 'username' | 'phone' | 'external_id'

export type LoginIdentifier = {
  kind: LoginIdentifierKind
  value: string
}

export type InstanceLoginMatch = {
  tenantId: string
  slug: string
  name: string
  issuer: string
}

export type InstanceLoginResolution =
  | {
      status: 'resolved'
      tenant: TenantContext
      matchedBy: LoginIdentifierKind
    }
  | {
      status: 'new_user'
      tenant: TenantContext
      matchedBy: LoginIdentifierKind
    }
  | {
      status: 'ambiguous'
      matches: readonly InstanceLoginMatch[]
      matchedBy: LoginIdentifierKind
    }
  | {
      status: 'not_instance_entry'
      tenant: TenantContext
    }

export type IssuerTenantResolution =
  | {
      status: 'resolved'
      tenant: TenantContext
      session?: typeof schema.sessions.$inferSelect
    }
  | {
      status: 'not_instance_entry'
      tenant: TenantContext
    }

type InstanceRow = typeof schema.instances.$inferSelect
type OrgRow = typeof schema.organizations.$inferSelect
type InstanceSigningKeyRow = typeof schema.instanceSigningKeys.$inferSelect

const SIGNING_ALGS = new Set<SigningAlg>(['ES256', 'RS256', 'PS256'])
const SIGNING_STATUSES = new Set<SigningKeyStatus>(['active', 'next', 'retiring'])
const DEFAULT_ORG_SLUG = 'default'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function err(code: XidError['code'], message: string, httpStatus: number): Result<never> {
  return { ok: false, error: { code, message, httpStatus } }
}

// 从 Host 头取 hostname(去端口),用于多租户子域/自定义域名匹配。
function hostnameOf(request: Request): string | undefined {
  const host = request.headers.get('host')
  if (!host) return undefined
  const idx = host.indexOf(':')
  return (idx === -1 ? host : host.slice(0, idx)).toLowerCase()
}

export function instanceIssuerFor(instance: Pick<InstanceRow, 'primaryDomain'>): string {
  return `https://${instance.primaryDomain}`
}

function isLoopbackDomain(domain: string): boolean {
  return domain === 'localhost' || domain === '127.0.0.1' || domain === '::1' || domain === '[::1]'
}

function isInstanceEntryHost(instance: InstanceRow, hostname: string): boolean {
  if (hostname === instance.primaryDomain) return true
  return isLoopbackDomain(instance.primaryDomain) && isLoopbackDomain(hostname)
}

function instanceOriginForRequest(request: Request, instance: InstanceRow): string {
  if (!isLoopbackDomain(instance.primaryDomain)) return instanceIssuerFor(instance)
  return new URL(request.url).origin
}

// rpId = 具体租户子域(WebAuthn 隔离,不能设父域,见 webauthn rule)。
function rpIdFor(instance: InstanceRow, org: OrgRow): string {
  return `${org.slug}.${instance.primaryDomain}`
}

function rootResolvedContextOptions(
  instance: InstanceRow,
  origin = instanceIssuerFor(instance),
): {
  issuer: string
  hostedAuthOrigin: string
  rpId: string
  resolution: TenantContext['resolution']
} {
  return {
    issuer: origin,
    hostedAuthOrigin: origin,
    rpId: instance.primaryDomain,
    resolution: { kind: 'tenant', primaryDomain: instance.primaryDomain },
  }
}

// 由 instance 默认 + org 策略覆盖组装 TenantPolicy(未设字段回退,见 02 章 5、08 章 10.6)。
// session/token 走三层链:org_policies 列 -> instances JSON -> 内置默认;normalize 统一做类型校验与边界 clamp。
export function buildPolicy(
  instance: InstanceRow,
  org: OrgRow,
  policy?: typeof schema.orgPolicies.$inferSelect,
): TenantPolicy {
  const result: TenantPolicy = {}
  const mfa = policy?.mfaPolicy ?? instance.mfaPolicy
  if (mfa === 'required' || mfa === 'optional' || mfa === 'disabled') result.mfaEnforcement = mfa
  if (policy) {
    result.login = { forceSso: policy.forceSso, allowPasswordLogin: policy.allowPasswordLogin }
  }
  // org 只持有 idle/absolute 两个独立列,rememberMeDefault 仅 instance JSON 有源;
  // instance JSON 先 normalize(snake/camel 键兼容),org 列值再逐字段覆盖,最后统一 clamp。
  const instanceSession = normalizeSessionPolicy(instance.sessionPolicy)
  result.session = normalizeSessionPolicy({
    idleTimeoutMin: policy?.sessionIdleTimeoutMin ?? instanceSession.idleTimeoutMin,
    absoluteTimeoutDays: policy?.sessionAbsoluteTimeoutDays ?? instanceSession.absoluteTimeoutDays,
    rememberMeDefault: instanceSession.rememberMeDefault,
  })
  result.token = normalizeTokenPolicy(policy?.tokenPolicy ?? instance.tokenPolicy)
  const metadata = isRecord(org.privateMetadata) ? org.privateMetadata : {}
  result.hostedAuth = normalizeHostedAuthPolicy(metadata['hostedAuth'])
  const socialProviders = normalizeSocialProviders(metadata['socialProviders'])
  if (socialProviders) result.socialProviders = socialProviders
  const deliveryChannels = normalizeDeliveryChannelsPolicy(metadata['deliveryChannels'])
  if (deliveryChannels) result.deliveryChannels = deliveryChannels
  return result
}

// 把 D1 签名密钥行组装为 ActiveSigningKeySet(私钥仍是密文,不解密)。
function buildSigningKeySet(rows: InstanceSigningKeyRow[]): ActiveSigningKeySet {
  const keys: SigningKeyMaterial[] = rows
    .filter(
      (r) =>
        SIGNING_ALGS.has(r.alg as SigningAlg) && SIGNING_STATUSES.has(r.status as SigningKeyStatus),
    )
    .map((r) => ({
      kid: r.kid,
      alg: r.alg as SigningAlg,
      status: r.status as SigningKeyStatus,
      publicKeyJwk: r.publicKeyJwk as unknown as JsonWebKey,
      encryptedPrivateKey: {
        iv: new Uint8Array(r.privateKeyIv),
        ciphertext: new Uint8Array(r.privateKeyCiphertext),
        tag: new Uint8Array(r.privateKeyTag),
        kekVersion: r.kekVersion,
        kid: r.kid,
        alg: r.alg as SigningAlg,
      },
    }))
  const active = keys.find((k) => k.status === 'active')
  return {
    activeKid: active?.kid ?? keys[0]?.kid ?? '',
    defaultAlg: active?.alg ?? 'ES256',
    keys,
  }
}

async function loadOrgPolicy(
  db: Db,
  tenantId: string,
  orgId: string,
): Promise<typeof schema.orgPolicies.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(schema.orgPolicies)
    .where(and(eq(schema.orgPolicies.tenantId, tenantId), eq(schema.orgPolicies.orgId, orgId)))
    .limit(1)
  return rows[0]
}

async function loadInstanceSigningKeys(
  db: Db,
  instanceId: string,
): Promise<InstanceSigningKeyRow[]> {
  return db
    .select()
    .from(schema.instanceSigningKeys)
    .where(
      and(
        eq(schema.instanceSigningKeys.instanceId, instanceId),
        inArray(schema.instanceSigningKeys.status, ['active', 'next', 'retiring']),
      ),
    )
}

async function buildContext(
  db: Db,
  instance: InstanceRow,
  org: OrgRow,
  options: {
    hostedAuthOrigin?: string
    issuer?: string
    rpId?: string
    resolution?: TenantContext['resolution']
  } = {},
): Promise<TenantContext> {
  const [policy, signingRows] = await Promise.all([
    loadOrgPolicy(db, org.tenantId, org.id),
    loadInstanceSigningKeys(db, instance.id),
  ])
  return {
    tenantId: org.tenantId,
    instanceId: instance.id,
    issuer: options.issuer ?? instanceIssuerFor(instance),
    rpId: options.rpId ?? rpIdFor(instance, org),
    ...(options.resolution === undefined ? {} : { resolution: options.resolution }),
    ...(options.hostedAuthOrigin === undefined
      ? {}
      : { hostedAuthOrigin: options.hostedAuthOrigin }),
    signingKeys: buildSigningKeySet(signingRows),
    policy: buildPolicy(instance, org, policy),
  }
}

// 单租户:解析配置单例(instance.mode='single_tenant',取实例下唯一/根 org)。
async function resolveSingleTenant(
  db: Db,
  instance: InstanceRow,
  origin = instanceIssuerFor(instance),
): Promise<Result<TenantContext>> {
  const orgs = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.instanceId, instance.id))
    .limit(1)
  const org = orgs[0]
  if (!org) return err('tenant_not_found', 'No organization provisioned for instance', 404)
  if (org.status !== 'active') return err('tenant_suspended', 'Tenant is not active', 403)
  return {
    ok: true,
    value: await buildContext(db, instance, org, {
      issuer: origin,
      rpId: instance.primaryDomain,
    }),
  }
}

// 多租户:按 Host 头的子域(slug)在该 instance 下解析 org。
async function resolveMultiTenant(
  db: Db,
  instance: InstanceRow,
  hostname: string,
  origin = instanceIssuerFor(instance),
): Promise<Result<TenantContext>> {
  const suffix = `.${instance.primaryDomain}`
  const isRootDomain = isInstanceEntryHost(instance, hostname)
  const slug = isRootDomain
    ? DEFAULT_ORG_SLUG
    : hostname.endsWith(suffix)
      ? hostname.slice(0, -suffix.length)
      : undefined
  if (!slug) return err('tenant_not_found', 'Host does not map to a tenant', 404)
  const orgs = await db
    .select()
    .from(schema.organizations)
    .where(
      and(eq(schema.organizations.instanceId, instance.id), eq(schema.organizations.slug, slug)),
    )
    .limit(1)
  const org = orgs[0]
  if (!org) return err('tenant_not_found', 'Unknown tenant', 404)
  if (org.status !== 'active') return err('tenant_suspended', 'Tenant is not active', 403)
  return {
    ok: true,
    value: await buildContext(db, instance, org, {
      ...(isRootDomain
        ? {
            issuer: origin,
            hostedAuthOrigin: origin,
            rpId: instance.primaryDomain,
            resolution: {
              kind: 'instance_entry',
              primaryDomain: instance.primaryDomain,
              unresolvedRoot: true,
            },
          }
        : {}),
    }),
  }
}

async function resolveOrgById(
  db: Db,
  instance: InstanceRow,
  orgId: string,
  options: {
    hostedAuthOrigin?: string
    rpId?: string
    resolution?: TenantContext['resolution']
  } = {},
): Promise<Result<TenantContext>> {
  const orgs = await db
    .select()
    .from(schema.organizations)
    .where(
      and(eq(schema.organizations.instanceId, instance.id), eq(schema.organizations.id, orgId)),
    )
    .limit(1)
  const org = orgs[0]
  if (!org) return err('tenant_not_found', 'Unknown tenant', 404)
  if (org.status !== 'active') return err('tenant_suspended', 'Tenant is not active', 403)
  return {
    ok: true,
    value: await buildContext(db, instance, org, {
      resolution: { kind: 'tenant', primaryDomain: instance.primaryDomain },
      ...options,
    }),
  }
}

async function publicOrgMatches(
  db: Db,
  instance: InstanceRow,
  tenantIds: readonly string[],
  issuer = instanceIssuerFor(instance),
): Promise<InstanceLoginMatch[]> {
  const uniqueTenantIds = [...new Set(tenantIds)]
  if (uniqueTenantIds.length === 0) return []
  const rows = await db
    .select()
    .from(schema.organizations)
    .where(
      and(
        eq(schema.organizations.instanceId, instance.id),
        inArray(schema.organizations.id, uniqueTenantIds),
        eq(schema.organizations.status, 'active'),
      ),
    )
    .limit(uniqueTenantIds.length)
  const organizationsById = new Map(rows.map((org) => [org.id, org]))
  return uniqueTenantIds.flatMap((tenantId) => {
    const org = organizationsById.get(tenantId)
    return org
      ? [
          {
            tenantId: org.id,
            slug: org.slug,
            name: org.name,
            issuer,
          },
        ]
      : []
  })
}

async function lookupEmailTenantIds(db: Db, email: string): Promise<string[]> {
  const rows = await db
    .select({ tenantId: schema.userEmails.tenantId })
    .from(schema.userEmails)
    .innerJoin(schema.users, eq(schema.users.id, schema.userEmails.userId))
    .where(
      and(
        eq(schema.userEmails.email, email),
        eq(schema.users.status, 'active'),
        isNull(schema.users.deletedAt),
      ),
    )
    .limit(5)
  return [...new Set(rows.map((row) => row.tenantId))]
}

async function lookupUserFieldTenantIds(
  db: Db,
  field: 'username' | 'externalId',
  value: string,
): Promise<string[]> {
  const column = field === 'username' ? schema.users.username : schema.users.externalId
  const rows = await db
    .select({ tenantId: schema.users.tenantId })
    .from(schema.users)
    .where(
      and(eq(column, value), eq(schema.users.status, 'active'), isNull(schema.users.deletedAt)),
    )
    .limit(5)
  return [...new Set(rows.map((row) => row.tenantId))]
}

async function lookupPhoneTenantIds(db: Db, phone: string): Promise<string[]> {
  const rows = await db
    .select({ tenantId: schema.userPhones.tenantId })
    .from(schema.userPhones)
    .innerJoin(schema.users, eq(schema.users.id, schema.userPhones.userId))
    .where(
      and(
        eq(schema.userPhones.phone, phone),
        eq(schema.users.status, 'active'),
        isNull(schema.users.deletedAt),
      ),
    )
    .limit(5)
  return [...new Set(rows.map((row) => row.tenantId))]
}

function domainFromEmail(email: string): string | undefined {
  const idx = email.lastIndexOf('@')
  if (idx <= 0 || idx === email.length - 1) return undefined
  return email.slice(idx + 1).toLowerCase()
}

async function lookupEmailDomainTenantIds(db: Db, email: string): Promise<string[]> {
  const domain = domainFromEmail(email)
  if (!domain) return []
  const exactRows = await db
    .select({ tenantId: schema.organizationDomains.tenantId })
    .from(schema.organizationDomains)
    .where(
      and(
        eq(schema.organizationDomains.domain, domain),
        eq(schema.organizationDomains.verificationStatus, 'verified'),
        eq(schema.organizationDomains.status, 'active'),
        isNull(schema.organizationDomains.deletedAt),
      ),
    )
    .limit(5)
  const exactTenantIds = [...new Set(exactRows.map((row) => row.tenantId))]
  if (exactTenantIds.length > 0) return exactTenantIds

  const parts = domain.split('.')
  if (parts.length <= 2) return []
  const parentDomain = parts.slice(1).join('.')
  const wildcardRows = await db
    .select({ tenantId: schema.organizationDomains.tenantId })
    .from(schema.organizationDomains)
    .where(
      and(
        eq(schema.organizationDomains.domain, parentDomain),
        eq(schema.organizationDomains.verificationStatus, 'verified'),
        eq(schema.organizationDomains.status, 'active'),
        eq(schema.organizationDomains.isWildcard, true),
        isNull(schema.organizationDomains.deletedAt),
      ),
    )
    .limit(5)
  return [...new Set(wildcardRows.map((row) => row.tenantId))]
}

async function defaultTenantContext(
  db: Db,
  instance: InstanceRow,
  hostedAuthOrigin?: string,
): Promise<Result<TenantContext>> {
  const orgs = await db
    .select()
    .from(schema.organizations)
    .where(
      and(
        eq(schema.organizations.instanceId, instance.id),
        eq(schema.organizations.slug, DEFAULT_ORG_SLUG),
      ),
    )
    .limit(1)
  const org = orgs[0]
  if (!org) return err('tenant_not_found', 'Default tenant is not provisioned', 404)
  if (org.status !== 'active') return err('tenant_suspended', 'Tenant is not active', 403)
  return {
    ok: true,
    value: await buildContext(db, instance, org, {
      ...(hostedAuthOrigin === undefined
        ? {}
        : rootResolvedContextOptions(instance, hostedAuthOrigin)),
    }),
  }
}

async function instanceForRequest(
  db: Db,
  request: Request,
): Promise<Result<{ hostname: string; instance: InstanceRow }>> {
  const hostname = hostnameOf(request)
  if (!hostname) return err('tenant_not_found', 'Missing Host header', 400)

  const instanceRows = await db.select().from(schema.instances).limit(1)
  const instance = instanceRows[0]
  if (!instance) return err('tenant_not_found', 'No instance provisioned', 404)
  if (instance.status !== 'active') return err('tenant_suspended', 'Instance is suspended', 403)
  return { ok: true, value: { hostname, instance } }
}

function normalizeIdentifier(input: LoginIdentifier): LoginIdentifier {
  if (input.kind === 'email') return { ...input, value: input.value.trim().toLowerCase() }
  return { ...input, value: input.value.trim() }
}

async function lookupTenantIds(db: Db, input: LoginIdentifier): Promise<string[]> {
  const normalized = normalizeIdentifier(input)
  if (normalized.value === '') return []
  if (normalized.kind === 'email') return lookupEmailTenantIds(db, normalized.value)
  if (normalized.kind === 'phone') return lookupPhoneTenantIds(db, normalized.value)
  return lookupUserFieldTenantIds(
    db,
    normalized.kind === 'external_id' ? 'externalId' : 'username',
    normalized.value,
  )
}

export async function resolveInstanceLogin(
  request: Request,
  env: ResolveEnv,
  identifier: LoginIdentifier,
): Promise<Result<InstanceLoginResolution>> {
  const db = drizzle(env.DB, { schema })
  const instanceResult = await instanceForRequest(db, request)
  if (!instanceResult.ok) return instanceResult

  const { hostname, instance } = instanceResult.value
  const hostedAuthOrigin = instanceOriginForRequest(request, instance)
  if (instance.mode === 'single_tenant' || !isInstanceEntryHost(instance, hostname)) {
    const tenant = await resolveTenantContext(request, env)
    if (!tenant.ok) return tenant
    return { ok: true, value: { status: 'not_instance_entry', tenant: tenant.value } }
  }

  const normalized = normalizeIdentifier(identifier)
  const matches = await lookupTenantIds(db, normalized)
  if (matches.length > 1) {
    return {
      ok: true,
      value: {
        status: 'ambiguous',
        matches: await publicOrgMatches(db, instance, matches, hostedAuthOrigin),
        matchedBy: normalized.kind,
      },
    }
  }
  if (matches.length === 1) {
    const context = await resolveOrgById(
      db,
      instance,
      matches[0] ?? '',
      rootResolvedContextOptions(instance, hostedAuthOrigin),
    )
    if (!context.ok) return context
    return {
      ok: true,
      value: { status: 'resolved', tenant: context.value, matchedBy: normalized.kind },
    }
  }

  const domainMatches =
    normalized.kind === 'email' ? await lookupEmailDomainTenantIds(db, normalized.value) : []
  if (domainMatches.length > 1) {
    return {
      ok: true,
      value: {
        status: 'ambiguous',
        matches: await publicOrgMatches(db, instance, domainMatches, hostedAuthOrigin),
        matchedBy: normalized.kind,
      },
    }
  }
  if (domainMatches.length === 1) {
    const context = await resolveOrgById(
      db,
      instance,
      domainMatches[0] ?? '',
      rootResolvedContextOptions(instance, hostedAuthOrigin),
    )
    if (!context.ok) return context
    return {
      ok: true,
      value: { status: 'new_user', tenant: context.value, matchedBy: normalized.kind },
    }
  }

  const context = await defaultTenantContext(db, instance, hostedAuthOrigin)
  if (!context.ok) return context
  return {
    ok: true,
    value: { status: 'new_user', tenant: context.value, matchedBy: normalized.kind },
  }
}

export async function resolveInstanceLoginCandidates(
  request: Request,
  env: ResolveEnv,
  identifiers: readonly LoginIdentifier[],
): Promise<Result<InstanceLoginResolution>> {
  const db = drizzle(env.DB, { schema })
  const instanceResult = await instanceForRequest(db, request)
  if (!instanceResult.ok) return instanceResult

  const { hostname, instance } = instanceResult.value
  const hostedAuthOrigin = instanceOriginForRequest(request, instance)
  if (instance.mode === 'single_tenant' || !isInstanceEntryHost(instance, hostname)) {
    const tenant = await resolveTenantContext(request, env)
    if (!tenant.ok) return tenant
    return { ok: true, value: { status: 'not_instance_entry', tenant: tenant.value } }
  }

  const normalized = identifiers.map(normalizeIdentifier).filter((item) => item.value !== '')
  if (normalized.length === 0) {
    const context = await defaultTenantContext(db, instance, hostedAuthOrigin)
    if (!context.ok) return context
    return {
      ok: true,
      value: { status: 'new_user', tenant: context.value, matchedBy: 'email' },
    }
  }

  const lookupResults = await Promise.all(
    normalized.map(async (identifier) => ({
      identifier,
      tenantIds: await lookupTenantIds(db, identifier),
    })),
  )
  const matches: Array<{ tenantId: string; kind: LoginIdentifierKind }> = lookupResults.flatMap(
    ({ identifier, tenantIds }) =>
      tenantIds.map((tenantId) => ({ tenantId, kind: identifier.kind })),
  )
  if (matches.length === 0) {
    const domainResults = await Promise.all(
      normalized
        .filter((identifier) => identifier.kind === 'email')
        .map(async (identifier) => ({
          identifier,
          tenantIds: await lookupEmailDomainTenantIds(db, identifier.value),
        })),
    )
    for (const { identifier, tenantIds } of domainResults) {
      for (const tenantId of tenantIds) matches.push({ tenantId, kind: identifier.kind })
    }
  }
  const tenantIds = [...new Set(matches.map((match) => match.tenantId))]
  if (tenantIds.length > 1) {
    return {
      ok: true,
      value: {
        status: 'ambiguous',
        matches: await publicOrgMatches(db, instance, tenantIds, hostedAuthOrigin),
        matchedBy: matches[0]?.kind ?? 'email',
      },
    }
  }
  if (tenantIds.length === 1) {
    const context = await resolveOrgById(
      db,
      instance,
      tenantIds[0] ?? '',
      rootResolvedContextOptions(instance, hostedAuthOrigin),
    )
    if (!context.ok) return context
    return {
      ok: true,
      value: {
        status: 'resolved',
        tenant: context.value,
        matchedBy: matches.find((match) => match.tenantId === tenantIds[0])?.kind ?? 'email',
      },
    }
  }

  const context = await defaultTenantContext(db, instance, hostedAuthOrigin)
  if (!context.ok) return context
  return {
    ok: true,
    value: { status: 'new_user', tenant: context.value, matchedBy: normalized[0]?.kind ?? 'email' },
  }
}

export async function resolveTenantContextByIssuer(
  request: Request,
  env: ResolveEnv,
  issuer: string,
  options: { tenantId?: string } = {},
): Promise<Result<IssuerTenantResolution>> {
  const db = drizzle(env.DB, { schema })
  const instanceResult = await instanceForRequest(db, request)
  if (!instanceResult.ok) return instanceResult

  const { hostname, instance } = instanceResult.value
  const origin = instanceOriginForRequest(request, instance)
  if (instance.mode === 'single_tenant' || !isInstanceEntryHost(instance, hostname)) {
    const tenant = await resolveTenantContext(request, env)
    if (!tenant.ok) return tenant
    return { ok: true, value: { status: 'not_instance_entry', tenant: tenant.value } }
  }

  if (issuer !== origin) {
    return err('tenant_not_found', 'Issuer does not match instance issuer', 404)
  }

  if (options.tenantId) {
    const context = await resolveOrgById(
      db,
      instance,
      options.tenantId,
      rootResolvedContextOptions(instance, origin),
    )
    if (!context.ok) return context
    return { ok: true, value: { status: 'resolved', tenant: context.value } }
  }

  return err('tenant_not_found', 'Tenant hint is required for instance issuer token', 404)
}

export async function resolveTenantContextById(
  request: Request,
  env: ResolveEnv,
  tenantId: string,
): Promise<Result<IssuerTenantResolution>> {
  const db = drizzle(env.DB, { schema })
  const instanceResult = await instanceForRequest(db, request)
  if (!instanceResult.ok) return instanceResult

  const { hostname, instance } = instanceResult.value
  const origin = instanceOriginForRequest(request, instance)
  if (instance.mode === 'single_tenant' || !isInstanceEntryHost(instance, hostname)) {
    const tenant = await resolveTenantContext(request, env)
    if (!tenant.ok) return tenant
    return { ok: true, value: { status: 'not_instance_entry', tenant: tenant.value } }
  }

  const context = await resolveOrgById(
    db,
    instance,
    tenantId,
    rootResolvedContextOptions(instance, origin),
  )
  if (!context.ok) return context
  return { ok: true, value: { status: 'resolved', tenant: context.value } }
}

export async function resolveTenantContextBySessionHash(
  request: Request,
  env: ResolveEnv,
  refreshTokenHash: string,
): Promise<Result<IssuerTenantResolution>> {
  const db = drizzle(env.DB, { schema })
  const instanceResult = await instanceForRequest(db, request)
  if (!instanceResult.ok) return instanceResult

  const { hostname, instance } = instanceResult.value
  const origin = instanceOriginForRequest(request, instance)
  if (instance.mode === 'single_tenant') {
    const tenant = await resolveSingleTenant(db, instance, origin)
    if (!tenant.ok) return tenant
    return { ok: true, value: { status: 'not_instance_entry', tenant: tenant.value } }
  }
  if (!isInstanceEntryHost(instance, hostname)) {
    const tenant = await resolveMultiTenant(db, instance, hostname, origin)
    if (!tenant.ok) return tenant
    return { ok: true, value: { status: 'not_instance_entry', tenant: tenant.value } }
  }

  const rows = await db
    .select()
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.refreshTokenHash, refreshTokenHash),
        inArray(schema.sessions.status, ['active', 'pending_mfa', 'pending_mfa_setup']),
        gt(schema.sessions.expiresAt, new Date()),
      ),
    )
    .limit(2)
  if (rows.length !== 1) return err('tenant_not_found', 'Session tenant not found', 404)
  const session = rows[0]
  if (!session) return err('tenant_not_found', 'Session tenant not found', 404)

  const context = await resolveOrgById(
    db,
    instance,
    session.tenantId,
    rootResolvedContextOptions(instance, origin),
  )
  if (!context.ok) return context
  return { ok: true, value: { status: 'resolved', tenant: context.value, session } }
}

export async function resolveTenantContextBySsoConnection(
  request: Request,
  env: ResolveEnv,
  connectionId: string,
): Promise<Result<IssuerTenantResolution>> {
  const db = drizzle(env.DB, { schema })
  const instanceResult = await instanceForRequest(db, request)
  if (!instanceResult.ok) return instanceResult

  const { hostname, instance } = instanceResult.value
  const origin = instanceOriginForRequest(request, instance)
  if (instance.mode === 'single_tenant' || !isInstanceEntryHost(instance, hostname)) {
    const tenant = await resolveTenantContext(request, env)
    if (!tenant.ok) return tenant
    return { ok: true, value: { status: 'not_instance_entry', tenant: tenant.value } }
  }

  const rows = await db
    .select({ tenantId: schema.ssoConnections.tenantId })
    .from(schema.ssoConnections)
    .where(
      and(eq(schema.ssoConnections.id, connectionId), eq(schema.ssoConnections.status, 'active')),
    )
    .limit(1)
  const row = rows[0]
  if (!row) return err('tenant_not_found', 'SSO connection does not map to a tenant', 404)

  const context = await resolveOrgById(
    db,
    instance,
    row.tenantId,
    rootResolvedContextOptions(instance, origin),
  )
  if (!context.ok) return context
  return { ok: true, value: { status: 'resolved', tenant: context.value } }
}

export async function resolveTenantContextBySamlServiceProvider(
  request: Request,
  env: ResolveEnv,
  appId: string,
): Promise<Result<IssuerTenantResolution>> {
  const db = drizzle(env.DB, { schema })
  const instanceResult = await instanceForRequest(db, request)
  if (!instanceResult.ok) return instanceResult

  const { hostname, instance } = instanceResult.value
  const origin = instanceOriginForRequest(request, instance)
  if (instance.mode === 'single_tenant' || !isInstanceEntryHost(instance, hostname)) {
    const tenant = await resolveTenantContext(request, env)
    if (!tenant.ok) return tenant
    return { ok: true, value: { status: 'not_instance_entry', tenant: tenant.value } }
  }

  const rows = await db
    .select({ tenantId: schema.samlServiceProviders.tenantId })
    .from(schema.samlServiceProviders)
    .where(eq(schema.samlServiceProviders.id, appId))
    .limit(1)
  const row = rows[0]
  if (!row) return err('tenant_not_found', 'SAML service provider does not map to a tenant', 404)

  const context = await resolveOrgById(
    db,
    instance,
    row.tenantId,
    rootResolvedContextOptions(instance, origin),
  )
  if (!context.ok) return context
  return { ok: true, value: { status: 'resolved', tenant: context.value } }
}

// 入口:按 Host 头解析 TenantContext。先取 instance(主域匹配 / 唯一根),再按 mode 分流。
export async function resolveTenantContext(
  request: Request,
  env: ResolveEnv,
): Promise<Result<TenantContext>> {
  const db = drizzle(env.DB, { schema })
  const instanceResult = await instanceForRequest(db, request)
  if (!instanceResult.ok) return instanceResult
  const { hostname, instance } = instanceResult.value
  const origin = instanceOriginForRequest(request, instance)

  return instance.mode === 'single_tenant'
    ? resolveSingleTenant(db, instance, origin)
    : resolveMultiTenant(db, instance, hostname, origin)
}
