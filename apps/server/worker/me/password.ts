// POST /v1/me/password:account portal 改密(SecurityPage 经 useChangePassword,前端发 POST,非 PATCH)。
// 流程:校验旧密 -> 长度 -> HIBP 强制 -> 历史重用 -> 写 passwords + 追加 password_history -> 撤销其它会话。
// POST /v1/me/password/setup-link:passwordless 用户经已验证邮箱发设密链接(复用 reset token 仪式)。
// 认证:cookie session;租户隔离:createTenantDb;pepper 走 env.PEPPER(不入 DB,见 password-auth rule)。
// 失败带 meta.paramName(currentPassword / newPassword)供前端映射字段。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, isNull, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import {
  checkHibpBreached,
  hashPassword,
  isPasswordReused,
  passwordReuseTag,
  validatePasswordLength,
  verifyPassword,
} from '../auth/password'
import { AppError } from '../lib/errors'
import { hostedAuthOriginForTenant } from '../lib/hosted-origin'
import { sessionDoRevokeAllExcept } from '../lib/session'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { issuePasswordResetToken } from '../me-auth/password-reset'
import { enforceSendRateLimit } from '../me-auth/shared'
import { loadPrimaryEmail, requireSession } from './shared'

// currentPassword 空串在形状层即拒(沿用原手写校验语义);
// newPassword 只要求 string,长度/HIBP/历史重用留业务层,错误 meta 保持 paramName=newPassword。
const changePasswordBodySchema = v.object({
  currentPassword: v.pipe(v.string(), v.minLength(1)),
  newPassword: v.string(),
})

// 撤销除当前外的所有会话(改密后强制其它设备重新登录,保留当前会话避免自己掉线)。
async function revokeOtherSessions(
  c: Context<XidHonoEnv>,
  userId: string,
  currentSessionId: string,
): Promise<void> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  await sessionDoRevokeAllExcept(c.env, userId, currentSessionId)
  await db.sessions.update(
    { status: 'revoked' },
    and(
      eq(schema.sessions.userId, userId),
      eq(schema.sessions.status, 'active'),
      ne(schema.sessions.id, currentSessionId),
    ),
  )
}

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

  const current = await db.passwords.findOne(eq(schema.passwords.userId, session.userId))
  // 无密码记录(passwordless 用户)或旧密不符:统一模糊 invalid_credentials,meta 映射 currentPassword。
  const validCurrent = current
    ? await verifyPassword(body.currentPassword, current.hash, current.algo, pepper)
    : false
  if (!current || !validCurrent) {
    throw new AppError('invalid_credentials', { meta: { paramName: 'currentPassword' } })
  }

  // 新密长度校验(12-128)。
  const lengthCheck = validatePasswordLength(body.newPassword)
  if (!lengthCheck.ok) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'newPassword' } })
  }

  // HIBP breach 强制检查(改密路径阻断,见 password-auth rule)。
  if (await checkHibpBreached(body.newPassword)) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'newPassword' } })
  }

  // 历史重用拒绝(最近 5 条)。
  const reused = await isPasswordReused({
    ctx: tenant,
    d1: c.env.DB,
    userId: session.userId,
    newPassword: body.newPassword,
    pepperRaw: pepper,
  })
  if (reused) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'newPassword' } })
  }

  const newPasswordReuseTag = await passwordReuseTag(body.newPassword, pepper)

  // 写新哈希:更新 passwords(1:1)+ 追加旧哈希到 password_history。
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

  // 改密后撤销其它设备会话(保留当前)。
  await revokeOtherSessions(c, session.userId, session.sessionId)

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
  const { token } = await issuePasswordResetToken({
    env: c.env,
    tenant,
    db,
    userId: user.id,
  })
  await c.env.EMAIL_QUEUE.send({
    type: 'password_reset',
    recipient: primary.email,
    payload: {
      tenantId: tenant.tenantId,
      userId: user.id,
      token,
      link: `${hostedAuthOriginForTenant(tenant)}/reset-password#${new URLSearchParams({ token }).toString()}`,
      expires: 15,
      expiresInMin: 15,
    },
  })

  return c.json({ ok: true })
})

export function registerPasswordRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/me/password', app)
}
