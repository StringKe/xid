// GET /auth/consent-params + POST /auth/consent(前端 consent/index.tsx;须已登录)。
// prompt_id(前端)== authz_request_id(authorize.ts stashAndRedirect 暂存到 OAUTH_STATE DO)。
// consent-params:读暂存 pendingParams(非破坏:consume 后立即 re-store 保 TTL)+ findClient + scope 本地化。
// consent:approved=true -> 持久化 oauthConsents(user_id,client_id,scope_set,见 03 章 6)+ emit authorization_code
//   (generateAuthorizationCode + authorizationCodes.insert + respondToRp 构造 redirectUrl);
//   approved=false -> emitRedirectError(error=access_denied)构造 redirectUrl。
// 铁律:client/redirect_uri 精确匹配在 authorize 阶段已校验;userId 从 session 取不信任 body。

import { generateAuthorizationCode } from '@xid-kit/protocol'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { AuthorizationDetails } from '@xid-kit/types'
import type { SessionData, TenantVar, XidHonoEnv } from '../lib/types'
import { readJsonBody, validateCredentialBody } from '../lib/validate'
import { findClient, loadActiveSigner } from '../oidc/shared'
import {
  isJwtResponseMode,
  resolveResponseMode,
  signAuthorizationResponseJwt,
} from '../oidc/authorize-respond'
import {
  authorizationDetailsResources,
  authorizationDetailsScopes,
  parseAuthorizationDetails,
} from '../oidc/authorization-details'
import { requireSession } from './shared'
import { OAUTH_FLOW_STATE_TTL_MS } from '../lib/ttl'

// 暂存的 /authorize 原始 query 参数(authorize.ts stashAndRedirect 存的 RawParams 平铺记录)。
type PendingParams = Record<string, string>

type ParsedPendingAuthorizationDetails = {
  details: readonly AuthorizationDetails[]
  resources: readonly string[]
  scopes: readonly string[]
}

// 标准 scope 人类可读描述;自定义 scope 无映射回退原名。
// 此处用 macro-free 英文常量,刻意不引 @xid-kit/i18n -- 否则把 lingui macro(messages/scopes)
// 拉进 route handler 导入图,node 测试池(无 lingui transform)加载即崩(见 worker/__tests__/smoke.test.ts)。
// scope 文案的多语言由 consent SPA 页面侧渲染(后续),worker 只产出标准英文回退。
const SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: 'Verify your identity',
  profile: 'Access your basic profile information',
  email: 'Access your email address',
  address: 'Access your physical address',
  phone: 'Access your phone number',
  offline_access: 'Maintain access while you are offline',
}

function describeScope(name: string): string {
  return SCOPE_DESCRIPTIONS[name] ?? name
}

function mergeScopes(scope: string, extraScopes: readonly string[]): string {
  const merged = new Set(scope.split(' ').filter(Boolean))
  for (const item of extraScopes) merged.add(item)
  return [...merged].join(' ')
}

function boundResources(
  pending: PendingParams,
  detailResources: readonly string[],
): string[] | null {
  const resources = new Set<string>()
  const requestedResource = pending['resource']
  if (requestedResource) resources.add(requestedResource)
  for (const resource of detailResources) resources.add(resource)
  return resources.size === 0 ? null : [...resources]
}

async function resolvePendingAuthorizationDetails(
  c: Context<XidHonoEnv>,
  pending: PendingParams,
): Promise<ParsedPendingAuthorizationDetails> {
  const parsed = await parseAuthorizationDetails(c, pending['authorization_details'])
  if (!parsed.ok) {
    throw new AppError(parsed.error.code, {
      httpStatus: parsed.error.httpStatus,
      longMessage: parsed.error.message,
    })
  }
  return {
    details: parsed.value,
    resources: authorizationDetailsResources(parsed.value),
    scopes: authorizationDetailsScopes(parsed.value),
  }
}

// OAuthFlowDO stub(key 与 authorize.ts stashAndRedirect 一致:authz:{tenantId}:{authzRequestId})。
function flowStub(env: Env, tenantId: string, promptId: string): DurableObjectStub {
  const ns = env.OAUTH_STATE
  return ns.get(ns.idFromName(`authz:${tenantId}:${promptId}`))
}

// 消费暂存参数(DO consume 删除)。返回 pendingParams 或 null(不存在/过期/已消费)。
async function consumePending(
  env: Env,
  tenantId: string,
  promptId: string,
): Promise<PendingParams | null> {
  const res = await flowStub(env, tenantId, promptId).fetch('https://oauth-flow-do/consume', {
    method: 'POST',
    body: JSON.stringify({ state: promptId }),
  })
  if (res.status !== 200) return null
  const body = (await res.json()) as { record?: { pendingParams?: PendingParams } }
  return body.record?.pendingParams ?? null
}

// 重新暂存(consent-params 非破坏读:consume 后 re-store,供后续 POST /auth/consent 再用)。
async function restorePending(
  env: Env,
  tenantId: string,
  promptId: string,
  params: PendingParams,
): Promise<void> {
  await flowStub(env, tenantId, promptId).fetch('https://oauth-flow-do/store', {
    method: 'POST',
    body: JSON.stringify({
      state: promptId,
      pendingParams: params,
      ttlMs: OAUTH_FLOW_STATE_TTL_MS,
    }),
  })
}

const consentParamsQuerySchema = v.object({ prompt_id: v.pipe(v.string(), v.minLength(1)) })

// GET /auth/consent-params?prompt_id= -- 返回 client 展示数据 + 本地化 scope 列表。
export async function handleConsentParams(c: Context<XidHonoEnv>): Promise<Response> {
  const tenant = c.get('tenant')
  await requireSession(c)
  // prompt_id 是 OAuth state handle(凭证):缺失/形状失败与失效同 invalid_request。
  const query = v.safeParse(consentParamsQuerySchema, { prompt_id: c.req.query('prompt_id') })
  if (!query.success) throw new AppError('invalid_request')
  const promptId = query.output.prompt_id

  const pending = await consumePending(c.env, tenant.tenantId, promptId)
  if (!pending) throw new AppError('invalid_request', { httpStatus: 400 })
  // 非破坏:立即 re-store 供 POST /auth/consent 复用。
  await restorePending(c.env, tenant.tenantId, promptId, pending)

  const clientId = pending['client_id'] ?? ''
  const client = await findClient(c, clientId)
  if (!client) throw new AppError('invalid_client', { httpStatus: 400 })

  // applications 无 name/logo 列(08 章 10.4):展示名走 project.name,logo 走 org.logoUrl,缺失回退。
  const display = await resolveClientDisplay(c, tenant, client.projectId)

  const scopes = (pending['scope'] ?? '')
    .split(' ')
    .filter(Boolean)
    .map((name) => ({ name, description: describeScope(name) }))
  const authorizationDetails = await resolvePendingAuthorizationDetails(c, pending)

  return c.json({
    clientId: client.clientId,
    clientName: display.name ?? client.clientId,
    clientLogoUrl: display.logoUrl,
    scopes,
    authorizationDetails: authorizationDetails.details,
    firstParty: client.firstParty,
  })
}

// 解析 client 展示名 + logo:application -> project(name)-> org(logoUrl)。任一缺失回退 null。
async function resolveClientDisplay(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  projectId: string | null,
): Promise<{ name: string | null; logoUrl: string | null }> {
  if (!projectId) return { name: null, logoUrl: null }
  const db = createTenantDb(c.env.DB, tenant)
  const project = await db.projects.findOne(eq(schema.projects.id, projectId))
  if (!project) return { name: null, logoUrl: null }
  const org = await db.organizations.findOne(eq(schema.organizations.id, project.orgId))
  return { name: project.name, logoUrl: org?.logoUrl ?? null }
}

const consentBodySchema = v.object({
  promptId: v.pipe(v.string(), v.minLength(1)),
  approved: v.optional(v.boolean()),
})

// 持久化 consent(03 章 6:user_id,client_id,scope_set);已存在则并入新 scope。
async function persistConsent(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  input: { userId: string; clientId: string; scope: string },
): Promise<void> {
  const { userId, clientId, scope } = input
  const requested = scope.split(' ').filter(Boolean)
  if (typeof c.env.DB.prepare !== 'function') {
    const db = createTenantDb(c.env.DB, tenant)
    const existing = await db.oauthConsents.findOne(
      and(eq(schema.oauthConsents.userId, userId), eq(schema.oauthConsents.clientId, clientId)),
    )
    if (existing) {
      await db.oauthConsents.update(
        { grantedScopes: Array.from(new Set([...existing.grantedScopes, ...requested])) },
        and(eq(schema.oauthConsents.userId, userId), eq(schema.oauthConsents.clientId, clientId)),
      )
      return
    }
    await db.oauthConsents.insert({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      userId,
      clientId,
      grantedScopes: requested,
    })
    return
  }
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO oauth_consents (id, tenant_id, user_id, client_id, granted_scopes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, user_id, client_id) DO UPDATE SET
       granted_scopes = (
         SELECT json_group_array(value) FROM (
           SELECT value FROM json_each(oauth_consents.granted_scopes)
           UNION
           SELECT value FROM json_each(excluded.granted_scopes)
         )
       ),
       updated_at = excluded.updated_at`,
  )
    .bind(
      crypto.randomUUID(),
      tenant.tenantId,
      userId,
      clientId,
      JSON.stringify(requested),
      now,
      now,
    )
    .run()
}

// 生成 authorization_code,写 D1(一次性,60s),按 response_mode 构造回跳 URL 字符串。
async function buildCodeRedirect(input: {
  c: Context<XidHonoEnv>
  tenant: TenantVar
  session: SessionData
  pending: PendingParams
  authorizationDetails: ParsedPendingAuthorizationDetails
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const generated = generateAuthorizationCode(now)
  const db = createTenantDb(input.c.env.DB, input.tenant)
  const redirectUri = input.pending['redirect_uri'] ?? ''
  const scope = mergeScopes(input.pending['scope'] ?? '', input.authorizationDetails.scopes)
  await db.authorizationCodes.insert({
    code: generated.code,
    tenantId: input.tenant.tenantId,
    clientId: input.pending['client_id'] ?? '',
    userId: input.session.userId,
    sessionId: input.session.sessionId,
    redirectUri,
    scope,
    nonce: input.pending['nonce'] ?? null,
    codeChallenge: input.pending['code_challenge'] ?? null,
    codeChallengeMethod: input.pending['code_challenge_method'] ?? null,
    dpopJkt: input.pending['dpop_jkt'] ?? null,
    authTime: new Date(now * 1000),
    acr: input.session.acr,
    amr: input.session.amr ? [...input.session.amr] : null,
    resource: boundResources(input.pending, input.authorizationDetails.resources),
    authorizationDetails:
      input.authorizationDetails.details.length > 0
        ? [...input.authorizationDetails.details]
        : null,
    consumedAt: null,
    expiresAt: new Date(generated.expiresAt * 1000),
  })
  const params: Record<string, string> = { code: generated.code, iss: input.tenant.issuer }
  if (input.pending['state'] !== undefined) params['state'] = input.pending['state']
  return redirectUrlString(input.c, redirectUri, input.pending, params)
}

// access_denied 回跳 URL(approved=false)。
async function buildDenyRedirect(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  pending: PendingParams,
): Promise<string> {
  const redirectUri = pending['redirect_uri'] ?? ''
  const params: Record<string, string> = {
    error: 'access_denied',
    error_description: 'The user denied the authorization request.',
    iss: tenant.issuer,
  }
  if (pending['state'] !== undefined) params['state'] = pending['state']
  return redirectUrlString(c, redirectUri, pending, params)
}

// 按 response_mode 构造最终回跳 URL 字符串(form_post 不适用此处:consent 回跳前端整页 navigate,用 302 URL)。
async function redirectUrlString(
  c: Context<XidHonoEnv>,
  redirectUri: string,
  pending: PendingParams,
  params: Record<string, string>,
): Promise<string> {
  const mode = resolveResponseMode(pending['response_mode'], pending['response_type'] ?? '')
  const finalParams = isJwtResponseMode(mode)
    ? {
        response: await signAuthorizationResponseJwt({
          ctx: c.get('tenant'),
          signer: await loadActiveSigner(c.get('tenant'), c.env.KEK),
          clientId: pending['client_id'] ?? '',
          params,
          now: Math.floor(Date.now() / 1000),
        }),
      }
    : params
  const url = new URL(redirectUri)
  const search = new URLSearchParams(finalParams).toString()
  if (mode === 'fragment') {
    url.hash = search
  } else {
    url.search = url.search ? `${url.search.slice(1)}&${search}` : search
  }
  return url.toString()
}

// POST /auth/consent { promptId, approved } -- 持久化授权 + 续签 code 或 access_denied 回跳。
export async function handleConsent(c: Context<XidHonoEnv>): Promise<Response> {
  const tenant = c.get('tenant')
  const session = await requireSession(c)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('invalid_request')
  // promptId 是 OAuth state handle(凭证):形状失败与失效同 invalid_request;approved 非凭证走 422。
  const body = validateCredentialBody(consentBodySchema, json.value, {
    code: 'invalid_request',
    credentialFields: ['promptId'],
  })
  const promptId = body.promptId

  const pending = await consumePending(c.env, tenant.tenantId, promptId)
  if (!pending) throw new AppError('invalid_request', { httpStatus: 400 })

  if (body.approved !== true) {
    return c.json({ redirectUrl: await buildDenyRedirect(c, tenant, pending) })
  }

  const clientId = pending['client_id'] ?? ''
  // stash 窗口(10min)内 client 可能被禁用或收窄 allowedScopes:批准时按现状复核,
  // 不复用 authorize 阶段的校验结论(TOCTOU),findClient 只查 status='active'。
  const client = await findClient(c, clientId)
  if (!client) throw new AppError('invalid_client', { httpStatus: 400 })
  const authorizationDetails = await resolvePendingAuthorizationDetails(c, pending)
  const scope = mergeScopes(pending['scope'] ?? '', authorizationDetails.scopes)
  const allowedScopes = new Set(client.allowedScopes)
  const scopeStillAllowed = scope
    .split(' ')
    .filter(Boolean)
    .every((name) => allowedScopes.has(name))
  if (!scopeStillAllowed) throw new AppError('invalid_scope')

  await persistConsent(c, tenant, {
    userId: session.userId,
    clientId,
    scope,
  })
  const redirectUrl = await buildCodeRedirect({
    c,
    tenant,
    session,
    pending,
    authorizationDetails,
  })
  return c.json({ redirectUrl })
}
