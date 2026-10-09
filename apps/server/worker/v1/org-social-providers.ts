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
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
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

function toConsoleSocialProvider(
  env: Env,
  provider: string,
  policy: SocialProviderPolicy,
): ConsoleSocialProviderPolicy {
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
