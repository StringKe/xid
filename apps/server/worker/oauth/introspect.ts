// /introspect - RFC7662 Token Introspection
// 仅 confidential client 或受信 resource server 可调用。
// 支持 access token(JWT 校验)和 refresh token(D1 hash 查询)。
// 错误形状:RFC7662 2.3,client 认证失败 401 + WWW-Authenticate,其余 400 { error }。
// 见 oidc-oauth rule / docs/design/03-oidc-oauth.md endpoint 表。
// 铁律:TenantContext 从 c.get('tenant') 取;D1 查询走 @xid-kit/db 租户查询层。

import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import * as v from 'valibot'
import { verifyJwt } from '@xid-kit/crypto'
import { hashRefreshToken } from '@xid-kit/protocol'
import { createTenantDb, schema } from '@xid-kit/db'
import { importJwkForVerify, buildJwks } from '@xid-kit/crypto'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { authenticateClient } from './lib/client-auth'
import { BASIC_AUTH_CHALLENGE, oauthError, oauthInvalidRequest, tokenJson } from '../oidc/shared'

const app = new Hono<XidHonoEnv>()

// inactive token 标准响应(RFC7662 2.2:inactive 只回 active=false)。
const INACTIVE = { active: false } as const

// 形状层:token 必填非空 string;hint 限 RFC7662 两个值(未知 hint 直接拒)。
const introspectFormSchema = v.object({
  token: v.pipe(v.string(), v.minLength(1)),
  token_type_hint: v.optional(v.picklist(['access_token', 'refresh_token'])),
})

function isAccessTokenJwtTyp(typ: string | undefined): boolean {
  return typ === 'at+jwt' || typ === 'application/at+jwt'
}

// DPoP 绑定 token 的 cnf.jkt(RFC9449 6:introspection 须报 token_type=DPoP 并回显 cnf)。
function cnfJktOf(payload: Record<string, unknown>): string | null {
  const cnf = payload.cnf
  if (typeof cnf !== 'object' || cnf === null) return null
  const jkt = (cnf as { jkt?: unknown }).jkt
  return typeof jkt === 'string' ? jkt : null
}

app.post('/introspect', async (c) => {
  const ctx = c.get('tenant')
  const db = createTenantDb(c.env.DB, ctx)

  // client 认证(confidential only - 不接受 none/public client)。
  const clientResult = await authenticateClient(c, { requireConfidential: true })
  if (!clientResult.ok) {
    return oauthError(c, {
      status: 401,
      error: 'invalid_client',
      description: clientResult.error.message,
      extraHeaders: { 'www-authenticate': BASIC_AUTH_CHALLENGE },
    })
  }

  const form = await c.req.formData()
  const parsed = v.safeParse(introspectFormSchema, {
    token: form.get('token'),
    token_type_hint: form.get('token_type_hint') ?? undefined,
  })
  if (!parsed.success) return oauthInvalidRequest(c, parsed.issues)
  const input = parsed.output

  // hint 指示顺序:先按 hint 尝试,失败再尝试另一类。
  const isRefreshHint = input.token_type_hint === 'refresh_token'

  if (isRefreshHint) {
    const rt = await introspectRefreshToken(db, ctx.tenantId, input.token)
    return tokenJson(c, rt)
  }

  // 默认先尝试 access token(JWT),失败再尝 refresh token。
  const atResult = await introspectAccessToken(db, ctx, input.token)
  if (atResult !== null) {
    return tokenJson(c, atResult)
  }

  const rt = await introspectRefreshToken(db, ctx.tenantId, input.token)
  return tokenJson(c, rt)
})

// Access token 内省:JWT 验签 + exp/iss 校验。
// 失败返回 null(调用方回落 refresh token 路径)。
async function introspectAccessToken(
  db: ReturnType<typeof createTenantDb>,
  ctx: import('@xid-kit/types').TenantContext,
  token: string,
): Promise<Record<string, unknown> | null> {
  try {
    const keySet = await buildVerifyKeySet(ctx)
    const result = await verifyJwt(token, keySet, {
      expectedIssuer: ctx.issuer,
      clockToleranceSec: 60,
    })
    if (!result.ok) return null
    const { header, payload } = result.value
    if (!isAccessTokenJwtTyp(header.typ)) return null
    if (typeof payload.jti !== 'string') return null
    // 租户绑定:instance 签名密钥全租户共享,验签通过不代表属于本租户。
    // tenant_id 在场且不等 -> 按 inactive 处理(RFC7662 对不属本租户 token 回 active:false,不报错);
    // 无此 claim 的旧 token 按原路径放行(切换前签发的存量,到期自然淘汰)。
    if (typeof payload.tenant_id === 'string' && payload.tenant_id !== ctx.tenantId) return null
    const revoked = await db.accessTokenRevocations.findOne(
      eq(schema.accessTokenRevocations.jti, payload.jti),
    )
    if (revoked) return null
    const jkt = cnfJktOf(payload)
    return {
      active: true,
      token_type: jkt ? 'DPoP' : 'Bearer',
      iss: payload.iss,
      sub: payload.sub,
      aud: payload.aud,
      exp: payload.exp,
      iat: payload.iat,
      jti: payload.jti,
      scope: payload.scope,
      client_id: payload.client_id,
      ...(payload.sid ? { sid: payload.sid } : {}),
      ...(jkt ? { cnf: { jkt } } : {}),
      ...(payload.authorization_details
        ? { authorization_details: payload.authorization_details }
        : {}),
    }
  } catch {
    return null
  }
}

// Refresh token 内省:SHA-256 hash 查 D1,校验 revokedAt / expiresAt。
// jkt 列在场说明签发时 DPoP 绑定(见 token-issue.ts),内省须报 DPoP + cnf。
async function introspectRefreshToken(
  db: ReturnType<typeof createTenantDb>,
  tenantId: string,
  token: string,
): Promise<typeof INACTIVE | Record<string, unknown>> {
  try {
    const tokenHash = await hashRefreshToken(token)
    const row = await db.refreshTokens.findOne(
      and(
        eq(schema.refreshTokens.tenantId, tenantId),
        eq(schema.refreshTokens.tokenHash, tokenHash),
      ),
    )
    if (!row) return INACTIVE
    if (row.revokedAt !== null) return INACTIVE
    const now = Math.floor(Date.now() / 1000)
    const expiresAtSec = Math.floor(row.expiresAt.getTime() / 1000)
    if (now > expiresAtSec) return INACTIVE
    return {
      active: true,
      token_type: row.jkt ? 'DPoP' : 'refresh_token',
      sub: row.userId,
      client_id: row.clientId,
      scope: row.scope,
      exp: expiresAtSec,
      iat: Math.floor(row.createdAt.getTime() / 1000),
      ...(row.jkt ? { cnf: { jkt: row.jkt } } : {}),
      ...(row.authorizationDetails ? { authorization_details: row.authorizationDetails } : {}),
    }
  } catch {
    return INACTIVE
  }
}

// 从 TenantContext signingKeys 组装 VerifyKeySet(公钥导入用于 JWT 校验)。
async function buildVerifyKeySet(
  ctx: import('@xid-kit/types').TenantContext,
): Promise<import('@xid-kit/crypto').VerifyKeySet> {
  const keys = await Promise.all(
    ctx.signingKeys.keys.map(async (km) => {
      const jwks = buildJwks([km])
      const jwk = jwks.keys[0]
      if (!jwk) throw new AppError('server_error')
      const publicKey = await importJwkForVerify(jwk)
      return { kid: km.kid, alg: km.alg, publicKey }
    }),
  )
  return { keys }
}

export function registerIntrospect(parent: Hono<XidHonoEnv>): void {
  parent.route('/', app)
}
