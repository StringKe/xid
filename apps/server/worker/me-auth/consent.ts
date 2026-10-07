// GET /auth/consent-params + POST /auth/consent(前端 consent/index.tsx;须已登录)。
// prompt_id(前端)== authz_request_id(authorize-interaction.ts stashAndRedirect 暂存到 OAUTH_STATE DO)。
// consent 只记录决定:批准时复核 client/scope 并持久化 oauthConsents,随后把决定写回暂存记录,
// 返回 /authorize 续跑地址,由 /authorize 唯一的 emitCode 签发 code 或回跳 access_denied。
// 铁律:client/redirect_uri 精确匹配在 authorize 阶段已校验;userId 从 session 取不信任 body。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import type { AuthorizationDetails } from '@xid-kit/types'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { readJsonBody, validateCredentialBody } from '../lib/validate'
import { resolveClientDisplay } from '../oidc/client-display'
import { findClient } from '../oidc/shared'
import {
  authorizationDetailsScopes,
  parseAuthorizationDetails,
} from '../oidc/authorization-details'
import { authorizeResumePath } from '../oidc/authorize-interaction'
import {
  consumeStashedAuthorizeRecord,
  peekStashedAuthorizeRecord,
  restoreStashedAuthorizeRecord,
  type StashedAuthorizeParams,
} from '../oidc/pending-params'
import { requireSession } from './shared'

async function resolvePendingAuthorizationDetails(
  c: Context<XidHonoEnv>,
  pending: StashedAuthorizeParams,
): Promise<readonly AuthorizationDetails[]> {
  const parsed = await parseAuthorizationDetails(c, pending['authorization_details'])
  if (!parsed.ok) {
    throw new AppError(parsed.error.code, {
      httpStatus: parsed.error.httpStatus,
      longMessage: parsed.error.message,
    })
  }
  return parsed.value
}

const consentParamsQuerySchema = v.object({ prompt_id: v.pipe(v.string(), v.minLength(1)) })

// GET /auth/consent-params?prompt_id= -- 返回 client 展示数据 + 请求的 scope 名(本地化由 SPA 负责)。
export async function handleConsentParams(c: Context<XidHonoEnv>): Promise<Response> {
  const tenant = c.get('tenant')
  const session = await requireSession(c)
  // prompt_id 是 OAuth state handle(凭证):缺失/形状失败与失效同 invalid_request。
  const query = v.safeParse(consentParamsQuerySchema, { prompt_id: c.req.query('prompt_id') })
  if (!query.success) throw new AppError('invalid_request')

  const record = await peekStashedAuthorizeRecord(c.env, tenant.tenantId, query.output.prompt_id)
  if (!record) throw new AppError('invalid_request', { httpStatus: 400 })
  const pending = record.params

  const client = await findClient(c, pending['client_id'] ?? '')
  if (!client) throw new AppError('invalid_client', { httpStatus: 400 })

  const [display, authorizationDetails, previouslyGrantedScopes] = await Promise.all([
    resolveClientDisplay(c.env.DB, tenant, client),
    resolvePendingAuthorizationDetails(c, pending),
    loadGrantedScopes(c, tenant, { userId: session.userId, clientId: client.clientId }),
  ])

  return c.json({
    clientId: client.clientId,
    clientName: display.clientName,
    clientLogoUrl: display.clientLogoUrl,
    ownerOrganizationName: display.ownerOrganizationName,
    redirectOrigin: redirectOriginOf(pending['redirect_uri'] ?? ''),
    scopes: (pending['scope'] ?? '')
      .split(' ')
      .filter(Boolean)
      .map((name) => ({ name })),
    previouslyGrantedScopes,
    authorizationDetails,
    firstParty: client.firstParty,
  })
}

// https 与回环 http 返回 origin;自定义 scheme(RFC 8252 原生回调)没有 origin,返回 scheme 加 host 前缀。
export function redirectOriginOf(redirectUri: string): string | null {
  if (!URL.canParse(redirectUri)) return null
  const url = new URL(redirectUri)
  if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin
  return url.host ? `${url.protocol}//${url.host}` : url.protocol
}

async function loadGrantedScopes(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  input: { userId: string; clientId: string },
): Promise<readonly string[]> {
  const db = createTenantDb(c.env.DB, tenant)
  const row = await db.oauthConsents.findOne(
    and(
      eq(schema.oauthConsents.userId, input.userId),
      eq(schema.oauthConsents.clientId, input.clientId),
    ),
  )
  return row?.grantedScopes ?? []
}

const consentBodySchema = v.object({
  promptId: v.pipe(v.string(), v.minLength(1)),
  approved: v.optional(v.boolean()),
})

// 持久化 consent(03 章 6:user_id,client_id,scope_set);已存在则并入新 scope。
// 原子 UPSERT 无法用租户查询层表达,按规则走 prepare 并显式绑定 tenant_id。
async function persistConsent(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  input: { userId: string; clientId: string; scope: string },
): Promise<void> {
  const requested = input.scope.split(' ').filter(Boolean)
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
      createPersistedId('userConsent'),
      tenant.tenantId,
      input.userId,
      input.clientId,
      JSON.stringify(requested),
      now,
      now,
    )
    .run()
}

// stash 窗口(10min)内 client 可能被禁用或收窄 allowedScopes:批准时按现状复核,
// 不复用 authorize 阶段的校验结论(TOCTOU),findClient 只查 status='active'。
async function approvedScope(
  c: Context<XidHonoEnv>,
  pending: StashedAuthorizeParams,
): Promise<{ clientId: string; scope: string }> {
  const clientId = pending['client_id'] ?? ''
  const client = await findClient(c, clientId)
  if (!client) throw new AppError('invalid_client', { httpStatus: 400 })
  const authorizationDetails = await resolvePendingAuthorizationDetails(c, pending)
  const scopes = new Set((pending['scope'] ?? '').split(' ').filter(Boolean))
  for (const item of authorizationDetailsScopes(authorizationDetails)) scopes.add(item)
  const allowedScopes = new Set(client.allowedScopes)
  if (![...scopes].every((name) => allowedScopes.has(name))) throw new AppError('invalid_scope')
  return { clientId, scope: [...scopes].join(' ') }
}

// POST /auth/consent { promptId, approved } -- 记录决定,返回 /authorize 续跑地址。
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

  const record = await consumeStashedAuthorizeRecord(c.env, tenant.tenantId, promptId)
  if (!record) throw new AppError('invalid_request', { httpStatus: 400 })
  const approved = body.approved === true
  if (approved) {
    const consent = await approvedScope(c, record.params)
    await persistConsent(c, tenant, { userId: session.userId, ...consent })
  }
  await restoreStashedAuthorizeRecord(c.env, tenant.tenantId, promptId, {
    ...record,
    consentDecision: {
      decision: approved ? 'approved' : 'denied',
      userId: session.userId,
      sessionId: session.sessionId,
    },
  })
  return c.json({ redirectUrl: authorizeResumePath(promptId, record.params['client_id']) })
}
