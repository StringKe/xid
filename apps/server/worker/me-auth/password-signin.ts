// POST /auth/password/sign-in:统一 password 流程(前端 useSignIn passwordMutation)。
// 已有用户走 login 策略;identifier 不存在时走 user_creation 策略创建密码用户。
// 复用 auth/password.ts 纯逻辑(verifyPassword/checkHibpBreached/hashPassword)。
// 枚举防护(铁律):用户不存在 / 密码错误 / 算法解析失败统一返回 invalid_credentials,
//   且无论用户是否存在都执行等量哈希计算(verifyPassword 内 dummy 消耗),constant-time。
// 失败限流:account(identifier)10/15min + IP 50/min(enforceVerifyRateLimit)。
// 成功:issueSession 设 cookie;HIBP 异步不阻断(waitUntil)。响应 {} (前端缺 redirectUrl 时回落 continue)。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { issueSession } from '../lib/session'
import { PASSWORD_AUTH_CONTEXT } from '../lib/auth-context'
import { enforceVerifyRateLimit } from '../lib/verify-rate-limit'
import { readJsonBody, validateCredentialBody } from '../lib/validate'
import {
  checkHibpBreached,
  hashPassword,
  passwordReuseTag,
  validatePasswordLength,
  verifyPassword,
} from '../auth/password'
import { provisionAccountAtomically } from '../auth/account-provisioning'
import { requestIp, requestUserAgent, verifyTurnstile } from './shared'
import { assertEmailAllowed, assertMethodAllowed } from '../auth/hosted-policy'
import { auditPolicyDeniedError } from '../auth/hosted-audit'
import { normalizeProfileFields } from '../auth/profile-fields'
import type { NormalizedProfileFields, ProfileFieldInput } from '../auth/profile-fields'
import { isHostedAuthIntent, isProductSignUpIntent } from '../../shared/hosted-auth-intent'
import { resolveHostedAuthFlow } from '../../shared/hosted-auth-continuation'
import { issueEmailVerification } from './email-verify-token'
import { loginHintCandidates, resolveEntryTenant, withTenant } from './instance-login'
import { shouldSkipDefaultMembership } from './passwordless-users'
import { loadGuestConversionContext, markGuestConverted } from './guest-conversion'
import type { GuestConversionContext } from './guest-conversion'
import {
  postAuthRedirectPath,
  resolvePostAuthMfaGate,
  sanitizeLocalReturn,
} from '../lib/mfa-session'
import { startInvitationEmailClaim } from './invitation-claim'

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

export type PasswordAuthBody = v.InferOutput<typeof passwordAuthBodySchema>

type PasswordNextStep = 'verify_email' | 'complete'
type PasswordAuthResponse = { redirectUrl?: string; nextStep?: PasswordNextStep }
type IdentifierKind = 'email' | 'username' | 'phone' | 'external_id'
type ParsedIdentifier = { kind: IdentifierKind; value: string }
type ResolvedUser = {
  userId: string
  status: string
  deletedAt: Date | null
  lockoutUntil: Date | null
  primaryEmailId: string | null
}

// Password 创建默认要求 email verification。username/phone/external_id 创建必须在策略里关闭 email verification。
const REQUIRE_EMAIL_VERIFICATION = true

// rememberMe 生效链:body 显式值 -> 策略 rememberMeDefault -> false。
// schema 已收窄为 boolean|undefined,非法类型在入口被 422 拦截,此处无需再判型。
function resolveRememberMe(tenant: TenantVar, requested: boolean | undefined): boolean {
  return requested ?? tenant.policy?.session?.rememberMeDefault ?? false
}

function auditIdentifier(identifier: ParsedIdentifier): { type: IdentifierKind; value: string } {
  return { type: identifier.kind, value: identifier.value }
}

function parseIdentifier(tenant: TenantVar, rawIdentifier: string): ParsedIdentifier {
  const policy = tenant.policy?.hostedAuth
  const mode = policy?.identifierMode ?? 'email'
  const trimmed = rawIdentifier.trim()
  const lower = trimmed.toLowerCase()
  if (mode === 'email') return { kind: 'email', value: lower }
  if (mode === 'username') return { kind: 'username', value: lower }
  if (mode === 'phone') return { kind: 'phone', value: trimmed }
  if (mode === 'external_id') return { kind: 'external_id', value: trimmed }
  return lower.includes('@') ? { kind: 'email', value: lower } : { kind: 'username', value: lower }
}

function identifierProfile(identifier: ParsedIdentifier): ProfileFieldInput {
  if (identifier.kind === 'email') return { email: identifier.value }
  if (identifier.kind === 'username') return { username: identifier.value }
  if (identifier.kind === 'phone') return { phone: identifier.value }
  return {}
}

function passwordRequiresEmailVerification(tenant: TenantVar): boolean {
  const hostedPolicy = tenant.policy?.hostedAuth
  return (
    hostedPolicy?.password?.requireEmailVerification ??
    hostedPolicy?.requireVerifiedEmail ??
    REQUIRE_EMAIL_VERIFICATION
  )
}

// 按 identifierMode 解析 userId + 状态。不存在返回 null(调用方仍走等时哈希)。
async function resolveUserByIdentifier(
  db: ReturnType<typeof createTenantDb>,
  identifier: ParsedIdentifier,
): Promise<ResolvedUser | null> {
  const emailRow =
    identifier.kind === 'email'
      ? await db.userEmails.findOne(eq(schema.userEmails.email, identifier.value))
      : undefined
  const phoneRow =
    identifier.kind === 'phone'
      ? await db.userPhones.findOne(eq(schema.userPhones.phone, identifier.value))
      : undefined
  const byUser = emailRow
    ? await db.users.findOne(
        and(eq(schema.users.id, emailRow.userId), isNull(schema.users.deletedAt)),
      )
    : phoneRow
      ? await db.users.findOne(
          and(eq(schema.users.id, phoneRow.userId), isNull(schema.users.deletedAt)),
        )
      : identifier.kind === 'username'
        ? await db.users.findOne(
            and(eq(schema.users.username, identifier.value), isNull(schema.users.deletedAt)),
          )
        : await db.users.findOne(
            and(eq(schema.users.externalId, identifier.value), isNull(schema.users.deletedAt)),
          )
  if (!byUser) return null
  return {
    userId: byUser.id,
    status: byUser.status,
    deletedAt: byUser.deletedAt ?? null,
    lockoutUntil: byUser.lockoutUntil ?? null,
    primaryEmailId: byUser.primaryEmailId ?? null,
  }
}

// 密码校验(constant-time):取 password 行 -> verifyPassword;无行时用占位 hash 等时消耗。
const DUMMY_ARGON2 =
  '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

async function verifyUserPassword(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  user: ResolvedUser | null,
  password: string,
): Promise<boolean> {
  const db = createTenantDb(c.env.DB, tenant)
  const pwRow = user
    ? await db.passwords.findOne(eq(schema.passwords.userId, user.userId))
    : undefined
  const hash = pwRow?.hash ?? DUMMY_ARGON2
  const algo = pwRow?.algo ?? 'argon2id'
  const valid = await verifyPassword(password, hash, algo, c.env.PEPPER)
  // 不存在用户 / 无密码行:即使 verifyPassword 偶然为真也判定失败(防 dummy 命中)。
  if (!user || !pwRow) return false
  if (!valid) return false
  return true
}

async function createUserWithPassword(opts: {
  c: Context<XidHonoEnv>
  tenant: TenantVar
  db: ReturnType<typeof createTenantDb>
  identifier: ParsedIdentifier
  password: string
  rememberMe: boolean
  profileInput: ProfileFieldInput
  intent?: string | null
  continueParam?: string | null
  applicationClientId?: string | null
}): Promise<PasswordAuthResponse> {
  const {
    c,
    tenant,
    db,
    identifier,
    password,
    rememberMe,
    profileInput,
    intent,
    continueParam,
    applicationClientId,
  } = opts
  const skipDefaultMembership = shouldSkipDefaultMembership({
    redirectAfterLogin: continueParam,
    intent,
  })
  let profile
  try {
    assertMethodAllowed(tenant, 'password', 'user_creation')
    if (identifier.kind === 'email') assertEmailAllowed(tenant, identifier.value)
    profile = normalizeProfileFields(tenant, profileInput, identifierProfile(identifier))
    if (profile.email) assertEmailAllowed(tenant, profile.email)
  } catch (error) {
    const policyError = await auditPolicyDeniedError(c, error, {
      tenant,
      method: 'password',
      action: 'user_creation',
      identifier: auditIdentifier(identifier),
    })
    if (policyError.policyReason === 'profile_field_required') {
      throw new AppError('validation_failed')
    }
    throw policyError
  }

  const lengthCheck = validatePasswordLength(password)
  if (!lengthCheck.ok) {
    throw new AppError('validation_failed', { meta: { paramName: 'password' } })
  }
  if (await checkHibpBreached(password)) throw new AppError('password_breached')

  const requireEmailVerification = passwordRequiresEmailVerification(tenant)
  if (requireEmailVerification && !profile.email) {
    throw new AppError('invalid_credentials')
  }

  // guest 转正:持有效 guest session 时不新建 user,凭证挂到当前 guest user。
  // email 已被本租户其他 user 占用时走不到这里(resolveUserByIdentifier 命中 -> 登录路径
  // -> invalid_credentials),枚举防护口径不变。
  const guest = await loadGuestConversionContext(c, db)
  if (guest) {
    return convertGuestWithPassword({
      c,
      tenant,
      db,
      guest,
      identifier,
      password,
      rememberMe,
      profile,
      requireEmailVerification,
      intent,
      continueParam,
      applicationClientId,
    })
  }

  const userId = createPersistedId('user')
  const emailId = profile.email ? crypto.randomUUID() : null
  const phoneId = profile.phone ? crypto.randomUUID() : null
  const passwordProvisioning = requireEmailVerification
    ? null
    : await (async () => {
        const passwordHash = await hashPassword(password, c.env.PEPPER)
        return {
          id: crypto.randomUUID(),
          hash: passwordHash.hash,
          algo: passwordHash.algo,
          pepperVersion: passwordHash.pepperVersion,
          reuseTag: await passwordReuseTag(password, c.env.PEPPER),
        }
      })()
  await provisionAccountAtomically({
    d1: c.env.DB,
    tenantId: tenant.tenantId,
    user: {
      id: userId,
      username: profile.username,
      externalId: identifier.kind === 'external_id' ? identifier.value : null,
      primaryEmailId: emailId,
      primaryPhoneId: phoneId,
      firstName: profile.firstName,
      lastName: profile.lastName,
      displayName: profile.displayName,
      profileCompletionStatus: profile.profileCompletionStatus,
      provisionedBy: 'hosted_password',
      isNewUser: true,
    },
    primaryEmail:
      profile.email && emailId
        ? {
            id: emailId,
            email: profile.email,
            verified: false,
            verificationStatus: 'unverified',
          }
        : null,
    primaryPhone:
      profile.phone && phoneId
        ? {
            id: phoneId,
            phone: profile.phone,
            verified: false,
            verificationStatus: 'unverified',
          }
        : null,
    password: passwordProvisioning,
    defaultMembership:
      requireEmailVerification || skipDefaultMembership
        ? null
        : {
            id: createPersistedId('membership'),
            orgId: tenant.tenantId,
          },
  })

  if (requireEmailVerification && profile.email) {
    await issueEmailVerification({
      env: c.env,
      tenant,
      userId,
      email: profile.email,
      ...(isHostedAuthIntent(intent) ? { intent } : {}),
      ...(continueParam ? { continuePath: continueParam } : {}),
      ...(applicationClientId ? { applicationClientId } : {}),
    })
    return { nextStep: 'verify_email' }
  }

  const returnPath = postAuthRedirectPath({ intent, continueParam })
  const now = new Date()
  const mfaGate = await resolvePostAuthMfaGate(c, tenant, { userId, returnPath })
  const sessionId = createPersistedId('session')
  await issueSession(c, {
    sessionId,
    userId,
    ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
    authContext: PASSWORD_AUTH_CONTEXT,
    authenticatedAt: now,
    rememberMe,
    ip: requestIp(c),
    userAgent: requestUserAgent(c),
  })
  if (mfaGate.redirectUrl) {
    return { nextStep: 'complete', redirectUrl: mfaGate.redirectUrl }
  }
  const redirectUrl = resolvePasswordSignInRedirect({ intent, continueParam })
  return { nextStep: 'complete', ...(redirectUrl ? { redirectUrl } : {}) }
}

// guest 转正(password 仪式):email/phone 挂为未验证主联系方式,补写 profile 列,写 passwords 行,
// 然后走统一转正钩子。与新建路径的差异:不 insert users、不补默认 membership(guest 已有账号);
// session 一律轮换签发 -- guest 原本就持 session,只吊销不补发会把用户踢成匿名态。
async function convertGuestWithPassword(opts: {
  c: Context<XidHonoEnv>
  tenant: TenantVar
  db: ReturnType<typeof createTenantDb>
  guest: GuestConversionContext
  identifier: ParsedIdentifier
  password: string
  rememberMe: boolean
  profile: NormalizedProfileFields
  requireEmailVerification: boolean
  intent?: string | null
  continueParam?: string | null
  applicationClientId?: string | null
}): Promise<PasswordAuthResponse> {
  const {
    c,
    tenant,
    db,
    guest,
    identifier,
    password,
    rememberMe,
    profile,
    requireEmailVerification,
    intent,
    continueParam,
    applicationClientId,
  } = opts
  const userId = guest.userId
  const emailId = profile.email ? crypto.randomUUID() : null
  const phoneId = profile.phone ? crypto.randomUUID() : null
  if (profile.email && emailId) {
    await db.userEmails.insert({
      id: emailId,
      tenantId: tenant.tenantId,
      userId,
      email: profile.email,
      verified: false,
      verificationStatus: 'unverified',
      isPrimary: true,
    })
  }
  if (profile.phone && phoneId) {
    await db.userPhones.insert({
      id: phoneId,
      tenantId: tenant.tenantId,
      userId,
      phone: profile.phone,
      verified: false,
      verificationStatus: 'unverified',
      isPrimary: true,
    })
  }
  await db.users.update(
    {
      username: profile.username,
      externalId: identifier.kind === 'external_id' ? identifier.value : null,
      primaryEmailId: emailId,
      primaryPhoneId: phoneId,
      firstName: profile.firstName,
      lastName: profile.lastName,
      displayName: profile.displayName,
      profileCompletionStatus: profile.profileCompletionStatus,
    },
    eq(schema.users.id, userId),
  )

  if (!requireEmailVerification) {
    const passwordHash = await hashPassword(password, c.env.PEPPER)
    await db.passwords.insert({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      userId,
      hash: passwordHash.hash,
      algo: passwordHash.algo,
      pepperVersion: passwordHash.pepperVersion,
      reuseTag: await passwordReuseTag(password, c.env.PEPPER),
    })
  }

  await markGuestConverted({ c, tenant, db, guest, provisionedBy: 'hosted_password' })

  if (requireEmailVerification && profile.email) {
    await issueEmailVerification({
      env: c.env,
      tenant,
      userId,
      email: profile.email,
      ...(isHostedAuthIntent(intent) ? { intent } : {}),
      ...(continueParam ? { continuePath: continueParam } : {}),
      ...(applicationClientId ? { applicationClientId } : {}),
    })
    return { nextStep: 'verify_email' }
  }
  const returnPath = postAuthRedirectPath({ intent, continueParam })
  const now = new Date()
  const mfaGate = await resolvePostAuthMfaGate(c, tenant, { userId, returnPath })
  const sessionId = createPersistedId('session')
  await issueSession(c, {
    sessionId,
    userId,
    ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
    authContext: PASSWORD_AUTH_CONTEXT,
    authenticatedAt: now,
    rememberMe,
    ip: requestIp(c),
    userAgent: requestUserAgent(c),
  })
  if (mfaGate.redirectUrl) {
    return { nextStep: 'complete', redirectUrl: mfaGate.redirectUrl }
  }
  const redirectUrl = resolvePasswordSignInRedirect({ intent, continueParam })
  return { nextStep: 'complete', ...(redirectUrl ? { redirectUrl } : {}) }
}

function resolvePasswordSignInRedirect(opts: {
  intent?: string | null
  continueParam?: string | null
}): string | undefined {
  const { intent, continueParam } = opts
  if (isProductSignUpIntent(intent)) return '/create-organization'
  if (continueParam) return sanitizeLocalReturn(continueParam)
  return undefined
}

export async function handlePasswordAuth(
  c: Context<XidHonoEnv>,
  body: PasswordAuthBody,
): Promise<Response> {
  const rawIdentifier = body.identifier ?? ''
  const flow = resolveHostedAuthFlow({
    intent: body.intent,
    continuePath: body.continue,
    applicationClientId: body.clientId,
    hasInvitation: Boolean(body.invitationToken?.trim()),
  })
  if (!flow) throw new AppError('invalid_request')
  await verifyTurnstile(body.turnstileToken, c.env, requestIp(c))
  if (body.invitationToken?.trim()) {
    try {
      await startInvitationEmailClaim({
        c,
        rawInvitationToken: body.invitationToken,
      })
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

    if (!user) {
      return c.json(
        await createUserWithPassword({
          c,
          tenant,
          db,
          identifier,
          password,
          rememberMe,
          profileInput: body,
          intent: flow.intent,
          continueParam: flow.continuePath,
          applicationClientId: flow.applicationClientId,
        }),
      )
    }

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
    if (user && user.lockoutUntil && user.lockoutUntil.getTime() > Date.now()) {
      throw new AppError('account_locked')
    }
    if (user && (user.status !== 'active' || user.deletedAt !== null)) {
      throw new AppError('account_locked')
    }

    const ok = await verifyUserPassword(c, tenant, user, password)
    if (!ok || !user) throw new AppError('invalid_credentials')

    // HIBP 登录异步检查不阻断(命中标记 breached,下次提示重置,见 password-auth rule)。
    c.executionCtx.waitUntil(markBreachedIfPwned(c, tenant, user.userId, password))

    const mustCheckPrimaryEmail = passwordRequiresEmailVerification(tenant)
    const primaryEmail = mustCheckPrimaryEmail
      ? await db.userEmails.findOne(
          user.primaryEmailId
            ? and(
                eq(schema.userEmails.id, user.primaryEmailId),
                eq(schema.userEmails.userId, user.userId),
                eq(schema.userEmails.isPrimary, true),
              )
            : and(eq(schema.userEmails.userId, user.userId), eq(schema.userEmails.isPrimary, true)),
        )
      : null
    if (
      mustCheckPrimaryEmail &&
      (!primaryEmail ||
        primaryEmail.verified !== true ||
        primaryEmail.verificationStatus !== 'verified')
    ) {
      if (!primaryEmail?.email) throw new AppError('invalid_credentials')
      await issueEmailVerification({
        env: c.env,
        tenant,
        userId: user.userId,
        email: primaryEmail.email,
        ...(flow.intent ? { intent: flow.intent } : {}),
        continuePath: flow.continuePath,
        ...(flow.applicationClientId ? { applicationClientId: flow.applicationClientId } : {}),
      })
      return c.json({ nextStep: 'verify_email' })
    }

    const sessionId = createPersistedId('session')
    const returnPath = postAuthRedirectPath({
      intent: flow.intent,
      continueParam: flow.continuePath,
    })
    const now = new Date()
    const mfaGate = await resolvePostAuthMfaGate(c, tenant, {
      userId: user.userId,
      returnPath,
    })
    await issueSession(c, {
      sessionId,
      userId: user.userId,
      ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
      authContext: PASSWORD_AUTH_CONTEXT,
      authenticatedAt: now,
      rememberMe,
      ip: requestIp(c),
      userAgent: requestUserAgent(c),
    })

    if (mfaGate.redirectUrl) {
      return c.json({ redirectUrl: mfaGate.redirectUrl })
    }

    const redirectUrl = resolvePasswordSignInRedirect({
      intent: flow.intent,
      continueParam: flow.continuePath,
    })
    return c.json(redirectUrl ? { redirectUrl } : {})
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
  const breached = await checkHibpBreached(password)
  if (!breached) return
  const db = createTenantDb(c.env.DB, tenant)
  await db.passwords.update(
    { breached: true, breachCheckedAt: new Date() },
    eq(schema.passwords.userId, userId),
  )
}
