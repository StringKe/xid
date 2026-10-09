// /v1/organizations/:id/social-providers:组织级社交登录 provider 配置。client secret 只引用部署方的 Workers Secret。

import { createTenantDb, schema } from '@xid-kit/db'
import type { SocialProviderPolicy } from '@xid-kit/types'
import { normalizeSocialProviders } from '@xid-kit/types'
import { eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import * as v from 'valibot'
import { hasSocialProviderCredentials } from '../auth/hosted-policy'
import {
  hasProviderSecret,
  socialProviderConfigIssue,
  socialProviderSecretBinding,
} from '../auth/social-providers'
import { appleSigningState } from '../auth/apple-client-secret'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { isLoopbackHttpUrl, isPublicHttpsUrl, readJsonBody, validateBody } from '../lib/validate'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import { socialProviderActivity } from './org-auth-insights'
import {
  isRecord,
  readOptionalStringField,
  readPrivateMetadata,
  readStringArrayField,
  readStringField,
} from './org-policy-fields'
import { assertOrgSelfServiceEditable } from './org-self-service'
import { auditOrgMutation } from './org-shared'
import { emitWebhookAsync, requireApiKeyOrOrgManager, requireOrg } from './shared'

type ConsoleSocialProviderPolicy = SocialProviderPolicy & {
  hasClientSecret: boolean
  credentialsReady: boolean
}

type ConsoleSocialProvidersWithActivity = {
  socialProviders: Record<
    string,
    ConsoleSocialProviderPolicy & { signIns30d: number; disabledAt: string | null }
  >
}

// 字段级语义由 mergeSocialProviders 处理,schema 只要求 body 是对象。
const socialProvidersPatchBodySchema = v.record(v.string(), v.unknown())

// Apple 配齐签发密钥时 client_secret 由 APPLE_PRIVATE_KEY 按需签发,静态 APPLE_CLIENT_SECRET 不再使用。
function clientSecretSource(env: Env, provider: string): string | undefined {
  if (provider === 'apple' && appleSigningState(env).kind === 'complete') {
    return 'APPLE_PRIVATE_KEY'
  }
  return socialProviderSecretBinding(env, provider)
}

const ENDPOINT_FIELDS = [
  'authorizationEndpoint',
  'tokenEndpoint',
  'userInfoEndpoint',
  'jwksUri',
] as const

function invalidField(paramName: string): AppError {
  return new AppError('validation_failed', { httpStatus: 422, meta: { paramName } })
}

// 保存时拒绝运行时必然失败的配置:端点必须公网 https(dev/test 与运行时一样放行回环 http),
// 启用的 provider 必须填齐 client_id 与授权、令牌端点。
function assertSocialProviderUsable(env: Env, policy: SocialProviderPolicy): void {
  const allowLoopback = isDevOrTestEnvironment(env)
  for (const field of ENDPOINT_FIELDS) {
    const value = policy[field]
    if (!value) continue
    if (isPublicHttpsUrl(value) || (allowLoopback && isLoopbackHttpUrl(value))) continue
    throw invalidField(field)
  }
  if (!policy.enabled) return
  if (!policy.clientId) throw invalidField('clientId')
  if (!policy.authorizationEndpoint) throw invalidField('authorizationEndpoint')
  if (!policy.tokenEndpoint) throw invalidField('tokenEndpoint')
}

function toConsoleSocialProvider(
  env: Env,
  provider: string,
  policy: SocialProviderPolicy,
): ConsoleSocialProviderPolicy {
  const clientSecretRef = clientSecretSource(env, provider)
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
}

function toConsoleSocialProviders(
  org: typeof schema.organizations.$inferSelect,
  env: Env,
): Record<string, ConsoleSocialProviderPolicy> {
  const providers = normalizeSocialProviders(readPrivateMetadata(org)['socialProviders']) ?? {}
  return Object.fromEntries(
    Object.entries(providers).map(([provider, policy]) => [
      provider,
      toConsoleSocialProvider(env, provider, policy),
    ]),
  )
}

function readSocialProviderPatch(
  provider: string,
  raw: unknown,
  env: Env,
  existing?: SocialProviderPolicy,
): SocialProviderPolicy | null {
  if (!isRecord(raw)) return existing ?? null
  const clientSecretRef = socialProviderSecretBinding(env, provider)
  // 没有部署方声明的凭据绑定的 provider 永远无法登录,保存时就拒绝。
  if (!clientSecretRef) throw invalidField('provider')
  const requestedSecretRef = readOptionalStringField(
    raw,
    ['clientSecretRef', 'client_secret_ref'],
    undefined,
  )
  if (
    requestedSecretRef !== undefined &&
    requestedSecretRef !== clientSecretRef &&
    requestedSecretRef !== clientSecretSource(env, provider)
  ) {
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
  if (issue) throw invalidField(issue)
  assertSocialProviderUsable(env, next)
  return next
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

async function withSocialActivity(
  c: Context<XidHonoEnv>,
  org: typeof schema.organizations.$inferSelect,
): Promise<ConsoleSocialProvidersWithActivity> {
  const socialProviders = toConsoleSocialProviders(org, c.env)
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

export function registerOrgSocialProviderRoutes(app: Hono<XidHonoEnv>): void {
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
    const body = validateBody(socialProvidersPatchBodySchema, json.value)
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
}
