// /token grant 实现 A 组(03 章 9.1-9.3):authorization_code(+PKCE)/ client_credentials /
// refresh_token(轮换 + family 重放撤销)。装配与签发复用 token-issue。device_code/token-exchange 见 token-exchange.ts。
// 铁律:code 一次性消费;PKCE S256;refresh family 重放连锁吊销;tenant 从 c.get('tenant')。

import {
  decisionToResult,
  detectReplay,
  enforcePkceBinding,
  hashRefreshToken,
  narrowScope,
  rotateRefresh,
  verifyPkce,
} from '@xid-kit/protocol'
import type { PkceMethod, RefreshTokenRecord } from '@xid-kit/protocol'
import { createTenantDb, schema } from '@xid-kit/db'
import type { AuthorizationDetails, Result, XidError } from '@xid-kit/types'
import { and, eq, isNull } from 'drizzle-orm'
import {
  accessTtl,
  fail,
  issueAccessToken,
  issueIdToken,
  issueRefreshIfAllowed,
  issueUserAccessTokenWithMetadata,
  assertActiveTokenUser,
  persistAccessTokenIssuance,
  resolveResource,
  resolveTokenGrantContext,
  tokenResponseBody,
} from './token-issue'
import type { TokenContext } from './token-issue'
import { refreshTtlSecOf } from './shared'

type GrantResult = Result<Record<string, unknown>, XidError>
type CodeRow = typeof schema.authorizationCodes.$inferSelect
type RefreshRow = typeof schema.refreshTokens.$inferSelect

// ---- grant=authorization_code(9.1) ----
export async function grantAuthorizationCode(tc: TokenContext): Promise<GrantResult> {
  const code = tc.form['code']
  if (!code) return fail('invalid_request', 'code is required')
  const ctx = tc.c.get('tenant')
  const db = createTenantDb(tc.c.env.DB, ctx)

  const candidate = await db.authorizationCodes.findOne(eq(schema.authorizationCodes.code, code))
  if (!candidate) return fail('invalid_grant', 'authorization code already used or unknown')

  const checked = checkCodeBindings(tc, candidate)
  if (!checked.ok) return checked
  const pkceErr = await checkPkce(tc, candidate)
  if (pkceErr) return pkceErr

  // 绑定验证通过后才条件消费。CAS 失败表示已被有效交换，必须建立重放撤销栅栏。
  const consumed = await db.authorizationCodes.update(
    { consumedAt: new Date(tc.now * 1000) },
    and(eq(schema.authorizationCodes.code, code), isNull(schema.authorizationCodes.consumedAt)),
  )
  const rec = consumed[0]
  if (!rec) {
    await revokeFamiliesForCode(tc, code)
    return fail('invalid_grant', 'authorization code already used or unknown')
  }

  return issueForCode(tc, rec)
}

// 9.1 第 8 步:签发 access(含 RBAC claims)(+id_token if openid)(+refresh if offline_access)。
async function issueForCode(tc: TokenContext, rec: CodeRow): Promise<GrantResult> {
  const grantContext = await resolveTokenGrantContext(tc, {
    userId: rec.userId,
    activeOrgId: rec.activeOrgId ?? null,
    projectGrantId: rec.projectGrantId ?? null,
  })
  if (!grantContext.ok) return grantContext
  const audience = await resolveCodeAudience(tc, rec)
  if (!audience.ok) return audience
  const issued = await issueUserAccessTokenWithMetadata(
    tc,
    {
      userId: rec.userId,
      scope: rec.scope,
      audience: audience.value,
      authContext: {
        acr: rec.acr,
        amr: rec.amr,
        authTime: Math.floor(rec.authTime.getTime() / 1000),
      },
      authorizationDetails: rec.authorizationDetails ?? null,
    },
    {
      userId: rec.userId,
      activeOrg: grantContext.value.activeOrg,
      grant: grantContext.value.grant,
    },
  )
  if (!issued.ok) return issued
  const accessToken = issued.value.token
  const tracked = await persistAccessTokenIssuance(tc, issued.value, {
    authorizationCode: rec.code,
  })
  if (!tracked) return fail('invalid_grant', 'authorization code replay detected')
  const scopes = rec.scope.split(' ')
  const idToken = scopes.includes('openid')
    ? await issueIdToken(tc, {
        userId: rec.userId,
        scope: rec.scope,
        nonce: rec.nonce,
        authTime: Math.floor(rec.authTime.getTime() / 1000),
        acr: rec.acr,
        amr: rec.amr,
        sid: rec.sessionId ?? null,
        accessToken,
      })
    : null
  const authContext = {
    acr: rec.acr,
    amr: rec.amr,
    authTime: Math.floor(rec.authTime.getTime() / 1000),
  }
  const refreshToken = await issueRefreshIfAllowed(tc, {
    userId: rec.userId,
    scope: rec.scope,
    grantContext: grantContext.value,
    sessionId: rec.sessionId ?? null,
    resource: rec.resource,
    authorizationDetails: rec.authorizationDetails ?? null,
    authContext,
    authorizationCode: rec.code,
  })
  return {
    ok: true,
    value: tokenResponseBody({
      accessToken,
      jkt: tc.dpopJkt,
      ttlSec: accessTtl(tc),
      scope: rec.scope,
      refreshToken,
      idToken,
      authorizationDetails: rec.authorizationDetails ?? null,
    }),
  }
}

async function resolveCodeAudience(
  tc: TokenContext,
  rec: CodeRow,
): Promise<Result<string | readonly string[], XidError>> {
  const resources = rec.resource ?? null
  if (!resources || resources.length === 0) return { ok: true, value: tc.clientId }

  const requested = tc.form['resource'] ?? null
  if (requested !== null) {
    if (!resources.includes(requested)) {
      return fail('invalid_target', 'resource is not bound to this authorization code')
    }
    const checked = await resolveResource(tc, requested)
    if (!checked.ok) return checked
    return { ok: true, value: checked.value ?? tc.clientId }
  }

  for (const resource of resources) {
    const checked = await resolveResource(tc, resource)
    if (!checked.ok) return checked
  }
  return { ok: true, value: resources.length === 1 ? resources[0]! : resources }
}

// 9.1 第 3-5 步:过期 / client 绑定 / redirect_uri 精确匹配。
function checkCodeBindings(tc: TokenContext, rec: CodeRow): Result<true, XidError> {
  if (tc.now > Math.floor(rec.expiresAt.getTime() / 1000)) {
    return fail('invalid_grant', 'authorization code expired')
  }
  if (rec.clientId !== tc.clientId) return fail('invalid_grant', 'code not bound to this client')
  if (rec.redirectUri !== null && tc.form['redirect_uri'] !== rec.redirectUri) {
    return fail('invalid_grant', 'redirect_uri mismatch')
  }
  if (rec.dpopJkt !== null && tc.dpopJkt !== rec.dpopJkt) {
    return fail('invalid_grant', 'authorization code DPoP binding mismatch')
  }
  return { ok: true, value: true }
}

// 9.1 第 6 步:PKCE downgrade 绑定 + S256 校验。
async function checkPkce(tc: TokenContext, rec: CodeRow): Promise<Result<never, XidError> | null> {
  const verifier = tc.form['code_verifier'] ?? null
  const binding = enforcePkceBinding({
    requirePkce: tc.client.requirePkce,
    registeredChallenge: rec.codeChallenge,
    presentedVerifier: verifier,
  })
  if (!binding.ok) return { ok: false, error: binding.error }
  if (rec.codeChallenge !== null) {
    if (verifier === null) return fail('invalid_grant', 'code_verifier required')
    const method = (rec.codeChallengeMethod ?? 'S256') as PkceMethod
    const result = await verifyPkce(verifier, rec.codeChallenge, method)
    if (!result.ok) return { ok: false, error: result.error }
  }
  return null
}

// code 重复使用:只撤销该 code 首发的 family,并为并发 successor 写入 family 栅栏。
export async function revokeFamiliesForCode(tc: TokenContext, code: string): Promise<void> {
  const ctx = tc.c.get('tenant')
  const now = tc.now * 1000
  // replay 标记,refresh family 栅栏和 denylist 同一 D1 batch 原子提交。
  // 因此签发请求只能在 batch 前留下可撤销记录,或在 batch 后被 issuance 条件拒绝。
  await tc.c.env.DB.batch([
    tc.c.env.DB.prepare(
      `UPDATE authorization_codes
         SET replay_detected_at = ?
         WHERE code = ? AND tenant_id = ? AND consumed_at IS NOT NULL`,
    ).bind(now, code, ctx.tenantId),
    accessRevocationStatement(tc, { column: 'authorization_code', identifier: code, now }),
    tc.c.env.DB.prepare(
      `UPDATE refresh_tokens
         SET revoked_at = ?, family_revoked_at = ?
         WHERE tenant_id = ?
           AND family_id IN (
             SELECT family_id FROM refresh_tokens
             WHERE tenant_id = ? AND authorization_code = ?
           )
           AND family_revoked_at IS NULL`,
    ).bind(now, now, ctx.tenantId, ctx.tenantId, code),
    accessRevocationStatement(tc, {
      column: 'refresh_family_id',
      identifier: code,
      now,
      familyFromCode: true,
    }),
  ])
}

// ---- grant=client_credentials(9.2) ----
export async function grantClientCredentials(tc: TokenContext): Promise<GrantResult> {
  if (tc.client.clientType === 'public') {
    return fail('invalid_client', 'client_credentials requires confidential client', 401)
  }
  const requested = tc.form['scope'] ?? ''
  const allowed = new Set(tc.client.allowedScopes)
  const scopes = requested ? requested.split(' ').filter(Boolean) : tc.client.allowedScopes.slice()
  for (const s of scopes) {
    if (!allowed.has(s)) return fail('invalid_scope', `scope "${s}" not allowed`)
  }
  const scope = scopes.join(' ')
  // resource(RFC8707)白名单:带 resource 时必须是已注册 audience,否则 invalid_target。
  const resource = await resolveResource(tc, tc.form['resource'] ?? null)
  if (!resource.ok) return resource
  const accessToken = await issueAccessToken(tc, {
    userId: tc.clientId,
    scope,
    audience: resource.value ?? tc.clientId,
  })
  return {
    ok: true,
    value: tokenResponseBody({ accessToken, jkt: tc.dpopJkt, ttlSec: accessTtl(tc), scope }),
  }
}

// ---- grant=refresh_token(9.3,轮换 + family)----
export async function grantRefreshToken(tc: TokenContext): Promise<GrantResult> {
  const presented = tc.form['refresh_token']
  if (!presented) return fail('invalid_request', 'refresh_token is required')
  const ctx = tc.c.get('tenant')
  const db = createTenantDb(tc.c.env.DB, ctx)
  const hash = await hashRefreshToken(presented)
  const row = await db.refreshTokens.findOne(eq(schema.refreshTokens.tokenHash, hash))
  if (!row) return fail('invalid_grant', 'refresh token unknown')

  const record = toRefreshRecord(row)
  if (tc.client.clientType === 'public' && record.jkt === null) {
    return fail('invalid_grant', 'public client refresh token must be DPoP-bound')
  }
  const decision = detectReplay({
    record,
    clientId: tc.clientId,
    now: tc.now,
    presentedJkt: tc.dpopJkt,
  })
  if (decision.kind === 'replay') await revokeFamily(tc, decision.familyId)
  const judged = decisionToResult(decision)
  if (!judged.ok) {
    if (decision.kind === 'expired') {
      await db.refreshTokens.update(
        { revokedAt: new Date(tc.now * 1000) },
        eq(schema.refreshTokens.id, record.id),
      )
    }
    return judged
  }

  const narrowed = narrowScope(record.scope, tc.form['scope'] ?? null)
  if (!narrowed.ok) return narrowed
  return rotateAndIssue(tc, record, hash, narrowed.value)
}

// 原子标记旧 token 撤销:条件 UPDATE(token_hash=? AND revoked_at IS NULL),受影响行数。
// D1 串行化写入,WHERE revoked_at IS NULL 保证并发双花只有一个胜出。
async function atomicRevokeOld(tc: TokenContext, hash: string, revokedAt: number): Promise<number> {
  const ctx = tc.c.get('tenant')
  const db = createTenantDb(tc.c.env.DB, ctx)
  const affected = await db.refreshTokens.update(
    { revokedAt: new Date(revokedAt * 1000) },
    and(eq(schema.refreshTokens.tokenHash, hash), isNull(schema.refreshTokens.revokedAt)),
  )
  return affected.length
}

// 轮换签发:原子标旧 revoked(WHERE revoked_at IS NULL),0 行=并发双花->吊销 family;
// 否则插新 token,签发新 access(+ id_token 若 openid)。
async function rotateAndIssue(
  tc: TokenContext,
  old: RefreshTokenRecord,
  oldHash: string,
  scope: string,
): Promise<GrantResult> {
  const activeUser = await assertActiveTokenUser(tc, old.userId)
  if (!activeUser.ok) return activeUser
  const { issued, revokedOld } = await rotateRefresh({
    old,
    scope,
    now: tc.now,
    idleTtlSec: refreshTtlSecOf(tc.c.get('tenant')).idleTtlSec,
    newId: crypto.randomUUID(),
  })
  // 原子 CAS:只有 revoked_at IS NULL 的旧 token 被本次撤销;0 行=已被并发请求轮换=双花。
  const affected = await atomicRevokeOld(tc, oldHash, revokedOld.revokedAt ?? tc.now)
  if (affected === 0) {
    await revokeFamily(tc, old.familyId)
    return fail('invalid_grant', 'refresh token replay detected; family revoked')
  }
  const persisted = await persistRotatedRefresh(tc, issued.record)
  if (!persisted) {
    await revokeFamily(tc, old.familyId)
    return fail('invalid_grant', 'refresh token replay detected; family revoked')
  }

  const grantContext = await resolveTokenGrantContext(tc, {
    userId: old.userId,
    activeOrgId: old.activeOrgId,
    projectGrantId: old.projectGrantId,
  })
  if (!grantContext.ok) return grantContext
  const accessResult = await issueUserAccessTokenWithMetadata(
    tc,
    {
      userId: old.userId,
      scope,
      audience: resolveRefreshAudience(old),
      authContext: {
        acr: old.acr,
        amr: old.amr,
        authTime: old.authTime,
      },
      authorizationDetails: old.authorizationDetails,
    },
    {
      userId: old.userId,
      activeOrg: grantContext.value.activeOrg,
      grant: grantContext.value.grant,
    },
  )
  if (!accessResult.ok) return accessResult
  const accessToken = accessResult.value.token
  const tracked = await persistAccessTokenIssuance(tc, accessResult.value, {
    refreshFamilyId: old.familyId,
  })
  if (!tracked) return fail('invalid_grant', 'refresh token replay detected; family revoked')
  const idToken = scope.split(' ').includes('openid')
    ? await issueIdToken(tc, {
        userId: old.userId,
        scope,
        nonce: null,
        authTime: old.authTime,
        acr: old.acr,
        amr: old.amr,
        sid: old.sessionId,
        accessToken,
      })
    : null
  return {
    ok: true,
    value: tokenResponseBody({
      accessToken,
      jkt: tc.dpopJkt,
      ttlSec: accessTtl(tc),
      scope,
      refreshToken: issued.token,
      idToken,
      authorizationDetails: old.authorizationDetails,
    }),
  }
}

// successor 写入以 family_revoked_at 为栅栏。revokeFamily 先标记整个 family,
// 因此旧 token CAS 成功后若其他 Worker 发现重放,本写入必定被拒绝。
async function persistRotatedRefresh(tc: TokenContext, rec: RefreshTokenRecord): Promise<boolean> {
  const tenant = tc.c.get('tenant')
  const now = Date.now()
  const result = await tc.c.env.DB.prepare(
    `INSERT INTO refresh_tokens (
       id, tenant_id, token_hash, family_id, parent_token_id, user_id, session_id, client_id, scope, jkt,
       active_org_id, project_grant_id, resource, authorization_details, auth_time, acr, amr,
       revoked_at, family_revoked_at, expires_at, absolute_expires_at, created_at
     ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM refresh_tokens
         WHERE tenant_id = ? AND family_id = ? AND family_revoked_at IS NOT NULL
       )`,
  )
    .bind(
      rec.id,
      tenant.tenantId,
      rec.tokenHash,
      rec.familyId,
      rec.parentTokenId,
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
      rec.expiresAt * 1000,
      rec.absoluteExpiresAt * 1000,
      now,
      tenant.tenantId,
      rec.familyId,
    )
    .all()
  return result.meta.changes === undefined || result.meta.changes === 1
}

function parseAuthorizationDetailsRow(
  value: RefreshRow['authorizationDetails'],
): readonly AuthorizationDetails[] | null {
  return value && value.length > 0 ? value : null
}

function toRefreshRecord(row: RefreshRow): RefreshTokenRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    tokenHash: row.tokenHash,
    familyId: row.familyId,
    parentTokenId: row.parentTokenId,
    userId: row.userId,
    sessionId: row.sessionId ?? null,
    clientId: row.clientId,
    scope: row.scope,
    jkt: row.jkt,
    activeOrgId: row.activeOrgId ?? null,
    projectGrantId: row.projectGrantId ?? null,
    resource: row.resource ?? null,
    authorizationDetails: parseAuthorizationDetailsRow(row.authorizationDetails),
    authTime: row.authTime ?? null,
    acr: row.acr ?? null,
    amr: row.amr ?? null,
    revokedAt: row.revokedAt === null ? null : Math.floor(row.revokedAt.getTime() / 1000),
    expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
    absoluteExpiresAt: Math.floor(row.absoluteExpiresAt.getTime() / 1000),
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
  }
}

function resolveRefreshAudience(record: RefreshTokenRecord): string | readonly string[] {
  if (!record.resource || record.resource.length === 0) return record.clientId
  return record.resource.length === 1 ? record.resource[0]! : record.resource
}

// family 连锁撤销必须标记已撤销的祖先行。否则旧 token CAS 后的重放不会留下
// successor 写入可见的 family 栅栏，后到的请求会错误写入新的 refresh token。
async function revokeFamily(tc: TokenContext, familyId: string): Promise<void> {
  const ctx = tc.c.get('tenant')
  const now = tc.now * 1000
  await tc.c.env.DB.batch([
    tc.c.env.DB.prepare(
      `UPDATE refresh_tokens
         SET revoked_at = ?, family_revoked_at = ?
         WHERE tenant_id = ? AND family_id = ? AND family_revoked_at IS NULL`,
    ).bind(now, now, ctx.tenantId, familyId),
    accessRevocationStatement(tc, { column: 'refresh_family_id', identifier: familyId, now }),
  ])
}

function accessRevocationStatement(
  tc: TokenContext,
  input: {
    column: 'authorization_code' | 'refresh_family_id'
    identifier: string
    now: number
    familyFromCode?: boolean
  },
): D1PreparedStatement {
  const ctx = tc.c.get('tenant')
  const condition = input.familyFromCode
    ? `refresh_family_id IN (
         SELECT family_id FROM refresh_tokens
         WHERE tenant_id = ? AND authorization_code = ?
       )`
    : `${input.column} = ?`
  const values = input.familyFromCode
    ? [input.now, input.now, ctx.tenantId, ctx.tenantId, input.identifier, input.now]
    : [input.now, input.now, ctx.tenantId, input.identifier, input.now]
  return tc.c.env.DB.prepare(
    `INSERT OR IGNORE INTO access_token_revocations (
         id, tenant_id, jti, client_id, subject, expires_at, revoked_at, created_at
       ) SELECT lower(hex(randomblob(16))), tenant_id, jti, client_id, subject, expires_at, ?, ?
         FROM access_token_issuances
         WHERE tenant_id = ? AND ${condition} AND expires_at > ?`,
  ).bind(...values)
}
