// POST /auth/forgot-password + /auth/reset-password。
// forgot-password:恒 200(邮箱不存在、形状错误、多组织都不泄露);identifier 匹配多个组织时逐个发信,
//   重置链接自带租户 hint。续跑上下文(client_id / continue / intent)写进 token 签名 claim。
// reset-password:验签 -> 长度/HIBP/历史 -> 用户仍 active -> 一次性消费 -> 写密码 -> 证明过的主邮箱标为已验证
//   -> 撤销该用户全部 session 与 OAuth 凭据 -> 签发新 session,按续跑上下文返回 redirectUrl。

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { defaultLandingPathFor } from '@xid-kit/types'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import { resolveHostedAuthFlow } from '../../shared/hosted-auth-continuation'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { assertActiveSessionUser, issueSession } from '../lib/session'
import { revokeUserCredentials } from '../lib/revoke-user-credentials'
import { PASSWORD_AUTH_CONTEXT } from '../lib/auth-context'
import { firstIssuePath, readJsonBody, validateCredentialBody } from '../lib/validate'
import { hashPassword, passwordReuseTag, verifyResetToken } from '../auth/password'
import type { ResetTokenContext } from '../auth/password'
import { assertAcceptableNewPassword } from '../auth/new-password'
import { enforceSendRateLimit, requestIp, requestUserAgent, verifyTurnstile } from './shared'
import { resolveTokenTenant } from './token-tenant'
import { resolveEntryTenants, withTenant } from './instance-login'
import { buildVerifyKeySet } from '../oidc/shared'
import { assertMethodAllowed, assertEmailAllowed } from '../auth/hosted-policy'
import { auditPolicyDeniedError } from '../auth/hosted-audit'
import { postAuthRedirectPath, resolvePostAuthMfaGate } from '../lib/mfa-session'
import { shouldSkipDefaultMembership } from './passwordless-users'
import { sendPasswordResetEmail, type ResetFlow } from './password-reset-token'

const nullableString = v.optional(v.nullable(v.string()))
const forgotBodySchema = v.object({
  email: v.optional(v.string()),
  organizationId: nullableString,
  clientId: nullableString,
  intent: nullableString,
  continue: nullableString,
  turnstileToken: nullableString,
})
const resetBodySchema = v.object({
  token: v.optional(v.string()),
  password: v.optional(v.string()),
})
const NON_CREDENTIAL_FORGOT_FIELDS = new Set(['organizationId', 'clientId', 'intent', 'continue'])

type Db = ReturnType<typeof createTenantDb>

async function sendResetForTenant(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  input: { email: string; flow: ResetFlow },
): Promise<void> {
  const { email, flow } = input
  // 限流:1/min + 5/hour per 邮箱(超限抛 rate_limited,前端唯一区分的错误)。
  await enforceSendRateLimit(c.env, `pwreset:${tenant.tenantId}`, email)
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
    return
  }
  const db = createTenantDb(c.env.DB, tenant)
  const emailRow = await db.userEmails.findOne(eq(schema.userEmails.email, email))
  if (!emailRow) return
  await sendPasswordResetEmail({
    env: c.env,
    tenant,
    db,
    userId: emailRow.userId,
    email,
    locale: c.get('locale'),
    flow,
  })
}

export async function handleForgotPassword(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  // 坏 JSON 与"邮箱不存在"同响应 200(枚举防护)。
  if (!json.ok) return c.json({ ok: true })
  const parsed = v.safeParse(forgotBodySchema, json.value)
  if (!parsed.success) {
    const paramName = firstIssuePath(parsed.issues)
    // email 形状失败同样静默 200;非凭证字段 422 精确映射。
    if (!NON_CREDENTIAL_FORGOT_FIELDS.has(paramName.split('.')[0] ?? ''))
      return c.json({ ok: true })
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName } })
  }
  const body = parsed.output
  const email = (body.email ?? '').trim().toLowerCase()
  if (!email) return c.json({ ok: true })
  const flow = resolveHostedAuthFlow({
    intent: body.intent,
    continuePath: body.continue,
    applicationClientId: body.clientId,
    defaultContinuePath: defaultLandingPathFor(c.get('tenant')),
  })
  if (!flow) throw new AppError('invalid_request')
  await verifyTurnstile(body.turnstileToken, c.env, requestIp(c))
  const tenants = await resolveEntryTenants(
    c,
    { kind: 'email', value: email },
    body.organizationId,
    {
      applicationClientId: flow.applicationClientId,
    },
  )
  for (const tenant of tenants) {
    await withTenant(c, tenant, () => sendResetForTenant(c, tenant, { email, flow }))
  }
  return c.json({ ok: true })
}

// token 一次性消费:按 tokenHash=sha256(token) 查行 + 状态校验 + 标记 consumed。
async function consumeResetToken(db: Db, token: string, expectedUserId: string): Promise<void> {
  const tokenHash = await sha256Hex(token)
  const row = await db.passwordResetTokens.findOne(
    eq(schema.passwordResetTokens.tokenHash, tokenHash),
  )
  // 签名有效但 DB 无记录 / 已消费 / userId 不符 -> 无效(防重放)。
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

// 写新密码:旧 hash 入历史 + 更新 passwords 行(无行则插入)。返回此前是否已有密码。
async function persistNewPassword(opts: {
  db: Db
  tenant: TenantVar
  userId: string
  password: string
  pepper: string
}): Promise<boolean> {
  const { db, tenant, userId } = opts
  const reuseTag = await passwordReuseTag(opts.password, opts.pepper)
  const newHash = await hashPassword(opts.password, opts.pepper)
  const current = await db.passwords.findOne(eq(schema.passwords.userId, userId))
  if (!current) {
    await db.passwords.insert({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      userId,
      hash: newHash.hash,
      algo: 'argon2id',
      pepperVersion: newHash.pepperVersion,
      reuseTag,
    })
    return false
  }
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
  return true
}

// 重置链接送达即证明邮箱控制权:主邮箱仍未验证时标为已验证;hosted_password 首次设密时补默认 membership,
// 与邮箱验证仪式的结果一致,避免下次登录再被要求验证。
async function applyEmailProof(opts: {
  db: Db
  tenant: TenantVar
  userId: string
  emailHash: string | null
  hadPassword: boolean
  flow: ResetFlow
}): Promise<void> {
  const { db, tenant, userId } = opts
  if (!opts.emailHash) return
  const user = await db.users.findOne(eq(schema.users.id, userId))
  if (!user?.primaryEmailId) return
  const primary = await db.userEmails.findOne(
    and(eq(schema.userEmails.id, user.primaryEmailId), eq(schema.userEmails.userId, userId)),
  )
  if (!primary || (await sha256Hex(primary.email.trim().toLowerCase())) !== opts.emailHash) return
  if (!primary.verified || primary.verificationStatus !== 'verified') {
    await db.userEmails.update(
      { verified: true, verificationStatus: 'verified', verifiedAt: new Date() },
      and(eq(schema.userEmails.id, primary.id), eq(schema.userEmails.userId, userId)),
    )
  }
  const skipDefaultMembership = shouldSkipDefaultMembership({
    redirectAfterLogin: opts.flow.continuePath,
    intent: opts.flow.intent,
  })
  if (user.provisionedBy !== 'hosted_password' || opts.hadPassword || skipDefaultMembership) return
  await db.memberships.insertManyIgnore([
    {
      id: createPersistedId('membership'),
      tenantId: tenant.tenantId,
      orgId: tenant.tenantId,
      userId,
      role: 'member',
      membershipType: 'member',
      status: 'active',
      isManaged: false,
      joinedAt: new Date(),
    },
  ])
}

function resetFlowFrom(tenant: TenantVar, context: ResetTokenContext): ResetFlow {
  const flow = resolveHostedAuthFlow({
    intent: context.intent,
    continuePath: context.continuePath,
    applicationClientId: context.clientId,
    defaultContinuePath: defaultLandingPathFor(tenant),
  })
  if (!flow) throw new AppError('token_invalid')
  return flow
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
    const verified = await verifyResetToken(token, await buildVerifyKeySet(tenant), {
      expectedIssuer: tenant.issuer,
      expectedTenantId: tenant.tenantId,
    })
    if (!verified.ok) {
      throw new AppError(verified.reason === 'expired' ? 'token_expired' : 'token_invalid')
    }
    const flow = resetFlowFrom(tenant, verified.context)

    try {
      assertMethodAllowed(tenant, 'password', 'login')
    } catch (error) {
      throw await auditPolicyDeniedError(c, error, { tenant, method: 'password', action: 'login' })
    }

    await assertAcceptableNewPassword({
      ctx: tenant,
      d1: c.env.DB,
      userId: verified.userId,
      password,
      pepperRaw: c.env.PEPPER,
      paramName: 'password',
    })

    const db = createTenantDb(c.env.DB, tenant)
    // 用户仍必须是 active non-deleted。不能先消费 token 或改密码,再由自动登录失败兜底。
    await assertActiveSessionUser(db, verified.userId)
    await consumeResetToken(db, token, verified.userId)
    const hadPassword = await persistNewPassword({
      db,
      tenant,
      userId: verified.userId,
      password,
      pepper: c.env.PEPPER,
    })
    await applyEmailProof({
      db,
      tenant,
      userId: verified.userId,
      emailHash: verified.context.emailHash,
      hadPassword,
      flow,
    })
    // 重置意味着旧凭据可能已泄露:先撤销全部旧 session 与 refresh family,再签发本次 session。
    await revokeUserCredentials(c.env, tenant, verified.userId)

    const returnPath = postAuthRedirectPath({
      intent: flow.intent,
      continueParam: flow.continuePath,
      fallback: defaultLandingPathFor(tenant),
    })
    const mfaGate = await resolvePostAuthMfaGate(c, tenant, {
      userId: verified.userId,
      returnPath,
    })
    await issueSession(c, {
      sessionId: createPersistedId('session'),
      userId: verified.userId,
      ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
      authContext: PASSWORD_AUTH_CONTEXT,
      authenticatedAt: new Date(),
      ip: requestIp(c),
      userAgent: requestUserAgent(c),
    })
    return c.json({ ok: true, redirectUrl: mfaGate.redirectUrl ?? returnPath })
  })
}
