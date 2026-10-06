// POST /auth/password/sign-in:统一 password 流程。已有用户走 login 策略,identifier 不存在时走注册分支。
// 枚举防护:用户不存在 / 密码错误统一 invalid_credentials,且无论用户是否存在都执行等量哈希计算。
// 注册待验证(hosted_password、无密码行、主邮箱未验证)的账户再次提交时重发验证邮件,响应与新注册相同。
// 失败限流:account(identifier)10/15min + IP 50/min;密码校验通过后 reset 账户维度计数与退避档。

import { createTenantDb, schema } from '@xid-kit/db'
import { defaultLandingPathFor } from '@xid-kit/types'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { enforceVerifyRateLimit, resetVerifyAccountRateLimit } from '../lib/verify-rate-limit'
import { readJsonBody, validateCredentialBody } from '../lib/validate'
import { checkHibpBreached, verifyPassword } from '../auth/password'
import { allowSendRateLimit, requestIp, verifyTurnstile } from './shared'
import { assertEmailAllowed, assertMethodAllowed } from '../auth/hosted-policy'
import { auditPolicyDeniedError } from '../auth/hosted-audit'
import { resolveHostedAuthFlow } from '../../shared/hosted-auth-continuation'
import { loginHintCandidates, resolveEntryTenant, withTenant } from './instance-login'
import { startInvitationEmailClaim } from './invitation-claim'
import {
  auditIdentifier,
  completePasswordAuth,
  parseIdentifier,
  passwordRequiresEmailVerification,
  sendPasswordVerifyEmail,
  type ParsedIdentifier,
  type PasswordAuthResponse,
  type PasswordFlow,
} from './password-flow'
import { signUpWithPassword } from './password-signup'

const nullableString = v.optional(v.nullable(v.string()))

const passwordAuthBodySchema = v.object({
  identifier: v.optional(v.string()),
  password: v.optional(v.string()),
  rememberMe: v.optional(v.boolean()),
  organizationId: nullableString,
  clientId: nullableString,
  turnstileToken: nullableString,
  invitationToken: nullableString,
  intent: nullableString,
  continue: nullableString,
  email: nullableString,
  username: nullableString,
  phone: nullableString,
  name: nullableString,
  givenName: nullableString,
  familyName: nullableString,
})

type PasswordAuthBody = v.InferOutput<typeof passwordAuthBodySchema>

type Db = ReturnType<typeof createTenantDb>
type ResolvedUser = typeof schema.users.$inferSelect
type PrimaryEmail = typeof schema.userEmails.$inferSelect

// rememberMe 生效链:body 显式值 -> 策略 rememberMeDefault -> false。
function resolveRememberMe(tenant: TenantVar, requested: boolean | undefined): boolean {
  return requested ?? tenant.policy?.session?.rememberMeDefault ?? false
}

async function resolveUserByIdentifier(
  db: Db,
  identifier: ParsedIdentifier,
): Promise<ResolvedUser | null> {
  const notDeleted = isNull(schema.users.deletedAt)
  if (identifier.kind === 'email' || identifier.kind === 'phone') {
    const contactRow =
      identifier.kind === 'email'
        ? await db.userEmails.findOne(eq(schema.userEmails.email, identifier.value))
        : await db.userPhones.findOne(eq(schema.userPhones.phone, identifier.value))
    if (!contactRow) return null
    return (await db.users.findOne(and(eq(schema.users.id, contactRow.userId), notDeleted))) ?? null
  }
  const column = identifier.kind === 'username' ? schema.users.username : schema.users.externalId
  return (await db.users.findOne(and(eq(column, identifier.value), notDeleted))) ?? null
}

// 密码校验(constant-time):无密码行时用占位 hash 等时消耗。
const DUMMY_ARGON2 =
  '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

async function verifyUserPassword(
  c: Context<XidHonoEnv>,
  db: Db,
  input: { userId: string; password: string },
): Promise<{ valid: boolean; hasPassword: boolean }> {
  const pwRow = await db.passwords.findOne(eq(schema.passwords.userId, input.userId))
  const valid = await verifyPassword(
    input.password,
    pwRow?.hash ?? DUMMY_ARGON2,
    pwRow?.algo ?? 'argon2id',
    c.env.PEPPER,
  )
  return { valid: Boolean(pwRow) && valid, hasPassword: Boolean(pwRow) }
}

async function loadPrimaryEmail(db: Db, user: ResolvedUser): Promise<PrimaryEmail | null> {
  const row = await db.userEmails.findOne(
    user.primaryEmailId
      ? and(
          eq(schema.userEmails.id, user.primaryEmailId),
          eq(schema.userEmails.userId, user.id),
          eq(schema.userEmails.isPrimary, true),
        )
      : and(eq(schema.userEmails.userId, user.id), eq(schema.userEmails.isPrimary, true)),
  )
  return row ?? null
}

function isVerifiedEmail(row: PrimaryEmail | null): boolean {
  return row?.verified === true && row.verificationStatus === 'verified'
}

// 注册待验证账户:建号时不保存密码,所以只能重发验证邮件。发送超限时静默不发,保持与新注册同一响应。
async function resendPendingSignUpVerification(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  input: { db: Db; user: ResolvedUser; flow: PasswordFlow },
): Promise<PasswordAuthResponse | null> {
  if (input.user.provisionedBy !== 'hosted_password') return null
  if (!passwordRequiresEmailVerification(tenant)) return null
  const primary = await loadPrimaryEmail(input.db, input.user)
  if (!primary || isVerifiedEmail(primary)) return null
  const email = primary.email.trim().toLowerCase()
  if (!(await allowSendRateLimit(c.env, `emailverify:${tenant.tenantId}`, email))) {
    return { nextStep: 'verify_email' }
  }
  return sendPasswordVerifyEmail(c, tenant, { userId: input.user.id, email, flow: input.flow })
}

async function signInWithPassword(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  input: {
    db: Db
    user: ResolvedUser
    identifier: ParsedIdentifier
    password: string
    rememberMe: boolean
    flow: PasswordFlow
  },
): Promise<PasswordAuthResponse> {
  const { db, user, identifier, flow } = input
  try {
    assertMethodAllowed(tenant, 'password', 'login')
    if (identifier.kind === 'email') assertEmailAllowed(tenant, identifier.value)
  } catch (error) {
    throw await auditPolicyDeniedError(c, error, {
      tenant,
      method: 'password',
      action: 'login',
      identifier: auditIdentifier(identifier),
    })
  }

  // 账户锁定 / 暂停:模糊到 account_locked(不区分存在性,见 anti-abuse rule)。
  if (user.lockoutUntil && user.lockoutUntil.getTime() > Date.now()) {
    throw new AppError('account_locked')
  }
  if (user.status !== 'active' || user.deletedAt) throw new AppError('account_locked')

  const check = await verifyUserPassword(c, db, { userId: user.id, password: input.password })
  if (!check.valid) {
    const pending = check.hasPassword
      ? null
      : await resendPendingSignUpVerification(c, tenant, { db, user, flow })
    if (pending) return pending
    throw new AppError('invalid_credentials')
  }
  await resetVerifyAccountRateLimit({
    env: c.env,
    tenantId: tenant.tenantId,
    scope: 'password',
    account: identifier.value,
  })

  // HIBP 登录异步检查不阻断(命中标记 breached,下次提示重置,见 password-auth rule)。
  c.executionCtx.waitUntil(markBreachedIfPwned(c, tenant, user.id, input.password))

  if (passwordRequiresEmailVerification(tenant)) {
    const primary = await loadPrimaryEmail(db, user)
    if (!isVerifiedEmail(primary)) {
      if (!primary?.email) throw new AppError('invalid_credentials')
      return sendPasswordVerifyEmail(c, tenant, { userId: user.id, email: primary.email, flow })
    }
  }
  return completePasswordAuth(c, tenant, { userId: user.id, rememberMe: input.rememberMe, flow })
}

async function handlePasswordAuth(
  c: Context<XidHonoEnv>,
  body: PasswordAuthBody,
): Promise<Response> {
  const rawIdentifier = body.identifier ?? ''
  const flow = resolveHostedAuthFlow({
    intent: body.intent,
    continuePath: body.continue,
    applicationClientId: body.clientId,
    hasInvitation: Boolean(body.invitationToken?.trim()),
    defaultContinuePath: defaultLandingPathFor(c.get('tenant')),
  })
  if (!flow) throw new AppError('invalid_request')
  await verifyTurnstile(body.turnstileToken, c.env, requestIp(c))
  if (body.invitationToken?.trim()) {
    try {
      await startInvitationEmailClaim({ c, rawInvitationToken: body.invitationToken })
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        (error.code !== 'invitation_invalid' && error.code !== 'invitation_expired')
      ) {
        throw error
      }
    }
    return c.json({ nextStep: 'verify_email' })
  }
  const entryTenant = c.get('tenant')
  const entryIdentifier = entryTenant.resolution?.unresolvedRoot
    ? loginHintCandidates(rawIdentifier)
    : parseIdentifier(entryTenant, rawIdentifier)
  const tenant = await resolveEntryTenant(c, entryIdentifier, body.organizationId, {
    intent: flow.intent,
    applicationClientId: flow.applicationClientId,
  })
  const identifier = parseIdentifier(tenant, rawIdentifier)
  const password = body.password ?? ''
  if (!identifier.value || !password) throw new AppError('invalid_credentials')

  return withTenant(c, tenant, async () => {
    // 失败限流前置(account=identifier + IP);超限抛 rate_limited(枚举防护:与失败同模糊层)。
    await enforceVerifyRateLimit({
      env: c.env,
      tenantId: tenant.tenantId,
      scope: 'password',
      account: identifier.value,
      ip: requestIp(c),
    })

    const db = createTenantDb(c.env.DB, tenant)
    const user = await resolveUserByIdentifier(db, identifier)
    const rememberMe = resolveRememberMe(tenant, body.rememberMe)
    const response = user
      ? await signInWithPassword(c, tenant, { db, user, identifier, password, rememberMe, flow })
      : await signUpWithPassword({
          c,
          tenant,
          db,
          identifier,
          password,
          rememberMe,
          profileInput: body,
          flow,
        })
    return c.json(response)
  })
}

export async function handlePasswordSignIn(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  // 坏 JSON 与凭证错误同响应:不暴露解析层细节(枚举防护)。
  if (!json.ok) throw new AppError('invalid_credentials')
  const body = validateCredentialBody(passwordAuthBodySchema, json.value, {
    code: 'invalid_credentials',
    credentialFields: ['identifier', 'password'],
  })
  return handlePasswordAuth(c, body)
}

// 异步 HIBP 检查:命中则在 passwords.breached 置 true(不阻断本次登录)。
async function markBreachedIfPwned(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  userId: string,
  password: string,
): Promise<void> {
  if (!(await checkHibpBreached(password))) return
  const db = createTenantDb(c.env.DB, tenant)
  await db.passwords.update(
    { breached: true, breachCheckedAt: new Date() },
    eq(schema.passwords.userId, userId),
  )
}
