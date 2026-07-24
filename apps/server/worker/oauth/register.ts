// /register - RFC7591/7592 Dynamic Client Registration
// POST /register:动态注册(返回 client_id + registration_access_token)。
// GET/PATCH/DELETE /register/{client_id}:管理端点(读/更新/删)。
// client_secret 哈希存储,明文不入库。
// registration_access_token 哈希存储(registrationAccessTokenHash 列)。
// 错误形状:RFC7591 3.2.2,元数据失败按规范码(见 DcrErrorCode),形状失败 invalid_request,
// 管理端 RAT 失败 401 { error: invalid_client } + WWW-Authenticate。
// 见 oidc-oauth rule / docs/design/03-oidc-oauth.md endpoint 表。
// 铁律:TenantContext 从 c.get('tenant') 取;D1 查询走 @xid-kit/db 租户查询层。

import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import * as v from 'valibot'
import { sha256Hex, base64UrlEncode } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { TOKEN_POLICY_BOUNDS } from '@xid-kit/types'
import type { Result } from '@xid-kit/types'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { checkRateLimitStore } from '../lib/rate-limit'
import { isPublicHttpsUrl, readJsonBody, validateRedirectUris } from '../lib/validate'
import { oauthError, oauthInvalidRequest } from '../oidc/shared'
import { POLICIES } from '../durable-objects/rate-limit-store'

const app = new Hono<XidHonoEnv>()

const SECRET_BYTES = 32
const RAT_BYTES = 32

// 标准 OIDC scope 六件(03 章);自定义 scope 必须来自已注册 resource_servers(08 章 15.6)。
const STANDARD_OIDC_SCOPES = [
  'openid',
  'profile',
  'email',
  'address',
  'phone',
  'offline_access',
] as const

// RFC7592:管理端点 RAT(Bearer)认证失败的 401 必须带 WWW-Authenticate。
const RAT_AUTH_CHALLENGE = 'Bearer realm="xid", error="invalid_client"'

const VALID_AUTH_METHODS = [
  'client_secret_basic',
  'client_secret_post',
  'private_key_jwt',
  'tls_client_auth',
  'self_signed_tls_client_auth',
  'none',
] as const
const VALID_GRANT_TYPES = [
  'authorization_code',
  'refresh_token',
  'client_credentials',
  'urn:ietf:params:oauth:grant-type:device_code',
  'urn:ietf:params:oauth:grant-type:token-exchange',
  'urn:openid:params:grant-type:ciba',
] as const
const VALID_RESPONSE_TYPES = ['code', 'code id_token'] as const

// 顶层形状:只卡字段类型(strings/arrays/booleans/nullable number);v.object 忽略未知扩展字段
// (RFC7591 允许客户端带扩展元数据)。domain 校验(auth method / grant / response_type 白名单、
// OIDC metadata、ttl 边界)仍由下方 validate/normalize 函数承担,不在 schema 重复。
const registrationBodySchema = v.object({
  redirect_uris: v.optional(v.array(v.string())),
  post_logout_redirect_uris: v.optional(v.array(v.string())),
  token_endpoint_auth_method: v.optional(v.string()),
  grant_types: v.optional(v.array(v.string())),
  response_types: v.optional(v.array(v.string())),
  scope: v.optional(v.string()),
  jwks: v.optional(v.record(v.string(), v.unknown())),
  id_token_signed_response_alg: v.optional(v.string()),
  sector_identifier_uri: v.optional(v.string()),
  subject_type: v.optional(v.string()),
  request_uris: v.optional(v.array(v.string())),
  frontchannel_logout_uri: v.optional(v.string()),
  backchannel_logout_uri: v.optional(v.string()),
  backchannel_logout_session_required: v.optional(v.boolean()),
  tls_client_auth_subject_dn: v.optional(v.string()),
  dpop_bound_access_tokens: v.optional(v.boolean()),
  access_token_ttl_sec: v.optional(v.nullable(v.number())),
  fapi_profile: v.optional(v.boolean()),
  software_statement: v.optional(v.string()),
  // RFC7591 application_type(web/native):仅校验期使用(applications 表无此列),
  // native 放行 loopback http 与自定义 scheme redirect_uri(RFC8252)。
  application_type: v.optional(v.string()),
})

type RegistrationRequest = v.InferOutput<typeof registrationBodySchema>

type AppInsert = typeof schema.applications.$inferInsert

// RFC7591 3.2.2 规范错误码:URI 校验类 invalid_redirect_uri,其余元数据 invalid_client_metadata,
// software_statement invalid_software_statement;形状层失败走 invalid_request(规范允许)。
type DcrErrorCode =
  | 'invalid_request'
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata'
  | 'invalid_software_statement'
type DcrError = { code: DcrErrorCode; description: string }

function metaErr(description: string): DcrError {
  return { code: 'invalid_client_metadata', description }
}

function redirectErr(description: string): DcrError {
  return { code: 'invalid_redirect_uri', description }
}

function dcrFail(c: Context<XidHonoEnv>, err: DcrError): Response {
  return oauthError(c, { status: 400, error: err.code, description: err.description })
}

function genSecret(): string {
  return `sk_${base64UrlEncode(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)))}`
}
function genRat(): string {
  return `rat_${base64UrlEncode(crypto.getRandomValues(new Uint8Array(RAT_BYTES)))}`
}
function genClientId(): string {
  return `client_${base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)))}`
}

function extractBearer(authHeader: string): string | null {
  return /^Bearer\s+(.+)$/i.exec(authHeader)?.[1] ?? null
}

// DCR 防滥用(RFC7591):本实现未配置 initial access token issuer 或 software_statement trust root,
// 因此这两类信任信号不可绕过限流,出现即拒绝。匿名注册按 IP 限流。
async function enforceDcrRateLimit(c: Context<XidHonoEnv>, tenantId: string): Promise<void> {
  const ip = c.req.header('cf-connecting-ip') ?? 'anon'
  const key = `dcr:register:${tenantId}:${ip}`
  const result = await checkRateLimitStore(c.env, key, POLICIES.DCR_REGISTER)
  if (!result.allowed) throw new AppError('rate_limited')
}

function rejectUnsupportedTrustSignals(
  c: Context<XidHonoEnv>,
  body: RegistrationRequest,
): DcrError | null {
  if (extractBearer(c.req.header('authorization') ?? '') !== null) {
    return { code: 'invalid_request', description: 'initial access token is not supported' }
  }
  if (typeof body.software_statement === 'string' && body.software_statement.length > 0) {
    return {
      code: 'invalid_software_statement',
      description: 'software_statement is not supported',
    }
  }
  return null
}

async function authenticateRat(authHeader: string, expectedHash: string | null): Promise<boolean> {
  if (!expectedHash) return false
  const rat = extractBearer(authHeader)
  if (!rat) return false
  const hash = await sha256Hex(rat)
  if (hash.length !== expectedHash.length) return false
  let diff = 0
  for (let i = 0; i < hash.length; i++) {
    diff |= hash.charCodeAt(i) ^ expectedHash.charCodeAt(i)
  }
  return diff === 0
}

// 管理端点公共守卫:client 存在 + RAT 有效。失败直接产出 RFC7592 错误响应。
async function requireRegisteredClient(
  c: Context<XidHonoEnv>,
  db: ReturnType<typeof createTenantDb>,
  clientId: string,
): Promise<typeof schema.applications.$inferSelect | Response> {
  const row = await db.applications.findOne(
    and(eq(schema.applications.clientId, clientId), eq(schema.applications.status, 'active')),
  )
  if (!row) {
    return oauthError(c, { status: 404, error: 'not_found', description: 'client not found' })
  }
  if (
    !(await authenticateRat(c.req.header('authorization') ?? '', row.registrationAccessTokenHash))
  ) {
    return oauthError(c, {
      status: 401,
      error: 'invalid_client',
      description: 'invalid registration access token',
      extraHeaders: { 'www-authenticate': RAT_AUTH_CHALLENGE },
    })
  }
  return row
}

function validateGrantTypes(grantTypes: string[]): DcrError | null {
  for (const gt of grantTypes) {
    if (!VALID_GRANT_TYPES.includes(gt as (typeof VALID_GRANT_TYPES)[number])) {
      return metaErr(`unsupported grant_type: ${gt}`)
    }
  }
  return null
}

function validateResponseTypes(responseTypes: string[]): DcrError | null {
  for (const rt of responseTypes) {
    if (!VALID_RESPONSE_TYPES.includes(rt as (typeof VALID_RESPONSE_TYPES)[number])) {
      return metaErr(`unsupported response_type: ${rt}`)
    }
  }
  return null
}

// schema 已卡 boolean,这里只归一 undefined(未提供)-> false。
function normalizeDpopBoundAccessTokens(value: boolean | undefined): boolean {
  return value ?? false
}

// access_token_ttl_sec 边界与 normalize 同源(TOKEN_POLICY_BOUNDS),出界即拒,不靠 clamp 静默改写。
// null = 显式清除 client 覆盖回继承(写 NULL);undefined = 字段未提供。
function normalizeAccessTokenTtlSec(
  value: number | null | undefined,
): Result<number | null | undefined, DcrError> {
  if (value === undefined) return { ok: true, value: undefined }
  if (value === null) return { ok: true, value: null }
  const bounds = TOKEN_POLICY_BOUNDS.accessTokenTtlSec
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    return {
      ok: false,
      error: metaErr(
        `access_token_ttl_sec must be an integer between ${bounds.min} and ${bounds.max}`,
      ),
    }
  }
  return { ok: true, value }
}

function defaultGrantTypes(authMethod: string): string[] {
  return authMethod === 'none' ? ['authorization_code'] : ['authorization_code', 'refresh_token']
}

function resolveGrantTypes(authMethod: string, body: Partial<RegistrationRequest>): string[] {
  return body.grant_types ?? defaultGrantTypes(authMethod)
}

function validatePublicRefreshPolicy(input: {
  authMethod: string
  grantTypes: readonly string[]
  dpopBoundAccessTokens: boolean
}): DcrError | null {
  if (
    input.authMethod === 'none' &&
    input.grantTypes.includes('refresh_token') &&
    !input.dpopBoundAccessTokens
  ) {
    return metaErr('public clients with refresh_token require dpop_bound_access_tokens=true')
  }
  return null
}

function validateOidcMetadata(body: Partial<RegistrationRequest>): DcrError | null {
  if (
    body.id_token_signed_response_alg !== undefined &&
    body.id_token_signed_response_alg !== 'ES256'
  ) {
    return metaErr(`unsupported id_token_signed_response_alg: ${body.id_token_signed_response_alg}`)
  }
  if (body.subject_type !== undefined && body.subject_type !== 'public') {
    return metaErr(`unsupported subject_type: ${body.subject_type}`)
  }
  if (body.sector_identifier_uri !== undefined) {
    return metaErr('sector_identifier_uri is not supported')
  }
  if (body.request_uris !== undefined) {
    return metaErr('request_uris is not supported')
  }
  if (body.frontchannel_logout_uri !== undefined) {
    const err = validateFrontchannelLogoutUri(body.frontchannel_logout_uri)
    if (err) return err
  }
  // logout_token 恒含 sid,backchannel_logout_session_required=true 与行为一致,直接接受。
  if (body.tls_client_auth_subject_dn !== undefined) {
    const err = validateTlsSubjectDn(body.tls_client_auth_subject_dn)
    if (err) return err
  }
  if (body.backchannel_logout_uri !== undefined) {
    const err = validateBackchannelLogoutUri(body.backchannel_logout_uri)
    if (err) return err
  }
  return null
}

function validateFrontchannelLogoutUri(uri: string): DcrError | null {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return redirectErr('frontchannel_logout_uri must be absolute')
  }
  if (parsed.protocol !== 'https:') {
    return redirectErr('frontchannel_logout_uri must use https')
  }
  return null
}

function validateTlsSubjectDn(dn: string): DcrError | null {
  if (dn.trim().length === 0) {
    return metaErr('tls_client_auth_subject_dn must be a non-empty string')
  }
  return null
}

// backchannel_logout_uri 是 worker 服务端 POST logout_token 的目标(RP-Init Logout 03 章):
// 只查 https 可指内网/云 metadata(SSRF),必须 https + 公网(见 validate.ts isPublicHttpsUrl)。
function validateBackchannelLogoutUri(uri: string): DcrError | null {
  if (!isPublicHttpsUrl(uri)) {
    return redirectErr('backchannel_logout_uri must be a public https URL')
  }
  if (new URL(uri).hash.length > 0) {
    return redirectErr('backchannel_logout_uri must not include fragment')
  }
  return null
}

// scope catalog:标准 OIDC 六件 ∪ 已注册 resource_servers 的 scope 全集。
// DCR 自报 scope 直接入库 = 任意客户端白拿未注册 scope(如 admin),必须按 catalog 收敛(03 章自定义 scope 须注册 audience)。
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

function validateScopesAgainstCatalog(
  scopes: readonly string[],
  catalog: ReadonlySet<string>,
): DcrError | null {
  for (const scope of scopes) {
    if (!catalog.has(scope)) {
      return metaErr(`scope is not in the registered scope catalog: ${scope}`)
    }
  }
  return null
}

// application_type 只接受 RFC7591 两种值;缺省 web(最严:redirect_uri 仅 https)。
function resolveApplicationType(value: string | undefined): Result<'web' | 'native', DcrError> {
  if (value === undefined) return { ok: true, value: 'web' }
  if (value === 'web' || value === 'native') return { ok: true, value }
  return { ok: false, error: metaErr(`unsupported application_type: ${value}`) }
}

async function genCredentials(
  authMethod: string,
  jwks?: Record<string, unknown>,
): Promise<{
  clientSecret: string | null
  clientSecretHash: string | null
  rat: string
  ratHash: string
}> {
  const isPublic = authMethod === 'none'
  const isPrivateKeyJwt = authMethod === 'private_key_jwt'
  let clientSecret: string | null = null
  let clientSecretHash: string | null = null
  if (!isPublic && !isPrivateKeyJwt && jwks === undefined) {
    clientSecret = genSecret()
    clientSecretHash = await sha256Hex(clientSecret)
  }
  const rat = genRat()
  return { clientSecret, clientSecretHash, rat, ratHash: await sha256Hex(rat) }
}

function buildCustomClaimsConfig(body: RegistrationRequest): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  if (body.tls_client_auth_subject_dn)
    config.tlsClientAuthSubjectDn = body.tls_client_auth_subject_dn
  if (body.fapi_profile === true) config.fapiProfile = true
  return config
}

// scope 字符串 -> 列表;缺省给 openid/profile/email(DCR 默认最小集)。
function requestedScopesOf(body: Partial<RegistrationRequest>): string[] {
  return body.scope ? body.scope.split(' ').filter(Boolean) : ['openid', 'profile', 'email']
}

function buildInsert(opts: {
  authMethod: string
  tenantId: string
  clientId: string
  body: RegistrationRequest
  clientSecretHash: string | null
  ratHash: string
  grantTypes: string[]
  dpopBoundAccessTokens: boolean
  accessTokenTtlSec: number | null
}): AppInsert {
  const { authMethod, tenantId, clientId, body, clientSecretHash, ratHash, grantTypes } = opts
  const isPublic = authMethod === 'none'
  const isPrivateKeyJwt = authMethod === 'private_key_jwt'
  const now = new Date()
  const allowedScopes = requestedScopesOf(body)
  return {
    id: crypto.randomUUID(),
    tenantId,
    clientId,
    clientSecretHash,
    clientType: isPublic ? 'public' : 'confidential',
    tokenEndpointAuthMethod: authMethod,
    jwks: isPrivateKeyJwt && body.jwks ? body.jwks : null,
    redirectUris: body.redirect_uris ?? [],
    postLogoutRedirectUris: body.post_logout_redirect_uris ?? [],
    allowedGrantTypes: grantTypes,
    allowedResponseTypes: body.response_types ?? ['code'],
    allowedScopes,
    requirePkce: isPublic,
    dpopBoundAccessTokens: opts.dpopBoundAccessTokens,
    accessTokenFormat: 'jwt',
    // 未提供时存 NULL = 继承租户 token 策略;不能回落内置默认,否则 policy 层永远轮不到。
    accessTokenTtlSec: opts.accessTokenTtlSec,
    idTokenSignedAlg: body.id_token_signed_response_alg ?? 'ES256',
    firstParty: false,
    requireOrgContext: false,
    customClaimsConfig: buildCustomClaimsConfig(body),
    registrationAccessTokenHash: ratHash,
    backchannelLogoutUri: body.backchannel_logout_uri ?? null,
    frontchannelLogoutUri: body.frontchannel_logout_uri ?? null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }
}

type InsertValues = {
  insert: AppInsert
  clientSecret: string | null
  rat: string
  clientId: string
}

async function buildInsertValues(
  body: RegistrationRequest,
  tenantId: string,
  scopeCatalog: ReadonlySet<string>,
): Promise<Result<InsertValues, DcrError>> {
  const authMethod = body.token_endpoint_auth_method ?? 'client_secret_basic'
  if (!VALID_AUTH_METHODS.includes(authMethod as (typeof VALID_AUTH_METHODS)[number])) {
    return { ok: false, error: metaErr(`unsupported token_endpoint_auth_method: ${authMethod}`) }
  }
  if (
    (authMethod === 'tls_client_auth' || authMethod === 'self_signed_tls_client_auth') &&
    !body.tls_client_auth_subject_dn
  ) {
    return {
      ok: false,
      error: metaErr('tls_client_auth_subject_dn is required for mTLS client authentication'),
    }
  }
  const grantTypes = resolveGrantTypes(authMethod, body)
  const metadataErr =
    validateGrantTypes(grantTypes) ??
    validateResponseTypes(body.response_types ?? ['code']) ??
    validateOidcMetadata(body)
  if (metadataErr) return { ok: false, error: metadataErr }
  const applicationType = resolveApplicationType(body.application_type)
  if (!applicationType.ok) return applicationType
  // redirect_uris 注册校验:绝对 URL / https(native 放宽)/ 禁 fragment;authorization_code 必须非空。
  const redirectCheck = validateRedirectUris(body.redirect_uris ?? [], {
    applicationType: applicationType.value,
    grantTypes,
  })
  if (!redirectCheck.ok) return { ok: false, error: redirectErr(redirectCheck.error) }
  const dpopBoundAccessTokens = normalizeDpopBoundAccessTokens(body.dpop_bound_access_tokens)
  const policyErr = validatePublicRefreshPolicy({ authMethod, grantTypes, dpopBoundAccessTokens })
  if (policyErr) return { ok: false, error: policyErr }
  const ttl = normalizeAccessTokenTtlSec(body.access_token_ttl_sec)
  if (!ttl.ok) return ttl
  const scopeErr = validateScopesAgainstCatalog(requestedScopesOf(body), scopeCatalog)
  if (scopeErr) return { ok: false, error: scopeErr }
  const clientId = genClientId()
  const { clientSecret, clientSecretHash, rat, ratHash } = await genCredentials(
    authMethod,
    body.jwks,
  )
  const insert = buildInsert({
    authMethod,
    tenantId,
    clientId,
    body,
    clientSecretHash,
    ratHash,
    grantTypes,
    dpopBoundAccessTokens,
    accessTokenTtlSec: ttl.value ?? null,
  })
  return { ok: true, value: { insert, clientSecret, rat, clientId } }
}

app.post('/register', async (c) => {
  const ctx = c.get('tenant')
  const db = createTenantDb(c.env.DB, ctx)
  const raw = await readJsonBody(c)
  if (!raw.ok) {
    return oauthError(c, {
      status: 400,
      error: 'invalid_request',
      description: 'Request body must be JSON',
    })
  }
  const parsed = v.safeParse(registrationBodySchema, raw.value)
  if (!parsed.success) return oauthInvalidRequest(c, parsed.issues)
  const body = parsed.output
  const trustErr = rejectUnsupportedTrustSignals(c, body)
  if (trustErr) return dcrFail(c, trustErr)
  await enforceDcrRateLimit(c, ctx.tenantId)
  const built = await buildInsertValues(body, ctx.tenantId, await loadScopeCatalog(db))
  if (!built.ok) return dcrFail(c, built.error)
  const { insert, clientSecret, rat, clientId } = built.value
  await db.applications.insert(insert)
  const now = insert.createdAt as Date
  const respBody: Record<string, unknown> = {
    client_id: clientId,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    registration_access_token: rat,
    registration_client_uri: `${ctx.issuer}/register/${clientId}`,
    token_endpoint_auth_method: insert.tokenEndpointAuthMethod,
    grant_types: insert.allowedGrantTypes,
    response_types: insert.allowedResponseTypes,
    redirect_uris: insert.redirectUris,
    post_logout_redirect_uris: insert.postLogoutRedirectUris,
    backchannel_logout_uri: insert.backchannelLogoutUri,
    frontchannel_logout_uri: insert.frontchannelLogoutUri,
    backchannel_logout_session_required: body.backchannel_logout_session_required === true,
    dpop_bound_access_tokens: insert.dpopBoundAccessTokens,
    access_token_ttl_sec: insert.accessTokenTtlSec,
    subject_type: 'public',
    id_token_signed_response_alg: insert.idTokenSignedAlg,
    scope: (insert.allowedScopes as string[]).join(' '),
  }
  if (clientSecret !== null) {
    respBody.client_secret = clientSecret
    respBody.client_secret_expires_at = 0
  }
  return c.json(respBody, 201, { 'cache-control': 'no-store', pragma: 'no-cache' })
})

app.get('/register/:clientId', async (c) => {
  const ctx = c.get('tenant')
  const db = createTenantDb(c.env.DB, ctx)
  const row = await requireRegisteredClient(c, db, c.req.param('clientId'))
  if (row instanceof Response) return row
  return c.json(buildClientResponse(row), 200, { 'cache-control': 'no-store', pragma: 'no-cache' })
})

// 从 PATCH body 组装 patchValues。
function validatePatchPolicy(
  row: typeof schema.applications.$inferSelect,
  updates: Partial<RegistrationRequest>,
): DcrError | null {
  const dpopBoundAccessTokens =
    updates.dpop_bound_access_tokens === undefined
      ? row.dpopBoundAccessTokens
      : normalizeDpopBoundAccessTokens(updates.dpop_bound_access_tokens)
  return (
    validateGrantTypes(updates.grant_types ?? row.allowedGrantTypes) ??
    validateResponseTypes(updates.response_types ?? row.allowedResponseTypes) ??
    validatePublicRefreshPolicy({
      authMethod: row.tokenEndpointAuthMethod,
      grantTypes: updates.grant_types ?? row.allowedGrantTypes,
      dpopBoundAccessTokens,
    })
  )
}

function buildPatchValues(
  updates: Partial<RegistrationRequest>,
): Result<Partial<AppInsert>, DcrError> {
  const patchValues: Partial<AppInsert> = { updatedAt: new Date() }
  if (updates.redirect_uris !== undefined) patchValues.redirectUris = updates.redirect_uris
  if (updates.post_logout_redirect_uris !== undefined)
    patchValues.postLogoutRedirectUris = updates.post_logout_redirect_uris
  if (updates.grant_types !== undefined) {
    const err = validateGrantTypes(updates.grant_types)
    if (err) return { ok: false, error: err }
    patchValues.allowedGrantTypes = updates.grant_types
  }
  if (updates.response_types !== undefined) {
    const err = validateResponseTypes(updates.response_types)
    if (err) return { ok: false, error: err }
    patchValues.allowedResponseTypes = updates.response_types
  }
  if (updates.scope !== undefined)
    patchValues.allowedScopes = updates.scope.split(' ').filter(Boolean)
  if (updates.jwks !== undefined) patchValues.jwks = updates.jwks
  if (updates.id_token_signed_response_alg !== undefined)
    patchValues.idTokenSignedAlg = updates.id_token_signed_response_alg
  if (updates.backchannel_logout_uri !== undefined)
    patchValues.backchannelLogoutUri = updates.backchannel_logout_uri
  if (updates.frontchannel_logout_uri !== undefined)
    patchValues.frontchannelLogoutUri = updates.frontchannel_logout_uri
  if (updates.dpop_bound_access_tokens !== undefined)
    patchValues.dpopBoundAccessTokens = normalizeDpopBoundAccessTokens(
      updates.dpop_bound_access_tokens,
    )
  if (updates.access_token_ttl_sec !== undefined) {
    const ttl = normalizeAccessTokenTtlSec(updates.access_token_ttl_sec)
    if (!ttl.ok) return ttl
    patchValues.accessTokenTtlSec = ttl.value ?? null
  }
  return { ok: true, value: patchValues }
}

app.patch('/register/:clientId', async (c) => {
  const ctx = c.get('tenant')
  const db = createTenantDb(c.env.DB, ctx)
  const clientId = c.req.param('clientId')
  const row = await requireRegisteredClient(c, db, clientId)
  if (row instanceof Response) return row
  const raw = await readJsonBody(c)
  if (!raw.ok) {
    return oauthError(c, {
      status: 400,
      error: 'invalid_request',
      description: 'Request body must be JSON',
    })
  }
  const parsed = v.safeParse(registrationBodySchema, raw.value)
  if (!parsed.success) return oauthInvalidRequest(c, parsed.issues)
  const updates = parsed.output
  const metadataErr = validateOidcMetadata(updates) ?? validatePatchPolicy(row, updates)
  if (metadataErr) return dcrFail(c, metadataErr)
  const applicationType = resolveApplicationType(updates.application_type)
  if (!applicationType.ok) return dcrFail(c, applicationType.error)
  if (updates.redirect_uris !== undefined) {
    const redirectCheck = validateRedirectUris(updates.redirect_uris, {
      applicationType: applicationType.value,
      grantTypes: updates.grant_types ?? row.allowedGrantTypes,
    })
    if (!redirectCheck.ok) return dcrFail(c, redirectErr(redirectCheck.error))
  }
  if (updates.scope !== undefined) {
    const scopeErr = validateScopesAgainstCatalog(
      updates.scope.split(' ').filter(Boolean),
      await loadScopeCatalog(db),
    )
    if (scopeErr) return dcrFail(c, scopeErr)
  }
  const patched = buildPatchValues(updates)
  if (!patched.ok) return dcrFail(c, patched.error)
  const patchValues = patched.value
  if (updates.tls_client_auth_subject_dn !== undefined || updates.fapi_profile !== undefined) {
    const current = { ...(row.customClaimsConfig as Record<string, unknown>) }
    if (updates.tls_client_auth_subject_dn !== undefined) {
      current.tlsClientAuthSubjectDn = updates.tls_client_auth_subject_dn
    }
    if (updates.fapi_profile !== undefined) current.fapiProfile = updates.fapi_profile
    patchValues.customClaimsConfig = current
  }
  const updated = await db.applications.update(
    patchValues,
    and(eq(schema.applications.clientId, clientId), eq(schema.applications.status, 'active')),
  )
  return c.json(buildClientResponse(updated[0] ?? row), 200, {
    'cache-control': 'no-store',
    pragma: 'no-cache',
  })
})

app.delete('/register/:clientId', async (c) => {
  const ctx = c.get('tenant')
  const db = createTenantDb(c.env.DB, ctx)
  const clientId = c.req.param('clientId')
  const row = await requireRegisteredClient(c, db, clientId)
  if (row instanceof Response) return row
  await db.applications.update(
    { status: 'revoked', updatedAt: new Date() },
    and(eq(schema.applications.clientId, clientId), eq(schema.applications.status, 'active')),
  )
  return c.body(null, 204)
})

function buildClientResponse(
  row: typeof schema.applications.$inferSelect,
): Record<string, unknown> {
  return {
    client_id: row.clientId,
    client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
    token_endpoint_auth_method: row.tokenEndpointAuthMethod,
    grant_types: row.allowedGrantTypes,
    response_types: row.allowedResponseTypes,
    redirect_uris: row.redirectUris,
    post_logout_redirect_uris: row.postLogoutRedirectUris,
    backchannel_logout_uri: row.backchannelLogoutUri,
    frontchannel_logout_uri: row.frontchannelLogoutUri,
    backchannel_logout_session_required: false,
    dpop_bound_access_tokens: row.dpopBoundAccessTokens,
    access_token_ttl_sec: row.accessTokenTtlSec,
    subject_type: 'public',
    id_token_signed_response_alg: row.idTokenSignedAlg,
    scope: row.allowedScopes.join(' '),
  }
}

export function registerDcr(parent: Hono<XidHonoEnv>): void {
  parent.route('/', app)
}
