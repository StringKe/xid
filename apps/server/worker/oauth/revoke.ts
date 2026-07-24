// /revoke - RFC7009 Token Revocation
// 支持 access token 和 refresh token 两类。
// refresh token 撤销整个 family(oidc-oauth rule refresh rotation + family 吊销)。
// 错误形状:RFC7009 2.2,client 认证失败 401 + WWW-Authenticate,其余 400 { error }。
// 见 oidc-oauth rule / docs/design/03-oidc-oauth.md endpoint 表。
// 铁律:TenantContext 从 c.get('tenant') 取;D1 查询走 @xid-kit/db 租户查询层。

import { Hono } from 'hono'
import type { Context } from 'hono'
import { eq, and } from 'drizzle-orm'
import * as v from 'valibot'
import { hashRefreshToken } from '@xid-kit/protocol'
import { createTenantDb, schema } from '@xid-kit/db'
import { verifyJwt } from '@xid-kit/crypto'
import type { XidHonoEnv } from '../lib/types'
import { authenticateClient } from './lib/client-auth'
import {
  BASIC_AUTH_CHALLENGE,
  buildVerifyKeySet,
  oauthError,
  oauthInvalidRequest,
} from '../oidc/shared'

const app = new Hono<XidHonoEnv>()

// 形状层:token 必填非空 string;hint 限 RFC7009 两个值(未知 hint 现状静默双试,改拒更安全)。
const revokeFormSchema = v.object({
  token: v.pipe(v.string(), v.minLength(1)),
  token_type_hint: v.optional(v.picklist(['access_token', 'refresh_token'])),
})

// 成功 200 空体(RFC7009 2.2),缓存头与 token 端点对齐。
function revokedOk(c: Context<XidHonoEnv>): Response {
  return c.body(null, 200, { 'cache-control': 'no-store', pragma: 'no-cache' })
}

// RFC7009 2.2:成功和"不认识该 token"均返回 200。只有 client 认证失败才 4xx。
app.post('/revoke', async (c) => {
  const ctx = c.get('tenant')

  const clientResult = await authenticateClient(c)
  if (!clientResult.ok) {
    return oauthError(c, {
      status: 401,
      error: 'invalid_client',
      description: clientResult.error.message,
      extraHeaders: { 'www-authenticate': BASIC_AUTH_CHALLENGE },
    })
  }

  const form = await c.req.formData()
  const parsed = v.safeParse(revokeFormSchema, {
    token: form.get('token'),
    token_type_hint: form.get('token_type_hint') ?? undefined,
  })
  if (!parsed.success) return oauthInvalidRequest(c, parsed.issues)
  const input = parsed.output

  const db = createTenantDb(c.env.DB, ctx)

  // hint 指示顺序:先按 hint 尝试。
  if (input.token_type_hint === 'refresh_token') {
    await revokeRefreshToken(db, ctx.tenantId, input.token, clientResult.value.clientId)
    return revokedOk(c)
  }

  if (input.token_type_hint === 'access_token') {
    await revokeAccessToken(c.env.DB, ctx, input.token, clientResult.value.clientId)
    return revokedOk(c)
  }

  // 无 hint:先尝试 refresh token,再尝试 access token。两者都不识别仍按 RFC7009 2.2 返回 200。
  await revokeRefreshToken(db, ctx.tenantId, input.token, clientResult.value.clientId)
  await revokeAccessToken(c.env.DB, ctx, input.token, clientResult.value.clientId)
  return revokedOk(c)
})

function accessTokenTyp(typ: string | undefined): boolean {
  return typ === 'at+jwt' || typ === 'application/at+jwt'
}

// Access token 撤销:JWT 验签 -> client 归属校验 -> 按 jti 写 denylist。
// 不认识 token 或 client 不匹配均静默返回,RFC7009 2.2 不泄露 token 归属。
async function revokeAccessToken(
  d1: D1Database,
  ctx: import('@xid-kit/types').TenantContext,
  token: string,
  clientId: string,
): Promise<void> {
  try {
    const keySet = await buildVerifyKeySet(ctx)
    const result = await verifyJwt(token, keySet, { expectedIssuer: ctx.issuer })
    if (!result.ok) return
    if (!accessTokenTyp(result.value.header.typ)) return

    const payload = result.value.payload
    if (
      typeof payload.jti !== 'string' ||
      typeof payload.exp !== 'number' ||
      typeof payload.client_id !== 'string'
    ) {
      return
    }
    if (payload.client_id !== clientId) return

    const db = createTenantDb(d1, ctx)
    const existing = await db.accessTokenRevocations.findOne(
      eq(schema.accessTokenRevocations.jti, payload.jti),
    )
    if (existing) return
    await db.accessTokenRevocations.insert({
      id: crypto.randomUUID(),
      tenantId: ctx.tenantId,
      jti: payload.jti,
      clientId,
      subject: typeof payload.sub === 'string' ? payload.sub : null,
      expiresAt: new Date(payload.exp * 1000),
      revokedAt: new Date(),
    })
  } catch {
    return
  }
}

// Refresh token 撤销:查 D1 -> 撤销整个 family(replay 防护:family 内任一 token 被撤销则全家吊销)。
// 见 oidc-oauth rule refresh token family 检测。
async function revokeRefreshToken(
  db: ReturnType<typeof createTenantDb>,
  tenantId: string,
  token: string,
  clientId: string,
): Promise<void> {
  const tokenHash = await hashRefreshToken(token)
  const row = await db.refreshTokens.findOne(
    and(eq(schema.refreshTokens.tenantId, tenantId), eq(schema.refreshTokens.tokenHash, tokenHash)),
  )
  // token 不存在:RFC7009 2.2 不报错。
  if (!row) return
  // client 不匹配:静默忽略(不泄露 token 归属,枚举防护)。
  if (row.clientId !== clientId) return

  // 撤销整个 family:按 familyId 批量标 revokedAt。
  const now = new Date()
  await db.refreshTokens.update(
    { revokedAt: now },
    and(
      eq(schema.refreshTokens.tenantId, tenantId),
      eq(schema.refreshTokens.familyId, row.familyId),
    ),
  )
}

export function registerRevoke(parent: Hono<XidHonoEnv>): void {
  parent.route('/', app)
}
