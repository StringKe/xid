// /token 共享签发逻辑(03 章 9):TokenContext 装配 + access/id_token 签发 + refresh 持久化 + 响应体。
// grant 实现(token-grants/token-exchange)复用本层。铁律:签名密钥从 TenantContext active 取。

import {
  buildAccessTokenClaims,
  buildIdTokenClaims,
  issueRefreshFamily,
  leftHalfHash,
  signAccessTokenClaims,
  signClaims,
} from '@xid-kit/protocol'
import type { AccessTokenOptions, RefreshTokenRecord } from '@xid-kit/protocol'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import type { ActClaim, AmrValue, AuthorizationDetails, Result, XidError } from '@xid-kit/types'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { buildRbacClaims } from '../rbac'
import type { GrantContext } from '../rbac'
import { refreshTtlSecOf, resolveAccessTtlSec } from './shared'
import type { ActiveSigner, ClientRow } from './shared'

// grant 间共享的 token 上下文(prelude 在 token.ts 装配后传入)。
export type TokenContext = {
  c: Context<XidHonoEnv>
  signer: ActiveSigner
  client: ClientRow
  clientId: string
  dpopJkt: string | null
  mtlsCertThumbprint: string | null
  form: Record<string, string>
  now: number
}

export type TokenAuthContext = {
  acr?: string | null
  amr?: readonly AmrValue[] | null
  authTime?: number | null
}

export type IssuedAccessToken = {
  token: string
  jti: string
  expiresAt: number
  clientId: string
  subject: string
}

export function fail(
  code: XidError['code'],
  message: string,
  httpStatus = 400,
): Result<never, XidError> {
  return { ok: false, error: { code, message, httpStatus } }
}

export function tokenType(jkt: string | null): 'Bearer' | 'DPoP' {
  return jkt ? 'DPoP' : 'Bearer'
}

export function accessTtl(tc: TokenContext): number {
  return resolveAccessTtlSec(tc.c.get('tenant'), tc.client.accessTokenTtlSec)
}

export async function assertActiveTokenUser(
  tc: TokenContext,
  userId: string,
): Promise<Result<true, XidError>> {
  const db = createTenantDb(tc.c.env.DB, tc.c.get('tenant'))
  const user = await db.users.findOne(
    and(
      eq(schema.users.id, userId),
      eq(schema.users.status, 'active'),
      isNull(schema.users.deletedAt),
    ),
  )
  if (!user) return fail('invalid_grant', 'user revoked or not found')
  return { ok: true, value: true }
}

// audience(RFC8707 resource)白名单校验:resource 必须是已注册 ResourceServer.audience。
// 未带 resource -> null(调用方用 aud=client_id);带但未注册 -> invalid_target。
// 返回 Result:ok.value 为校验后的 audience(string)或 null。
export async function resolveResource(
  tc: TokenContext,
  resource: string | null,
): Promise<Result<string | null, XidError>> {
  if (resource === null || resource === '') return { ok: true, value: null }
  const ctx = tc.c.get('tenant')
  const db = createTenantDb(tc.c.env.DB, ctx)
  const row = await db.resourceServers.findOne(eq(schema.resourceServers.audience, resource))
  if (!row) return fail('invalid_target', 'resource is not a registered audience')
  return { ok: true, value: resource }
}

// access token claims options:DPoP cnf.jkt + sid(若有)+ RBAC/hook extra claims(若有)。
export function accessOptions(input: {
  tc: TokenContext
  sid?: string
  authContext?: TokenAuthContext
  extraClaims?: Record<string, unknown>
  authorizationDetails?: readonly AuthorizationDetails[] | null
}): AccessTokenOptions {
  const opts: AccessTokenOptions = {}
  if (input.tc.dpopJkt) opts.cnf = { jkt: input.tc.dpopJkt }
  else if (input.tc.mtlsCertThumbprint) opts.cnf = { 'x5t#S256': input.tc.mtlsCertThumbprint }
  if (input.sid) opts.sid = input.sid
  if (input.authContext) {
    opts.authContext = {
      ...(input.authContext.acr ? { acr: input.authContext.acr } : {}),
      ...(input.authContext.amr ? { amr: input.authContext.amr } : {}),
      ...(input.authContext.authTime !== null && input.authContext.authTime !== undefined
        ? { authTime: input.authContext.authTime }
        : {}),
    }
  }
  if (input.extraClaims && Object.keys(input.extraClaims).length > 0) {
    opts.extraClaims = input.extraClaims
  }
  if (input.authorizationDetails && input.authorizationDetails.length > 0) {
    opts.authorizationDetails = input.authorizationDetails
  }
  return opts
}

// 签发 access token JWT(claims -> signAccessTokenClaims)。RBAC 注入走 issueUserAccessToken(有用户上下文时)。
export async function issueAccessToken(
  tc: TokenContext,
  input: {
    userId: string
    scope: string
    audience: string | readonly string[]
    sid?: string
    authContext?: TokenAuthContext
    extraClaims?: Record<string, unknown>
    authorizationDetails?: readonly AuthorizationDetails[] | null
  },
): Promise<string> {
  const issued = await issueAccessTokenWithMetadata(tc, input)
  return issued.token
}

async function issueAccessTokenWithMetadata(
  tc: TokenContext,
  input: {
    userId: string
    scope: string
    audience: string | readonly string[]
    sid?: string
    authContext?: TokenAuthContext
    extraClaims?: Record<string, unknown>
    authorizationDetails?: readonly AuthorizationDetails[] | null
  },
): Promise<IssuedAccessToken> {
  const ctx = tc.c.get('tenant')
  const claims = buildAccessTokenClaims({
    ctx,
    subject: { userId: input.userId },
    clientId: tc.clientId,
    scope: input.scope,
    audience: input.audience,
    now: tc.now,
    ttlSec: accessTtl(tc),
    options: accessOptions({
      tc,
      sid: input.sid,
      authContext: input.authContext,
      extraClaims: input.extraClaims,
      authorizationDetails: input.authorizationDetails,
    }),
  })
  const token = await signAccessTokenClaims(ctx, tc.signer.privateKey, claims)
  return {
    token,
    jti: claims.jti,
    expiresAt: claims.exp,
    clientId: tc.clientId,
    subject: input.userId,
  }
}

// RBAC claims 注入上下文(02 章 7.2/7.4):有真实用户时由 grant handler 传入,装配 permissions/org/grant claim。
export type RbacInjectInput = {
  userId: string
  activeOrg?: { id: string; slug: string } | null
  grant?: GrantContext | null
}

export type TokenGrantContext = {
  activeOrg: { id: string; slug: string } | null
  grant: GrantContext | null
}

export async function resolveTokenGrantContext(
  tc: TokenContext,
  input: {
    userId: string
    activeOrgId: string | null
    projectGrantId: string | null
  },
): Promise<Result<TokenGrantContext, XidError>> {
  const db = createTenantDb(tc.c.env.DB, tc.c.get('tenant'))
  const activeOrg = input.activeOrgId
    ? await db.organizations.findOne(
        and(
          eq(schema.organizations.id, input.activeOrgId),
          eq(schema.organizations.status, 'active'),
        ),
      )
    : undefined
  if (input.activeOrgId && !activeOrg) {
    return fail('access_denied', 'active organization revoked or not found', 403)
  }
  if (activeOrg) {
    const membership = await db.memberships.findOne(
      and(
        eq(schema.memberships.userId, input.userId),
        eq(schema.memberships.orgId, activeOrg.id),
        eq(schema.memberships.status, 'active'),
      ),
    )
    if (!membership) return fail('access_denied', 'active organization revoked or not found', 403)
  }

  const grant = input.projectGrantId
    ? await db.projectGrants.findOne(
        and(
          eq(schema.projectGrants.id, input.projectGrantId),
          eq(schema.projectGrants.status, 'active'),
        ),
      )
    : undefined
  if (input.projectGrantId && !grant) {
    return fail('access_denied', 'project grant revoked or not found', 403)
  }
  if (grant && grant.grantedToOrgId !== input.activeOrgId) {
    return fail('access_denied', 'project grant revoked or not found', 403)
  }
  if (grant && tc.client.projectId !== grant.grantedProjectId) {
    return fail('unauthorized_client', 'project grant does not authorize this client')
  }
  if (grant) {
    const userGrant = await db.userGrants.findOne(
      and(
        eq(schema.userGrants.userId, input.userId),
        eq(schema.userGrants.projectId, grant.grantedProjectId),
        eq(schema.userGrants.grantedViaGrantId, grant.id),
        isNull(schema.userGrants.revokedAt),
      ),
    )
    if (!userGrant) return fail('access_denied', 'user not authorized via grant', 403)
  }

  return {
    ok: true,
    value: {
      activeOrg: activeOrg ? { id: activeOrg.id, slug: activeOrg.slug } : null,
      grant: grant
        ? {
            grantId: grant.id,
            grantedProjectId: grant.grantedProjectId,
            grantedByOrgId: grant.grantedByOrgId,
            grantedToOrgId: grant.grantedToOrgId,
          }
        : null,
    },
  }
}

// 签发带 RBAC claims 的 access token(02 章 7):实时解析 permission + ABAC 过滤 + PreAccessTokenHook,
// 注入 permissions/org_id/org_slug/project_id/granted_org_id。forbidden claim key -> Result error(签发失败)。
export async function issueUserAccessToken(
  tc: TokenContext,
  input: {
    userId: string
    scope: string
    audience: string | readonly string[]
    sid?: string
    authContext?: TokenAuthContext
    authorizationDetails?: readonly AuthorizationDetails[] | null
  },
  rbac: RbacInjectInput,
): Promise<Result<string, XidError>> {
  const issued = await issueUserAccessTokenWithMetadata(tc, input, rbac)
  if (!issued.ok) return issued
  return { ok: true, value: issued.value.token }
}

export async function issueUserAccessTokenWithMetadata(
  tc: TokenContext,
  input: {
    userId: string
    scope: string
    audience: string | readonly string[]
    sid?: string
    authContext?: TokenAuthContext
    authorizationDetails?: readonly AuthorizationDetails[] | null
  },
  rbac: RbacInjectInput,
): Promise<Result<IssuedAccessToken, XidError>> {
  const activeUser = await assertActiveTokenUser(tc, input.userId)
  if (!activeUser.ok) return activeUser
  const ctx = tc.c.get('tenant')
  const claimsResult = await buildRbacClaims({
    d1: tc.c.env.DB,
    ctx,
    env: tc.c.env,
    input: {
      userId: rbac.userId,
      projectId: tc.client.projectId ?? null,
      clientId: tc.clientId,
      isFirstParty: tc.client.firstParty,
      activeOrg: rbac.activeOrg ?? null,
      grant: rbac.grant ?? null,
    },
  })
  if (!claimsResult.ok) return claimsResult
  const issued = await issueAccessTokenWithMetadata(tc, {
    ...input,
    extraClaims: claimsResult.value,
  })
  return { ok: true, value: issued }
}

// 每个可被 replay 连锁撤销的 access JWT 均记录 jti,不保存 token 明文。
// 通过 grant 的 replay 标志作为写入条件,使先检测到 replay 的并发请求无法返回新 JWT。
export async function persistAccessTokenIssuance(
  tc: TokenContext,
  issued: IssuedAccessToken,
  link: { authorizationCode?: string; refreshFamilyId?: string },
): Promise<boolean> {
  const ctx = tc.c.get('tenant')
  const now = tc.now * 1000
  const grantCondition = link.authorizationCode
    ? `EXISTS (
         SELECT 1 FROM authorization_codes
         WHERE code = ? AND tenant_id = ? AND replay_detected_at IS NULL
       )`
    : `NOT EXISTS (
         SELECT 1 FROM refresh_tokens
         WHERE tenant_id = ? AND family_id = ? AND family_revoked_at IS NOT NULL
       )`
  const bindings = link.authorizationCode
    ? [link.authorizationCode, ctx.tenantId]
    : [ctx.tenantId, link.refreshFamilyId]
  const result = await tc.c.env.DB.prepare(
    `INSERT INTO access_token_issuances (
       id, tenant_id, jti, client_id, subject, authorization_code, refresh_family_id, expires_at, created_at
     ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${grantCondition}`,
  )
    .bind(
      crypto.randomUUID(),
      ctx.tenantId,
      issued.jti,
      issued.clientId,
      issued.subject,
      link.authorizationCode ?? null,
      link.refreshFamilyId ?? null,
      issued.expiresAt * 1000,
      now,
      ...bindings,
    )
    .run()
  return result.meta.changes === undefined || result.meta.changes === 1
}

// 签发 id_token(scope 含 openid 时;含 at_hash)。sid 仅 session 链路传入(authorization_code/refresh grant)。
export async function issueIdToken(
  tc: TokenContext,
  input: {
    userId: string
    scope: string
    nonce: string | null
    authTime: number | null
    acr?: string | null
    amr?: readonly AmrValue[] | null
    sid?: string | null
    accessToken: string
    act?: ActClaim
    ttlSec?: number
  },
): Promise<string> {
  const ctx = tc.c.get('tenant')
  const atHash = await leftHalfHash(input.accessToken)
  const claims = buildIdTokenClaims({
    ctx,
    subject: { userId: input.userId },
    clientId: tc.clientId,
    authContext: {
      ...(input.nonce !== null ? { nonce: input.nonce } : {}),
      ...(input.authTime !== null ? { authTime: input.authTime } : {}),
      ...(input.acr ? { acr: input.acr } : {}),
      ...(input.amr ? { amr: input.amr } : {}),
      ...(input.sid ? { sid: input.sid } : {}),
    },
    scope: input.scope,
    now: tc.now,
    ttlSec: input.ttlSec ?? accessTtl(tc),
    atHash,
    ...(input.act ? { act: input.act } : {}),
  })
  return signClaims(ctx, tc.signer.privateKey, claims)
}

// 写 refresh token 记录到 D1(明文不入库,只存 token_hash)。
export async function persistRefresh(tc: TokenContext, rec: RefreshTokenRecord): Promise<void> {
  const ctx = tc.c.get('tenant')
  const db = createTenantDb(tc.c.env.DB, ctx)
  await db.refreshTokens.insert({
    id: rec.id,
    tenantId: ctx.tenantId,
    tokenHash: rec.tokenHash,
    familyId: rec.familyId,
    parentTokenId: rec.parentTokenId,
    userId: rec.userId,
    sessionId: rec.sessionId,
    clientId: rec.clientId,
    scope: rec.scope,
    jkt: rec.jkt,
    activeOrgId: rec.activeOrgId,
    projectGrantId: rec.projectGrantId,
    resource: rec.resource ? [...rec.resource] : null,
    authorizationDetails: rec.authorizationDetails ? [...rec.authorizationDetails] : null,
    authTime: rec.authTime,
    acr: rec.acr,
    amr: rec.amr ? [...rec.amr] : null,
    revokedAt: rec.revokedAt === null ? null : new Date(rec.revokedAt),
    expiresAt: new Date(rec.expiresAt * 1000),
    absoluteExpiresAt: new Date(rec.absoluteExpiresAt * 1000),
  })
}

// 授权码重放标记与 refresh 写入在同一 SQL 条件中判定，避免重放请求落在首次写入之前。
export async function persistAuthorizationCodeRefresh(
  tc: TokenContext,
  rec: RefreshTokenRecord,
  authorizationCode: string,
): Promise<boolean> {
  const ctx = tc.c.get('tenant')
  const result = await tc.c.env.DB.prepare(
    `INSERT INTO refresh_tokens (
       id, tenant_id, token_hash, family_id, parent_token_id, authorization_code,
       user_id, session_id, client_id, scope, jkt, active_org_id, project_grant_id, resource,
       authorization_details, auth_time, acr, amr, revoked_at, expires_at,
       absolute_expires_at, created_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM authorization_codes
       WHERE code = ? AND tenant_id = ? AND replay_detected_at IS NULL
     )`,
  )
    .bind(
      rec.id,
      ctx.tenantId,
      rec.tokenHash,
      rec.familyId,
      rec.parentTokenId,
      authorizationCode,
      rec.userId,
      rec.sessionId,
      rec.clientId,
      rec.scope,
      rec.jkt,
      rec.activeOrgId,
      rec.projectGrantId,
      rec.resource === null ? null : JSON.stringify(rec.resource),
      rec.authorizationDetails === null ? null : JSON.stringify(rec.authorizationDetails),
      rec.authTime,
      rec.acr,
      rec.amr === null ? null : JSON.stringify(rec.amr),
      rec.revokedAt === null ? null : rec.revokedAt * 1000,
      rec.expiresAt * 1000,
      rec.absoluteExpiresAt * 1000,
      rec.createdAt * 1000,
      authorizationCode,
      ctx.tenantId,
    )
    .run()
  return result.meta.changes === undefined || result.meta.changes === 1
}

// 首发 refresh token(scope 含 offline_access 且 client 允许 refresh_token):写 D1 新 family。
export async function issueRefreshIfAllowed(
  tc: TokenContext,
  input: {
    userId: string
    scope: string
    grantContext?: TokenGrantContext | null
    sessionId?: string | null
    resource?: readonly string[] | null
    authorizationDetails?: readonly AuthorizationDetails[] | null
    authContext?: TokenAuthContext | null
    authorizationCode?: string | null
  },
): Promise<string | null> {
  if (!input.scope.split(' ').includes('offline_access')) return null
  if (!tc.client.allowedGrantTypes.includes('refresh_token')) return null
  if (tc.client.clientType === 'public' && tc.dpopJkt === null) return null
  const ctx = tc.c.get('tenant')
  const refreshTtl = refreshTtlSecOf(ctx)
  const issued = await issueRefreshFamily({
    tenantId: ctx.tenantId,
    userId: input.userId,
    clientId: tc.clientId,
    scope: input.scope,
    jkt: tc.dpopJkt,
    sessionId: input.sessionId ?? null,
    activeOrgId: input.grantContext?.activeOrg?.id ?? null,
    projectGrantId: input.grantContext?.grant?.grantId ?? null,
    resource: input.resource ?? null,
    authorizationDetails: input.authorizationDetails ?? null,
    authTime: input.authContext?.authTime ?? null,
    acr: input.authContext?.acr ?? null,
    amr: input.authContext?.amr ?? null,
    now: tc.now,
    idleTtlSec: refreshTtl.idleTtlSec,
    absoluteTtlSec: refreshTtl.absoluteTtlSec,
    newId: crypto.randomUUID(),
    familyId: crypto.randomUUID(),
  })
  if (input.authorizationCode !== null && input.authorizationCode !== undefined) {
    const persisted = await persistAuthorizationCodeRefresh(
      tc,
      issued.record,
      input.authorizationCode,
    )
    return persisted ? issued.token : null
  }
  await persistRefresh(tc, issued.record)
  return issued.token
}

// 组装成功响应体(条件字段:scope/refresh_token/id_token)。
export function tokenResponseBody(input: {
  accessToken: string
  jkt: string | null
  ttlSec: number
  scope: string
  refreshToken?: string | null
  idToken?: string | null
  authorizationDetails?: readonly AuthorizationDetails[] | null
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    access_token: input.accessToken,
    token_type: tokenType(input.jkt),
    expires_in: input.ttlSec,
    scope: input.scope,
  }
  if (input.refreshToken) body['refresh_token'] = input.refreshToken
  if (input.idToken) body['id_token'] = input.idToken
  if (input.authorizationDetails && input.authorizationDetails.length > 0) {
    body['authorization_details'] = input.authorizationDetails
  }
  return body
}
