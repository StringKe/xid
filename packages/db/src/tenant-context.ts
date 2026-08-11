// TenantContext 唯一来源:单租户=配置单例,多租户=Host 动态解析;issuer/rpId/签名密钥/策略禁止全局单例。
// 本层只组装结构(私钥仍为密文,解密在 crypto 包);租户不存在/暂停走 Result,意外才 throw。

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
type CustomHostnameRow = typeof schema.customHostnames.$inferSelect

const SIGNING_ALGS = new Set<SigningAlg>(['ES256', 'RS256', 'PS256'])
const SIGNING_STATUSES = new Set<SigningKeyStatus>(['active', 'next', 'retiring'])
const DEFAULT_ORG_SLUG = 'default'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function err(code: XidError['code'], message: string, httpStatus: number): Result<never> {
  return { ok: false, error: { code, message, httpStatus } }
}

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

// WebAuthn 隔离要求 rpId 为具体租户子域,禁止父域(见 webauthn rule)。
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

// session/token:org_policies 列覆盖 instance JSON,再 clamp 到内置默认(02 章 5、08 章 10.6)。
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
  // org 仅有 idle/absolute 列;rememberMeDefault 只在 instance JSON,先 normalize 再逐字段覆盖。
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

// 私钥仍为密文,本层不解密。
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

async function buildCustomHostnameContext(
  db: Db,
  instance: InstanceRow,
  customHostname: CustomHostnameRow,
): Promise<Result<TenantContext>> {
  const orgs = await db
    .select()
    .from(schema.organizations)
    .where(
      and(
        eq(schema.organizations.id, customHostname.orgId),
        eq(schema.organizations.tenantId, customHostname.tenantId),
        eq(schema.organizations.instanceId, instance.id),
      ),
    )
    .limit(1)
  const org = orgs[0]
  if (!org) return err('tenant_not_found', 'Custom hostname does not map to a tenant', 404)
  if (org.status !== 'active') return err('tenant_suspended', 'Tenant is not active', 403)

  const context = await buildContext(db, instance, org, {
    issuer: instanceIssuerFor(instance),
    hostedAuthOrigin: `https://${customHostname.hostname}`,
    rpId: customHostname.hostname,
    resolution: { kind: 'tenant', primaryDomain: instance.primaryDomain },
  })
  return {
    ok: true,
    value: {
      ...context,
      customHostname: customHostname.hostname,
      requiresPasskeyReregistration: customHostname.requiresPasskeyReregistration,
    },
  }
}

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
): Promise<
  Result<{ hostname: string; instance: InstanceRow; customHostname?: CustomHostnameRow }>
> {
  const hostname = hostnameOf(request)
  if (!hostname) return err('tenant_not_found', 'Missing Host header', 400)

  const customHostnameRows = await db
    .select()
    .from(schema.customHostnames)
    .where(
      and(
        eq(schema.customHostnames.hostname, hostname),
        eq(schema.customHostnames.status, 'active'),
        isNull(schema.customHostnames.deletedAt),
      ),
    )
    .limit(1)
  const customHostname = customHostnameRows[0]
  const instanceRows = customHostname
    ? await db
        .select()
        .from(schema.instances)
        .where(eq(schema.instances.id, customHostname.instanceId))
        .limit(1)
    : await db.select().from(schema.instances).limit(1)
  const instance = instanceRows[0]
  if (!instance) return err('tenant_not_found', 'No instance provisioned', 404)
  if (instance.status !== 'active') return err('tenant_suspended', 'Instance is suspended', 403)
  return {
    ok: true,
    value: {
      hostname,
      instance,
      ...(customHostname === undefined ? {} : { customHostname }),
    },
  }
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

// 邀请 locator 与已信任的 instanceId 联合查 org,防止跨 Instance 或被 Host/cookie 静默覆盖。
export async function resolveTenantContextByIdInInstance(
  request: Request,
  env: ResolveEnv,
  tenantId: string,
  instanceId: string,
): Promise<Result<IssuerTenantResolution>> {
  const normalizedTenantId = tenantId.trim()
  const normalizedInstanceId = instanceId.trim()
  if (!normalizedTenantId || !normalizedInstanceId) {
    return err('tenant_not_found', 'Tenant and Instance hints are required', 404)
  }

  const db = drizzle(env.DB, { schema })
  const instances = await db
    .select()
    .from(schema.instances)
    .where(eq(schema.instances.id, normalizedInstanceId))
    .limit(1)
  const instance = instances[0]
  if (!instance) return err('tenant_not_found', 'Instance is not provisioned', 404)
  if (instance.status !== 'active') return err('tenant_suspended', 'Instance is suspended', 403)

  const origin = instanceOriginForRequest(request, instance)
  const context = await resolveOrgById(
    db,
    instance,
    normalizedTenantId,
    rootResolvedContextOptions(instance, origin),
  )
  if (!context.ok) return context
  return { ok: true, value: { status: 'resolved', tenant: context.value } }
}

// OAuth 归属注册应用而非浏览器 cookie;client_id 全局唯一,仍须与 Host 选定的 Instance 一致。
export async function resolveTenantContextByApplicationClientId(
  request: Request,
  env: ResolveEnv,
  clientId: string,
): Promise<Result<TenantContext>> {
  const normalizedClientId = clientId.trim()
  if (!normalizedClientId) return err('tenant_not_found', 'Application client is required', 404)

  const db = drizzle(env.DB, { schema })
  const instanceResult = await instanceForRequest(db, request)
  if (!instanceResult.ok) return instanceResult
  const { instance } = instanceResult.value

  const applications = await db
    .select({ tenantId: schema.applications.tenantId, status: schema.applications.status })
    .from(schema.applications)
    .where(eq(schema.applications.clientId, normalizedClientId))
    .limit(2)
  if (applications.length !== 1 || applications[0]?.status !== 'active') {
    return err('tenant_not_found', 'Application client is not active', 404)
  }
  const tenantId = applications[0].tenantId
  const organizations = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(
      and(
        eq(schema.organizations.tenantId, tenantId),
        eq(schema.organizations.instanceId, instance.id),
        eq(schema.organizations.id, tenantId),
        eq(schema.organizations.status, 'active'),
        isNull(schema.organizations.deletedAt),
      ),
    )
    .limit(1)
  if (!organizations[0]) {
    return err('tenant_not_found', 'Application Tenant is not active in this Instance', 404)
  }

  return resolveOrgById(
    db,
    instance,
    tenantId,
    rootResolvedContextOptions(instance, instanceOriginForRequest(request, instance)),
  )
}

export async function resolveTenantContextBySessionHash(
  request: Request,
  env: ResolveEnv,
  refreshTokenHash: string,
): Promise<Result<IssuerTenantResolution>> {
  const db = drizzle(env.DB, { schema })
  const instanceResult = await instanceForRequest(db, request)
  if (!instanceResult.ok) return instanceResult

  const { hostname, instance, customHostname } = instanceResult.value
  const origin = instanceOriginForRequest(request, instance)
  if (customHostname) {
    const tenant = await buildCustomHostnameContext(db, instance, customHostname)
    if (!tenant.ok) return tenant
    return { ok: true, value: { status: 'not_instance_entry', tenant: tenant.value } }
  }
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

export async function resolveTenantContext(
  request: Request,
  env: ResolveEnv,
): Promise<Result<TenantContext>> {
  const db = drizzle(env.DB, { schema })
  const instanceResult = await instanceForRequest(db, request)
  if (!instanceResult.ok) return instanceResult
  const { hostname, instance, customHostname } = instanceResult.value
  const origin = instanceOriginForRequest(request, instance)

  if (customHostname) return buildCustomHostnameContext(db, instance, customHostname)

  return instance.mode === 'single_tenant'
    ? resolveSingleTenant(db, instance, origin)
    : resolveMultiTenant(db, instance, hostname, origin)
}
