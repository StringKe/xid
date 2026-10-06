// POST /v1/me/password:account portal 改密(SecurityPage 经 useChangePassword,前端发 POST,非 PATCH)。
// 流程:限流 -> 校验旧密 -> 长度/HIBP/历史(与重置共用)-> 写 passwords + 追加 password_history
// -> 撤销其它会话与该用户的 OAuth 凭据。
// POST /v1/me/password/setup-link:passwordless 用户经已验证邮箱发设密链接(复用 reset token 仪式)。
// 认证:cookie session;租户隔离:createTenantDb;pepper 走 env.PEPPER(不入 DB,见 password-auth rule)。
// 失败带 meta.paramName(currentPassword / newPassword)供前端映射字段。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { hashPassword, passwordReuseTag, verifyPassword } from '../auth/password'
import { assertAcceptableNewPassword } from '../auth/new-password'
import { AppError } from '../lib/errors'
import { revokeUserCredentials } from '../lib/revoke-user-credentials'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { enforceVerifyRateLimit, resetVerifyAccountRateLimit } from '../lib/verify-rate-limit'
import { sendPasswordResetEmail } from '../me-auth/password-reset-token'
import { enforceSendRateLimit, requestIp } from '../me-auth/shared'
import { loadPrimaryEmail, requireSession } from './shared'

// currentPassword 空串在形状层即拒;newPassword 只要求 string,长度/HIBP/历史重用留业务层。
const changePasswordBodySchema = v.object({
  currentPassword: v.pipe(v.string(), v.minLength(1)),
  newPassword: v.string(),
})

// 改密的旧密校验与登录计数分开:会话持有者不能借改密端点把登录账户维度打满,反之亦然。
const CHANGE_PASSWORD_RATE_LIMIT_SCOPE = 'me_password'

const app = new Hono<XidHonoEnv>()

// POST /v1/me/password
app.post('/', async (c) => {
  const session = await requireSession(c)
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const pepper = c.env.PEPPER

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(changePasswordBodySchema, json.value)

  await enforceVerifyRateLimit({
    env: c.env,
    tenantId: tenant.tenantId,
    scope: CHANGE_PASSWORD_RATE_LIMIT_SCOPE,
    account: session.userId,
    ip: requestIp(c),
  })

  const current = await db.passwords.findOne(eq(schema.passwords.userId, session.userId))
  // 无密码记录(passwordless 用户)或旧密不符:统一模糊 invalid_credentials,meta 映射 currentPassword。
  const validCurrent = current
    ? await verifyPassword(body.currentPassword, current.hash, current.algo, pepper)
    : false
  if (!current || !validCurrent) {
    throw new AppError('invalid_credentials', { meta: { paramName: 'currentPassword' } })
  }
  await resetVerifyAccountRateLimit({
    env: c.env,
    tenantId: tenant.tenantId,
    scope: CHANGE_PASSWORD_RATE_LIMIT_SCOPE,
    account: session.userId,
  })

  await assertAcceptableNewPassword({
    ctx: tenant,
    d1: c.env.DB,
    userId: session.userId,
    password: body.newPassword,
    pepperRaw: pepper,
    paramName: 'newPassword',
  })

  const newPasswordReuseTag = await passwordReuseTag(body.newPassword, pepper)
  const meta = await hashPassword(body.newPassword, pepper)
  await db.passwords.update(
    {
      hash: meta.hash,
      algo: meta.algo,
      pepperVersion: meta.pepperVersion,
      reuseTag: newPasswordReuseTag,
      breached: false,
    },
    eq(schema.passwords.userId, session.userId),
  )
  await db.passwordHistory.insert({
    id: crypto.randomUUID(),
    tenantId: tenant.tenantId,
    userId: session.userId,
    hash: current.hash,
    reuseTag: current.reuseTag,
  })

  // 改密后撤销其它设备会话与 OAuth 凭据,保留当前会话避免自己掉线。
  await revokeUserCredentials(c.env, tenant, session.userId, { keepSessionId: session.sessionId })

  return c.json({ updated: true })
})

// POST /v1/me/password/setup-link:passwordless 用户(guest / social / OTP 建号)的设密入口。
// session 即身份证明(无枚举面,不需要 Turnstile),复用 reset token + password_reset 邮件仪式,
// 与 forgot-password 同一 pwreset 发送预算。仅限已验证 primary email:未验证邮箱先走
// /auth/resend-verification 完成验证仪式,再回到 account 页发设密链接。
app.post('/setup-link', async (c) => {
  const session = await requireSession(c)
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)

  const user = await db.users.findOne(
    and(
      eq(schema.users.id, session.userId),
      eq(schema.users.status, 'active'),
      isNull(schema.users.deletedAt),
    ),
  )
  if (!user) throw new AppError('unauthorized', { httpStatus: 401 })

  const primary = await loadPrimaryEmail(c, user.id, user.primaryEmailId)
  if (!primary?.verified) throw new AppError('invalid_request', { httpStatus: 400 })

  await enforceSendRateLimit(c.env, `pwreset:${tenant.tenantId}`, primary.email)
  await sendPasswordResetEmail({
    env: c.env,
    tenant,
    db,
    userId: user.id,
    email: primary.email,
    locale: c.get('locale'),
  })

  return c.json({ ok: true })
})

export function registerPasswordRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/me/password', app)
}
