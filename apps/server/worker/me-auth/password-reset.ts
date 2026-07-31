// POST /auth/forgot-password + /auth/reset-password(前端 forgot-password/index.tsx)。
// forgot-password:createResetToken(tenant active signing key JWT,15min,DB 只存 tokenHash=sha256(token))+ 限流 + 发邮件。
//   枚举防护(铁律):email 不存在静默返回 200,不泄露存在性;仅限流抛 rate_limited。
// reset-password:verifyResetToken(过期->token_expired/无效->token_invalid)+ 长度/HIBP/历史复用校验 +
//   token 一次性消费(consumedAt,按 tokenHash=sha256(token))+ 重哈希写 passwords + 旧密码入历史 + 自动登录。

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { assertActiveSessionUser, issueSession } from '../lib/session'
import { PASSWORD_AUTH_CONTEXT } from '../lib/auth-context'
import { firstIssuePath, readJsonBody, validateCredentialBody } from '../lib/validate'
import {
  checkHibpBreached,
  createResetToken,
  hashPassword,
  isPasswordReused,
  passwordReuseTag,
  validatePasswordLength,
  verifyResetToken,
} from '../auth/password'
import { enforceSendRateLimit, requestIp, requestUserAgent, verifyTurnstile } from './shared'
import { hostedAuthOriginForTenant } from '../lib/hosted-origin'
import { resolveTokenTenant } from './token-tenant'
import { resolveEntryTenant, withTenant } from './instance-login'
import { recordAuthTokenIssued } from '../auth/token-audit'
import { buildVerifyKeySet, loadActiveSigner } from '../oidc/shared'
import { assertMethodAllowed, assertEmailAllowed } from '../auth/hosted-policy'
import { auditPolicyDeniedError } from '../auth/hosted-audit'
import { resolvePostAuthMfaGate } from '../lib/mfa-session'

const forgotBodySchema = v.object({
  email: v.optional(v.string()),
  organizationId: v.optional(v.nullable(v.string())),
  turnstileToken: v.optional(v.nullable(v.string())),
})
const resetBodySchema = v.object({
  token: v.optional(v.string()),
  password: v.optional(v.string()),
})

const RESET_PURPOSE = 'password_reset'

export async function issuePasswordResetToken(opts: {
  env: Env
  tenant: TenantVar
  db: ReturnType<typeof createTenantDb>
  userId: string
}): Promise<{ token: string; expiresAt: Date }> {
  const { env, tenant, db, userId } = opts
  const signer = await loadActiveSigner(tenant, env.KEK)
  const { token, tokenHash, expiresAt } = await createResetToken(userId, signer, {
    issuer: tenant.issuer,
    tenantId: tenant.tenantId,
  })
  await db.passwordResetTokens.hardDelete(
    and(
      eq(schema.passwordResetTokens.userId, userId),
      eq(schema.passwordResetTokens.purpose, RESET_PURPOSE),
    ),
  )
  await db.passwordResetTokens.insert({
    id: crypto.randomUUID(),
    tenantId: tenant.tenantId,
    userId,
    tokenHash,
    purpose: RESET_PURPOSE,
    expiresAt,
  })
  await recordAuthTokenIssued({
    env,
    tenant,
    purpose: RESET_PURPOSE,
    userId,
    kid: signer.kid,
  })
  return { token, expiresAt }
}

export async function handleForgotPassword(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  // 坏 JSON 与"邮箱不存在"同响应 200(枚举防护)。
  if (!json.ok) return c.json({ ok: true })
  const parsed = v.safeParse(forgotBodySchema, json.value)
  if (!parsed.success) {
    const paramName = firstIssuePath(parsed.issues)
    // email 形状失败同样静默 200:不区分"形状错误"与"邮箱不存在";organizationId 非凭证字段,422 精确映射。
    if (paramName.split('.')[0] !== 'organizationId') return c.json({ ok: true })
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName } })
  }
  const body = parsed.output
  const email = (body.email ?? '').trim().toLowerCase()
  if (!email) return c.json({ ok: true })
  // 密码重置请求是 Turnstile 介入点(01 章 7 防刷);secret 未配置时跳过(dev/test 友好)。
  await verifyTurnstile(body.turnstileToken, c.env, requestIp(c))
  const tenant = await resolveEntryTenant(c, { kind: 'email', value: email }, body.organizationId)

  // 限流:1/min + 5/hour per 邮箱(超限抛 rate_limited,前端唯一区分的错误)。
  await enforceSendRateLimit(c.env, `pwreset:${tenant.tenantId}`, email)

  const db = createTenantDb(c.env.DB, tenant)
  try {
    assertMethodAllowed(tenant, 'password', 'login')
    assertEmailAllowed(tenant, email)
  } catch (error) {
    await auditPolicyDeniedError(c, error, {
      tenant,
      method: 'password',
      action: 'login',
      identifier: { type: 'email', value: email },
    })
    return c.json({ ok: true })
  }

  // 枚举防护:email 不存在静默返回 200。
  const emailRow = await db.userEmails.findOne(eq(schema.userEmails.email, email))
  if (!emailRow) return c.json({ ok: true })

  const { token } = await issuePasswordResetToken({
    env: c.env,
    tenant,
    db,
    userId: emailRow.userId,
  })

  await c.env.EMAIL_QUEUE.send({
    type: 'password_reset',
    recipient: email,
    payload: {
      tenantId: tenant.tenantId,
      userId: emailRow.userId,
      token,
      link: `${hostedAuthOriginForTenant(tenant)}/reset-password?token=${encodeURIComponent(token)}`,
      expires: 15,
      expiresInMin: 15,
    },
  })

  return c.json({ ok: true })
}

// token 一次性消费:按 tokenHash=sha256(token) 查行 + 状态校验 + 标记 consumed。返回绑定 userId。
async function consumeResetToken(
  db: ReturnType<typeof createTenantDb>,
  token: string,
  expectedUserId: string,
): Promise<void> {
  const tokenHash = await sha256Hex(token)
  const row = await db.passwordResetTokens.findOne(
    eq(schema.passwordResetTokens.tokenHash, tokenHash),
  )
  // HMAC 有效但 DB 无记录 / 已消费 / 过期 / userId 不符 -> 无效(防重放)。
  if (!row || row.consumedAt !== null || row.userId !== expectedUserId) {
    throw new AppError('token_invalid')
  }
  if (row.expiresAt.getTime() <= Date.now()) throw new AppError('token_expired')
  const consumed = await db.passwordResetTokens.update(
    { consumedAt: new Date() },
    and(
      eq(schema.passwordResetTokens.tokenHash, tokenHash),
      eq(schema.passwordResetTokens.userId, expectedUserId),
      isNull(schema.passwordResetTokens.consumedAt),
      gt(schema.passwordResetTokens.expiresAt, new Date()),
    ),
  )
  if (consumed && consumed.length === 0 && row.id) throw new AppError('token_invalid')
}

// 写新密码:旧 hash 入历史 + 更新 passwords 行(无行则插入)。
async function persistNewPassword(opts: {
  db: ReturnType<typeof createTenantDb>
  tenant: TenantVar
  userId: string
  newHash: { hash: string; algo: 'argon2id'; pepperVersion: number }
  reuseTag: string
}): Promise<void> {
  const { db, tenant, userId, newHash, reuseTag } = opts
  const current = await db.passwords.findOne(eq(schema.passwords.userId, userId))
  if (current) {
    await db.passwordHistory.insert({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      userId,
      hash: current.hash,
      reuseTag: current.reuseTag,
    })
    await db.passwords.update(
      {
        hash: newHash.hash,
        algo: 'argon2id',
        pepperVersion: newHash.pepperVersion,
        reuseTag,
        breached: false,
      },
      eq(schema.passwords.userId, userId),
    )
    return
  }
  await db.passwords.insert({
    id: crypto.randomUUID(),
    tenantId: tenant.tenantId,
    userId,
    hash: newHash.hash,
    algo: 'argon2id',
    pepperVersion: newHash.pepperVersion,
    reuseTag,
  })
}

export async function handleResetPassword(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('token_invalid')
  // token 是凭证:形状失败与无效 token 同 token_invalid;password 形状失败 422 映射字段。
  const body = validateCredentialBody(resetBodySchema, json.value, {
    code: 'token_invalid',
    credentialFields: ['token'],
  })
  const token = body.token ?? ''
  const password = body.password ?? ''
  if (!token) throw new AppError('token_invalid')
  const tenant = await resolveTokenTenant(c, token, 'token_invalid')

  return withTenant(c, tenant, async () => {
    // 1. JWT 验签(过期/无效映射 token_*)。
    const verifyKeys = await buildVerifyKeySet(tenant)
    const verified = await verifyResetToken(token, verifyKeys, {
      expectedIssuer: tenant.issuer,
      expectedTenantId: tenant.tenantId,
    })
    if (!verified.ok) {
      throw new AppError(verified.reason === 'expired' ? 'token_expired' : 'token_invalid')
    }

    try {
      assertMethodAllowed(tenant, 'password', 'login')
    } catch (error) {
      throw await auditPolicyDeniedError(c, error, {
        tenant,
        method: 'password',
        action: 'login',
      })
    }

    // 2. 新密码长度 + HIBP(命中 password_breached)。
    const lengthCheck = validatePasswordLength(password)
    if (!lengthCheck.ok) {
      throw new AppError('validation_failed', { meta: { paramName: 'password' } })
    }
    if (await checkHibpBreached(password)) throw new AppError('password_breached')

    // 3. 历史复用拒绝(最近 5 条)。
    const reused = await isPasswordReused({
      ctx: tenant,
      d1: c.env.DB,
      userId: verified.userId,
      newPassword: password,
      pepperRaw: c.env.PEPPER,
    })
    if (reused) throw new AppError('password_reused', { meta: { paramName: 'password' } })

    const db = createTenantDb(c.env.DB, tenant)

    // 4. 用户仍必须是 active non-deleted。不能先消费 token 或改密码,再由自动登录失败兜底。
    await assertActiveSessionUser(db, verified.userId)

    // 5. token 一次性消费(DB 侧二次校验防重放)。
    await consumeResetToken(db, token, verified.userId)

    // 6. 写新密码 + 旧密码入历史。
    const reuseTag = await passwordReuseTag(password, c.env.PEPPER)
    const newHash = await hashPassword(password, c.env.PEPPER)
    await persistNewPassword({ db, tenant, userId: verified.userId, newHash, reuseTag })

    // 7. 自动登录(前端 reset 成功后 refresh())。
    const now = new Date()
    const mfaGate = await resolvePostAuthMfaGate(c, tenant, {
      userId: verified.userId,
      returnPath: '/console',
    })
    await issueSession(c, {
      sessionId: createPersistedId('session'),
      userId: verified.userId,
      ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
      authContext: PASSWORD_AUTH_CONTEXT,
      authenticatedAt: now,
      ip: requestIp(c),
      userAgent: requestUserAgent(c),
    })

    return c.json({
      ok: true,
      ...(mfaGate.redirectUrl ? { redirectUrl: mfaGate.redirectUrl } : {}),
    })
  })
}
