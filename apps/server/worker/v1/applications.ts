// Management API v1: applications/oauthApplications(= OAuthClient)
// CRUD + client_secret rotate。见 06 章 7 Management API 表、oidc-oauth rule。
// 租户隔离:tenant_id 从 TenantContext 取,禁信任 body(见 tenant-isolation rule)。
// 授权见 application-access.ts:顶层组织管理员与 API key 全租户,Project Manager 只见本项目应用。
// 路由前缀:/v1/applications

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { normalizePublicJwks, STANDARD_OIDC_SCOPES } from '@xid-kit/protocol'
import { TOKEN_POLICY_BOUNDS } from '@xid-kit/types'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import {
  publicHttpsUrlSchema,
  readJsonBody,
  ttlSecSchema,
  validateBody,
  validatePostLogoutRedirectUris,
  validateRedirectUris,
} from '../lib/validate'
import { validateBackchannelLogoutUri, validateFrontchannelLogoutUri } from '../oauth/register'
import { emitManagementAuditAsync, idAfterCursor, paginate, parsePagination } from './shared'
import {
  assertApplicationVisible,
  assertProjectAssignable,
  assertProjectListable,
  resolveApplicationAccess,
  type ApplicationAccess,
} from './application-access'
import {
  VALID_AUTH_METHODS,
  VALID_CLIENT_TYPES,
  VALID_GRANT_TYPES,
  VALID_RESPONSE_TYPES,
  sharedSecretAuthMethod,
  storedClientPolicy,
  validateClientRegistrationPolicy,
} from '../oidc/client-registration-policy'

const app = new Hono<XidHonoEnv>()

// access_token_ttl_sec 边界与 normalize 同源(TOKEN_POLICY_BOUNDS),出界即拒,不靠 clamp 静默改写。
// 额外 v.integer():ttlSecSchema 只管上下界,非整数秒同样拒。null = 清除 client 覆盖回继承(写 NULL)。
const accessTokenTtlSecBounds = TOKEN_POLICY_BOUNDS.accessTokenTtlSec
const accessTokenTtlSecSchema = v.nullable(
  v.pipe(ttlSecSchema(accessTokenTtlSecBounds.min, accessTokenTtlSecBounds.max), v.integer()),
)

// 形状校验只管字段类型/必填性;唯一性等业务校验留在 handler(见 error-handling rule)。
// application_type:native 放行 loopback http 与自定义 scheme redirect_uri(RFC8252)。
const applicationNameSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))
const logoutUriSchema = v.nullable(v.pipe(v.string(), v.maxLength(2048)))

const createApplicationBodySchema = v.object({
  name: applicationNameSchema,
  logo_uri: v.optional(v.nullable(publicHttpsUrlSchema)),
  project_id: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1)))),
  backchannel_logout_uri: v.optional(logoutUriSchema),
  backchannel_logout_session_required: v.optional(v.boolean()),
  frontchannel_logout_uri: v.optional(logoutUriSchema),
  first_party: v.optional(v.boolean()),
  require_org_context: v.optional(v.boolean()),
  client_type: v.optional(v.picklist(VALID_CLIENT_TYPES)),
  token_endpoint_auth_method: v.optional(v.picklist(VALID_AUTH_METHODS)),
  application_type: v.optional(v.picklist(['web', 'native'])),
  redirect_uris: v.optional(v.array(v.string())),
  post_logout_redirect_uris: v.optional(v.array(v.string())),
  allowed_grant_types: v.optional(v.array(v.picklist(VALID_GRANT_TYPES))),
  allowed_response_types: v.optional(v.array(v.picklist(VALID_RESPONSE_TYPES))),
  allowed_scopes: v.optional(v.array(v.string())),
  require_pkce: v.optional(v.boolean()),
  dpop_bound_access_tokens: v.optional(v.boolean()),
  jwks: v.optional(v.record(v.string(), v.unknown())),
  tls_client_auth_subject_dn: v.optional(v.string()),
  tls_client_auth_cert_thumbprints: v.optional(v.array(v.string())),
})

const patchApplicationBodySchema = v.object({
  name: v.optional(applicationNameSchema),
  logo_uri: v.optional(v.nullable(publicHttpsUrlSchema)),
  project_id: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1)))),
  backchannel_logout_uri: v.optional(logoutUriSchema),
  backchannel_logout_session_required: v.optional(v.boolean()),
  frontchannel_logout_uri: v.optional(logoutUriSchema),
  first_party: v.optional(v.boolean()),
  require_org_context: v.optional(v.boolean()),
  application_type: v.optional(v.picklist(['web', 'native'])),
  redirect_uris: v.optional(v.array(v.string())),
  post_logout_redirect_uris: v.optional(v.array(v.string())),
  allowed_grant_types: v.optional(v.array(v.picklist(VALID_GRANT_TYPES))),
  allowed_response_types: v.optional(v.array(v.picklist(VALID_RESPONSE_TYPES))),
  allowed_scopes: v.optional(v.array(v.string())),
  require_pkce: v.optional(v.boolean()),
  dpop_bound_access_tokens: v.optional(v.boolean()),
  jwks: v.optional(v.record(v.string(), v.unknown())),
  status: v.optional(v.picklist(['active', 'deleted'])),
  access_token_ttl_sec: v.optional(accessTokenTtlSecSchema),
  tls_client_auth_subject_dn: v.optional(v.string()),
  tls_client_auth_cert_thumbprints: v.optional(v.array(v.string())),
})

// redirect_uris 注册校验(DCR 共用 validateRedirectUris):http 明文/fragment/空串 -> 422,
// authorization_code grant 必须非空(否则 authorize 永远无法精确匹配,见 03 章)。
function assertRedirectUris(
  uris: readonly string[],
  options: { applicationType: 'web' | 'native'; grantTypes: readonly string[] },
): void {
  const check = validateRedirectUris(uris, options)
  if (!check.ok) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'redirect_uris' },
    })
  }
}

function assertPostLogoutRedirectUris(uris: readonly string[]): void {
  const check = validatePostLogoutRedirectUris(uris)
  if (!check.ok) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'post_logout_redirect_uris' },
    })
  }
}

// 生成 client_id(随机 26 字符字母数字)和 client_secret(随机 40 字符)。
function genClientId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(36))
    .join('')
    .slice(0, 26)
}

function genClientSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(30))
  return Array.from(bytes)
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 40)
}

function normalizeTlsThumbprints(values: readonly string[]): string[] {
  const normalized = values.map((value) => value.replaceAll(':', '').toLowerCase())
  if (normalized.some((value) => !/^[0-9a-f]{64}$/.test(value))) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'tls_client_auth_cert_thumbprints' },
    })
  }
  return [...new Set(normalized)]
}

function assertMtlsConfig(input: {
  method: string
  subjectDn: string | undefined
  thumbprints: readonly string[]
}): void {
  if (
    (input.method === 'tls_client_auth' || input.method === 'self_signed_tls_client_auth') &&
    !input.subjectDn?.trim()
  ) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'tls_client_auth_subject_dn' },
    })
  }
  if (input.method === 'self_signed_tls_client_auth' && input.thumbprints.length === 0) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'tls_client_auth_cert_thumbprints' },
    })
  }
}

function assertClientPolicy(policy: Parameters<typeof validateClientRegistrationPolicy>[0]): void {
  const violation = validateClientRegistrationPolicy(policy)
  if (!violation) return
  throw new AppError('validation_failed', {
    httpStatus: 422,
    meta: { paramName: violation.field },
  })
}

async function loadScopeCatalog(
  db: ReturnType<typeof createTenantDb>,
): Promise<ReadonlySet<string>> {
  const rows = await db.resourceServers.findMany()
  const catalog = new Set<string>(STANDARD_OIDC_SCOPES)
  for (const row of rows) {
    for (const scope of row.scopes) catalog.add(scope)
  }
  return catalog
}

async function assertScopes(
  db: ReturnType<typeof createTenantDb>,
  scopes: readonly string[],
): Promise<void> {
  const catalog = await loadScopeCatalog(db)
  if (scopes.some((scope) => !catalog.has(scope))) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'allowed_scopes' },
    })
  }
}

function normalizeJwks(value: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (value === undefined) return null
  const normalized = normalizePublicJwks(value)
  if (!normalized.ok) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'jwks' },
    })
  }
  return normalized.value
}

// application 是租户级资源,审计 orgId 记顶层组织,顶层组织管理员的审计页可见。
function auditApplication(
  c: Context<XidHonoEnv>,
  access: ApplicationAccess,
  input: { action: string; row: typeof schema.applications.$inferSelect },
): void {
  emitManagementAuditAsync(c, {
    action: input.action,
    actorId: access.actorId,
    orgId: c.get('tenant').tenantId,
    targetType: 'application',
    targetId: input.row.id,
    details: { clientId: input.row.clientId },
  })
}

// 登出 URI 与 DCR 同一套规则:back-channel 必须是公网 https 且无 fragment,front-channel 必须是绝对 https。
function assertLogoutUris(input: {
  backchannel: string | null | undefined
  frontchannel: string | null | undefined
}): void {
  if (input.backchannel && validateBackchannelLogoutUri(input.backchannel)) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'backchannel_logout_uri' },
    })
  }
  if (input.frontchannel && validateFrontchannelLogoutUri(input.frontchannel)) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'frontchannel_logout_uri' },
    })
  }
}

async function findActiveApplication(
  c: Context<XidHonoEnv>,
  access: ApplicationAccess,
  status: 'active' | 'deleted' = 'active',
): Promise<typeof schema.applications.$inferSelect> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const row = await db.applications.findOne(
    and(
      eq(schema.applications.id, c.req.param('id') ?? ''),
      eq(schema.applications.status, status),
    ),
  )
  if (!row) throw new AppError('not_found')
  await assertApplicationVisible(c, access, row)
  return row
}

// 应用行转对外响应(不返回 clientSecretHash)。name 为空(旧数据或 DCR 未带 client_name)时回退 client_id。
function toResponse(row: typeof schema.applications.$inferSelect) {
  const mtlsConfig = (row.customClaimsConfig ?? {}) as Record<string, unknown>
  return {
    id: row.id,
    name: row.name ?? row.clientId,
    logo_uri: row.logoUri,
    project_id: row.projectId,
    application_type: row.applicationType,
    client_id: row.clientId,
    client_type: row.clientType,
    token_endpoint_auth_method: row.tokenEndpointAuthMethod,
    redirect_uris: row.redirectUris,
    post_logout_redirect_uris: row.postLogoutRedirectUris,
    allowed_grant_types: row.allowedGrantTypes,
    allowed_response_types: row.allowedResponseTypes,
    allowed_scopes: row.allowedScopes,
    require_pkce: row.requirePkce,
    dpop_bound_access_tokens: row.dpopBoundAccessTokens,
    access_token_format: row.accessTokenFormat,
    access_token_ttl_sec: row.accessTokenTtlSec,
    id_token_signed_alg: row.idTokenSignedAlg,
    tls_client_auth_subject_dn: mtlsConfig['tlsClientAuthSubjectDn'] ?? null,
    tls_client_auth_cert_thumbprints: mtlsConfig['tlsClientAuthCertThumbprints'] ?? [],
    first_party: row.firstParty,
    require_org_context: row.requireOrgContext,
    backchannel_logout_uri: row.backchannelLogoutUri,
    backchannel_logout_session_required: row.backchannelLogoutSessionRequired,
    frontchannel_logout_uri: row.frontchannelLogoutUri,
    status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

// GET /v1/applications?project_id=
app.get('/', async (c) => {
  const access = await resolveApplicationAccess(c, 'applications:read')
  const projectId = c.req.query('project_id') || undefined
  await assertProjectListable(c, access, projectId)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const { limit, cursor } = parsePagination(c)
  const rows = await db.applications.findMany(
    and(
      eq(schema.applications.status, 'active'),
      projectId ? eq(schema.applications.projectId, projectId) : undefined,
      idAfterCursor(schema.applications.id, cursor),
    ),
    { orderBy: asc(schema.applications.id), limit: limit + 1 },
  )
  return c.json(paginate(rows.map(toResponse), (r) => r.id, limit))
})

// POST /v1/applications
app.post('/', async (c) => {
  const access = await resolveApplicationAccess(c, 'applications:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createApplicationBodySchema, json.value)
  if (body.project_id) await assertProjectAssignable(c, access, body.project_id)
  else if (!access.tenantWide) throw new AppError('forbidden', { httpStatus: 403 })
  assertLogoutUris({
    backchannel: body.backchannel_logout_uri,
    frontchannel: body.frontchannel_logout_uri,
  })
  const clientType = body.client_type ?? 'confidential'
  const tokenEndpointAuthMethod =
    body.token_endpoint_auth_method ?? (clientType === 'public' ? 'none' : 'client_secret_basic')
  const grantTypes =
    body.allowed_grant_types ??
    (clientType === 'public' ? ['authorization_code'] : ['authorization_code', 'refresh_token'])
  const responseTypes = body.allowed_response_types ?? ['code']
  const allowedScopes =
    body.allowed_scopes ??
    (clientType === 'public'
      ? ['openid', 'profile', 'email']
      : ['openid', 'profile', 'email', 'offline_access'])
  const requirePkce = clientType === 'public' ? true : body.require_pkce !== false
  const dpopBoundAccessTokens = body.dpop_bound_access_tokens ?? false
  assertRedirectUris(body.redirect_uris ?? [], {
    applicationType: body.application_type ?? 'web',
    grantTypes,
  })
  assertPostLogoutRedirectUris(body.post_logout_redirect_uris ?? [])
  const tlsThumbprints = normalizeTlsThumbprints(body.tls_client_auth_cert_thumbprints ?? [])
  assertMtlsConfig({
    method: tokenEndpointAuthMethod,
    subjectDn: body.tls_client_auth_subject_dn,
    thumbprints: tlsThumbprints,
  })
  const jwks = normalizeJwks(body.jwks)
  const hasClientSecret = sharedSecretAuthMethod(tokenEndpointAuthMethod)
  assertClientPolicy({
    clientType,
    authMethod: tokenEndpointAuthMethod,
    grantTypes,
    responseTypes,
    scopes: allowedScopes,
    requirePkce,
    dpopBoundAccessTokens,
    hasClientSecret,
    jwks,
    tlsClientAuthSubjectDn: body.tls_client_auth_subject_dn,
    tlsClientAuthCertThumbprints: tlsThumbprints,
  })
  await assertScopes(db, allowedScopes)

  const clientSecret = hasClientSecret ? genClientSecret() : null
  const clientSecretHash = clientSecret ? await sha256Hex(clientSecret) : null
  const clientId = genClientId()
  const id = createPersistedId('application')

  const row = await db.applications.insert({
    id,
    tenantId: tenant.tenantId,
    name: body.name,
    logoUri: body.logo_uri ?? null,
    projectId: body.project_id ?? null,
    applicationType: body.application_type ?? null,
    backchannelLogoutUri: body.backchannel_logout_uri ?? null,
    backchannelLogoutSessionRequired: body.backchannel_logout_session_required ?? false,
    frontchannelLogoutUri: body.frontchannel_logout_uri ?? null,
    firstParty: body.first_party ?? false,
    requireOrgContext: body.require_org_context ?? false,
    clientId,
    clientSecretHash,
    clientType,
    tokenEndpointAuthMethod,
    jwks,
    redirectUris: body.redirect_uris ?? [],
    postLogoutRedirectUris: body.post_logout_redirect_uris ?? [],
    allowedGrantTypes: grantTypes,
    allowedResponseTypes: responseTypes,
    allowedScopes,
    requirePkce,
    dpopBoundAccessTokens,
    customClaimsConfig: {
      ...(body.tls_client_auth_subject_dn
        ? { tlsClientAuthSubjectDn: body.tls_client_auth_subject_dn }
        : {}),
      ...(tlsThumbprints.length > 0 ? { tlsClientAuthCertThumbprints: tlsThumbprints } : {}),
    },
    status: 'active',
  })
  auditApplication(c, access, { action: 'application.created', row })

  return c.json(
    {
      ...toResponse(row),
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    },
    201,
  )
})

// GET /v1/applications/:id
app.get('/:id', async (c) => {
  const access = await resolveApplicationAccess(c, 'applications:read')
  return c.json(toResponse(await findActiveApplication(c, access)))
})

function applyDisplayAndLogoutPatch(
  body: v.InferOutput<typeof patchApplicationBodySchema>,
  patch: Partial<typeof schema.applications.$inferInsert>,
): void {
  if (body.name !== undefined) patch.name = body.name
  if (body.logo_uri !== undefined) patch.logoUri = body.logo_uri
  if (body.project_id !== undefined) patch.projectId = body.project_id
  if (body.application_type !== undefined) patch.applicationType = body.application_type
  if (body.backchannel_logout_uri !== undefined) {
    patch.backchannelLogoutUri = body.backchannel_logout_uri
  }
  if (body.backchannel_logout_session_required !== undefined) {
    patch.backchannelLogoutSessionRequired = body.backchannel_logout_session_required
  }
  if (body.frontchannel_logout_uri !== undefined) {
    patch.frontchannelLogoutUri = body.frontchannel_logout_uri
  }
  if (body.first_party !== undefined) patch.firstParty = body.first_party
  if (body.require_org_context !== undefined) patch.requireOrgContext = body.require_org_context
}

// PATCH /v1/applications/:id
app.patch('/:id', async (c) => {
  const access = await resolveApplicationAccess(c, 'applications:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchApplicationBodySchema, json.value)
  const existing = await findActiveApplication(c, access)
  const where = and(
    eq(schema.applications.id, existing.id),
    eq(schema.applications.status, 'active'),
  )
  if (body.project_id) await assertProjectAssignable(c, access, body.project_id)
  if (body.project_id === null && !access.tenantWide) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'project_id' } })
  }
  assertLogoutUris({
    backchannel: body.backchannel_logout_uri,
    frontchannel: body.frontchannel_logout_uri,
  })

  const patch: Partial<typeof schema.applications.$inferInsert> = {}
  applyDisplayAndLogoutPatch(body, patch)
  const grantTypes = body.allowed_grant_types ?? existing.allowedGrantTypes
  const responseTypes = body.allowed_response_types ?? existing.allowedResponseTypes
  const allowedScopes = body.allowed_scopes ?? existing.allowedScopes
  const redirectUris = body.redirect_uris ?? existing.redirectUris
  const requirePkce = body.require_pkce ?? existing.requirePkce
  const dpopBoundAccessTokens = body.dpop_bound_access_tokens ?? existing.dpopBoundAccessTokens
  assertRedirectUris(redirectUris, {
    applicationType: body.application_type ?? existing.applicationType ?? 'web',
    grantTypes,
  })
  if (body.redirect_uris !== undefined) patch.redirectUris = body.redirect_uris
  if (body.post_logout_redirect_uris !== undefined) {
    assertPostLogoutRedirectUris(body.post_logout_redirect_uris)
    patch.postLogoutRedirectUris = body.post_logout_redirect_uris
  }
  if (body.allowed_grant_types !== undefined) patch.allowedGrantTypes = body.allowed_grant_types
  if (body.allowed_response_types !== undefined) {
    patch.allowedResponseTypes = body.allowed_response_types
  }
  if (body.allowed_scopes !== undefined) patch.allowedScopes = body.allowed_scopes
  if (body.require_pkce !== undefined) patch.requirePkce = body.require_pkce
  if (body.dpop_bound_access_tokens !== undefined) {
    patch.dpopBoundAccessTokens = body.dpop_bound_access_tokens
  }
  if (body.jwks !== undefined) patch.jwks = normalizeJwks(body.jwks)
  if (body.status !== undefined) patch.status = body.status
  if (body.access_token_ttl_sec !== undefined) patch.accessTokenTtlSec = body.access_token_ttl_sec
  const current = (existing.customClaimsConfig ?? {}) as Record<string, unknown>
  const currentThumbprints = Array.isArray(current['tlsClientAuthCertThumbprints'])
    ? current['tlsClientAuthCertThumbprints'].filter(
        (value): value is string => typeof value === 'string',
      )
    : []
  const tlsThumbprints =
    body.tls_client_auth_cert_thumbprints === undefined
      ? currentThumbprints
      : normalizeTlsThumbprints(body.tls_client_auth_cert_thumbprints)
  const subjectDn =
    body.tls_client_auth_subject_dn ??
    (typeof current['tlsClientAuthSubjectDn'] === 'string'
      ? current['tlsClientAuthSubjectDn']
      : undefined)
  assertMtlsConfig({
    method: existing.tokenEndpointAuthMethod,
    subjectDn,
    thumbprints: tlsThumbprints,
  })
  if (
    body.tls_client_auth_subject_dn !== undefined ||
    body.tls_client_auth_cert_thumbprints !== undefined
  ) {
    patch.customClaimsConfig = {
      ...current,
      ...(subjectDn ? { tlsClientAuthSubjectDn: subjectDn } : {}),
      tlsClientAuthCertThumbprints: tlsThumbprints,
    }
  }
  assertClientPolicy({
    ...storedClientPolicy(existing),
    grantTypes,
    responseTypes,
    scopes: allowedScopes,
    requirePkce,
    dpopBoundAccessTokens,
    jwks: body.jwks === undefined ? existing.jwks : patch.jwks,
    tlsClientAuthSubjectDn: subjectDn,
    tlsClientAuthCertThumbprints: tlsThumbprints,
  })
  await assertScopes(db, allowedScopes)

  const updated = await db.applications.update(patch, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found')
  auditApplication(c, access, { action: 'application.updated', row })
  return c.json(toResponse(row))
})

// DELETE /v1/applications/:id
app.delete('/:id', async (c) => {
  const access = await resolveApplicationAccess(c, 'applications:write')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const existing = await findActiveApplication(c, access)
  await db.applications.update(
    { status: 'deleted', updatedAt: new Date() },
    and(eq(schema.applications.id, existing.id), eq(schema.applications.status, 'active')),
  )
  auditApplication(c, access, { action: 'application.deleted', row: existing })
  return new Response(null, { status: 204 })
})

// POST /v1/applications/:id/restore
app.post('/:id/restore', async (c) => {
  const access = await resolveApplicationAccess(c, 'applications:write')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const existing = await findActiveApplication(c, access, 'deleted')
  assertClientPolicy(storedClientPolicy(existing))
  await assertScopes(db, existing.allowedScopes)
  const updated = await db.applications.update(
    { status: 'active', updatedAt: new Date() },
    and(eq(schema.applications.id, existing.id), eq(schema.applications.status, 'deleted')),
  )
  const row = updated[0]
  if (!row) throw new AppError('not_found')
  auditApplication(c, access, { action: 'application.restored', row })
  return c.json(toResponse(row))
})

// POST /v1/applications/:id/rotate-secret
app.post('/:id/rotate-secret', async (c) => {
  const access = await resolveApplicationAccess(c, 'applications:write')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const existing = await findActiveApplication(c, access)
  const where = and(
    eq(schema.applications.id, existing.id),
    eq(schema.applications.status, 'active'),
  )
  assertClientPolicy(storedClientPolicy(existing))
  if (!sharedSecretAuthMethod(existing.tokenEndpointAuthMethod)) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'token_endpoint_auth_method' },
    })
  }

  const newSecret = genClientSecret()
  const newHash = await sha256Hex(newSecret)
  await db.applications.update({ clientSecretHash: newHash }, where)
  auditApplication(c, access, { action: 'application.secret_rotated', row: existing })
  return c.json({ client_secret: newSecret })
})

export function registerApplications(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/applications', app)
}
