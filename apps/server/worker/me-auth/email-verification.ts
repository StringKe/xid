// POST /auth/verify-email + /auth/resend-verification(前端 verify-email/index.tsx)。
// verify-email:核销 sign-up 签发的 email_verification token(JWT 验签 + jti 一次性消费),置 emailVerified=true。
//   token 过期抛 token_expired,无效抛 token_invalid(前端据 code 区分 expired/invalid)。
// resend-verification:无 body,仅 session 态可用(从 c.get('session').userId 取未验证主邮箱);
//   限流(rate_limited);无 session / 无未验证邮箱时静默 200(枚举防护)。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readSession } from '../lib/session'
import { readJsonBody, validateCredentialBody } from '../lib/validate'
import {
  consumeEmailVerifyToken,
  issueEmailVerification,
  verifyEmailVerifyJwt,
} from './email-verify-token'
import { enforceSendRateLimit } from './shared'
import { resolveTokenTenant } from './token-tenant'
import { withTenant } from './instance-login'

const verifyBodySchema = v.object({ token: v.pipe(v.string(), v.minLength(1)) })

export async function handleVerifyEmail(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('token_invalid')
  // token 是凭证:缺失/形状失败与无效 token 同 token_invalid,前端据 code 区分 expired/invalid。
  const body = validateCredentialBody(verifyBodySchema, json.value, {
    code: 'token_invalid',
    credentialFields: ['token'],
  })
  const rawToken = body.token
  const tenant = await resolveTokenTenant(c, rawToken, 'token_invalid')

  return withTenant(c, tenant, async () => {
    const jti = await verifyEmailVerifyJwt(tenant, rawToken)
    const db = createTenantDb(c.env.DB, tenant)
    const userId = await consumeEmailVerifyToken(db, jti)

    // 置该用户主邮箱 verified=true(只更新未验证行;已验证幂等)。
    await db.userEmails.update(
      { verified: true, verificationStatus: 'verified', verifiedAt: new Date() },
      and(eq(schema.userEmails.userId, userId), eq(schema.userEmails.isPrimary, true)),
    )

    return c.json({ ok: true })
  })
}

export async function handleResendVerification(c: Context<XidHonoEnv>): Promise<Response> {
  const tenant = c.get('tenant')
  // 当前契约无 body,仅 session 态可用;无 session 静默 200(枚举防护)。
  const session = c.get('session') ?? (await readSession(c))
  if (!session) return c.json({ ok: true })

  const db = createTenantDb(c.env.DB, tenant)
  const emailRow = await db.userEmails.findOne(
    and(eq(schema.userEmails.userId, session.userId), eq(schema.userEmails.isPrimary, true)),
  )
  // 无主邮箱 / 已验证:静默 200(枚举防护,不泄露状态)。
  if (!emailRow || emailRow.verified) return c.json({ ok: true })

  // 限流(超限抛 rate_limited;前端唯一区分的错误)。
  await enforceSendRateLimit(c.env, `emailverify:${tenant.tenantId}`, emailRow.email)

  await issueEmailVerification({
    env: c.env,
    tenant,
    userId: session.userId,
    email: emailRow.email,
  })

  return c.json({ ok: true })
}
