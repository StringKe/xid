// magic-link.ts:Email magic link passwordless 认证 handler。
// token = HMAC-SHA256 签名 JWT(sub/exp/jti),15min 单次有效(01 章 4)。
// server 只存 jti SHA-256 哈希(verificationTokens.tokenHash)用于作废;token 明文不入 DB。
// 限流:同一邮箱 1/min + 5/hour(RateLimitStore DO,anti-abuse rule)。
// 枚举防护:邮箱不存在与已发送统一模糊响应(01 章 7 / anti-abuse rule)。

import { base64UrlEncode, sha256Hex, signJwt, verifyJwt } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import type { JwtClaims } from '@xid-kit/crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { issueSession } from '../lib/session'
import { MAGIC_LINK_AUTH_CONTEXT } from '../lib/auth-context'
import { hostedAuthOriginForTenant } from '../lib/hosted-origin'
import { POLICIES } from '../durable-objects/rate-limit-store'
import { buildVerifyKeySet, loadActiveSigner } from '../oidc/shared'
import { enforceVerifyRateLimit } from '../lib/verify-rate-limit'
import { assertEmailAllowed, assertMethodAllowed, assertMethodAvailable } from './hosted-policy'
import { auditPolicyDeniedError } from './hosted-audit'
import { normalizeProfileFields } from './profile-fields'
import type { ProfileFieldInput } from './profile-fields'
import {
  acceptInvitationByToken,
  invitationAcceptContinuePath,
  loadPrimaryEmailForUserId,
  requirePendingInvitationForEmail,
} from './invitations'
import {
  createPasswordlessEmailUser,
  markPrimaryEmailVerified,
  shouldSkipDefaultMembership,
} from '../me-auth/passwordless-users'
import { resolveTokenTenant } from '../me-auth/token-tenant'
import { recordAuthTokenIssued } from './token-audit'
import { resolvePostAuthMfaGate } from '../lib/mfa-session'
import { replaceActiveVerificationToken, reserveRateLimitWindows } from './otp'
import { MAGIC_LINK_TTL_MS } from '../lib/ttl'
import { SEND_PER_HOUR_POLICY } from '../me-auth/shared'

// 限流:1/min per 邮箱
const RL_PER_MIN_KEY = (email: string, tenantId: string) => `ml:min:${tenantId}:${email}`
// 限流:5/hour per 邮箱
const RL_PER_HOUR_KEY = (email: string, tenantId: string) => `ml:hour:${tenantId}:${email}`

const DEFAULT_MAGIC_LINK_CONTINUE_PATH = '/console'
const VERIFY_REDIRECT_HEADERS = { 'cache-control': 'no-store' } as const

type SignMagicTokenInput = {
  tenantIssuer: string
  signer: Awaited<ReturnType<typeof loadActiveSigner>>
  userId: string
  action: MagicLinkAction
  tenantId: string
}

type MagicLinkAction = 'login' | 'user_creation'

async function resolveMagicLinkTenant(
  c: Context<XidHonoEnv>,
  rawToken: string,
): Promise<TenantVar> {
  return resolveTokenTenant(c, rawToken, 'magic_link_invalid')
}

function safeContinuePath(value: string | undefined): string {
  if (!value) return DEFAULT_MAGIC_LINK_CONTINUE_PATH
  if (!value.startsWith('/') || value.startsWith('//')) return DEFAULT_MAGIC_LINK_CONTINUE_PATH
  try {
    const parsed = new URL(value, 'https://xid.local')
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return DEFAULT_MAGIC_LINK_CONTINUE_PATH
  }
}

function magicLinkHostedOrigin(tenant: TenantVar): string {
  return new URL(hostedAuthOriginForTenant(tenant)).origin
}

function noStoreRedirect(c: Context<XidHonoEnv>, url: string): Response {
  const res = c.redirect(url, 302)
  res.headers.set('cache-control', VERIFY_REDIRECT_HEADERS['cache-control'])
  return res
}

function shouldRedirectToHostedAuthOrigin(c: Context<XidHonoEnv>, tenant: TenantVar): boolean {
  return new URL(c.req.url).origin !== magicLinkHostedOrigin(tenant)
}

function magicLinkHostedAuthRedirect(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  rawToken: string,
): Response {
  const redirectUrl = new URL('/auth/magic-link/verify', hostedAuthOriginForTenant(tenant))
  redirectUrl.searchParams.set('token', rawToken)
  const continuePath = c.req.query('continue')
  if (continuePath) redirectUrl.searchParams.set('continue', safeContinuePath(continuePath))
  return noStoreRedirect(c, redirectUrl.toString())
}

async function withTenant<T>(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = c.get('tenant')
  c.set('tenant', tenant)
  try {
    return await fn()
  } finally {
    c.set('tenant', previous)
  }
}

// 用租户 active 签名密钥(ES256 默认)签 magic link JWT。
// jti = 32 字节随机 base64url;sub = userId;exp = now + 15min。
async function signMagicToken(opts: SignMagicTokenInput): Promise<{ token: string; jti: string }> {
  const { tenantIssuer, signer, userId, action } = opts
  const jti = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const now = Math.floor(Date.now() / 1000)
  const payload: JwtClaims = {
    iss: tenantIssuer,
    sub: userId,
    jti,
    iat: now,
    exp: now + MAGIC_LINK_TTL_MS / 1000,
    purpose: 'magic_link',
    action,
    tenant_id: opts.tenantId,
  }
  const token = await signJwt(
    { header: { alg: signer.alg, kid: signer.kid }, payload },
    signer.privateKey,
  )
  return { token, jti }
}

export type SendMagicLinkOptions = {
  profileInput?: ProfileFieldInput
  invitationToken?: string | null
  skipDefaultMembership?: boolean
  continuePath?: string | null
}

// magic link 发送核心:限流 + 枚举防护 + 签 token + 存 jti 哈希 + 入队发信。
// 抽出供 me-auth /auth/magic-link/send(前置 turnstileToken 校验)复用,单一真相源。
export async function sendMagicLink(
  c: Context<XidHonoEnv>,
  email: string,
  options: SendMagicLinkOptions = {},
): Promise<void> {
  const profileInput = options.profileInput ?? {}
  const tenant = c.get('tenant')

  // 限流检查(枚举防护:限流后仍返回 200 不泄露邮箱是否存在)
  await reserveRateLimitWindows(c.env, `ml:send:${tenant.tenantId}:${email}`, [
    { key: RL_PER_MIN_KEY(email, tenant.tenantId), policy: POLICIES.OTP_SEND },
    { key: RL_PER_HOUR_KEY(email, tenant.tenantId), policy: SEND_PER_HOUR_POLICY },
  ])

  const db = createTenantDb(c.env.DB, tenant)
  if (options.invitationToken) {
    await requirePendingInvitationForEmail(db, options.invitationToken, email)
  }
  const skipDefaultMembership =
    options.skipDefaultMembership ??
    shouldSkipDefaultMembership({
      redirectAfterLogin: options.continuePath,
      invitationToken: options.invitationToken,
    })

  // 枚举防护:无论用户存在与否,接口均返回 200(不区分"不存在"与"已发送")。
  try {
    assertMethodAvailable(tenant, 'magicLink')
    assertEmailAllowed(tenant, email)
  } catch (error) {
    await auditPolicyDeniedError(c, error, {
      tenant,
      method: 'magicLink',
      action: 'availability',
      identifier: { type: 'email', value: email },
    })
    return
  }
  const emailRow = await db.userEmails.findOne(eq(schema.userEmails.email, email))
  let userId = emailRow?.userId ?? null
  let action: MagicLinkAction = 'login'
  if (userId) {
    try {
      assertMethodAllowed(tenant, 'magicLink', 'login')
    } catch (error) {
      await auditPolicyDeniedError(c, error, {
        tenant,
        method: 'magicLink',
        action: 'login',
        identifier: { type: 'email', value: email },
      })
      return
    }
  }
  if (!userId) {
    try {
      assertMethodAllowed(tenant, 'magicLink', 'user_creation')
      assertEmailAllowed(tenant, email)
      const profile = normalizeProfileFields(tenant, profileInput, { email })
      userId = await createPasswordlessEmailUser({
        db,
        tenantId: tenant.tenantId,
        email,
        profile,
        skipDefaultMembership,
      })
      action = 'user_creation'
    } catch (error) {
      await auditPolicyDeniedError(c, error, {
        tenant,
        method: 'magicLink',
        action: 'user_creation',
        identifier: { type: 'email', value: email },
      })
      return
    }
  }

  const signer = await loadActiveSigner(tenant, c.env.KEK)

  const { token, jti } = await signMagicToken({
    tenantIssuer: tenant.issuer,
    signer,
    userId,
    action,
    tenantId: tenant.tenantId,
  })
  // 只存 jti 的 SHA-256 哈希,token 明文不入 DB(01 章 / password-auth rule)。
  const tokenHash = await sha256Hex(jti)

  await replaceActiveVerificationToken({
    db,
    channel: null,
    purpose: 'magic_link',
    values: {
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      userId,
      tokenHash,
      purpose: 'magic_link',
      expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
    },
  })
  await recordAuthTokenIssued({
    env: c.env,
    tenant,
    purpose: 'magic_link',
    userId,
    kid: signer.kid,
  })

  const verifyUrl = new URL('/auth/magic-link/verify', hostedAuthOriginForTenant(tenant))
  verifyUrl.searchParams.set('token', token)
  const continuePath = options.continuePath ?? null
  if (continuePath) verifyUrl.searchParams.set('continue', safeContinuePath(continuePath))
  if (options.invitationToken) {
    verifyUrl.searchParams.set('invitation_token', options.invitationToken.trim())
  }

  // 异步发邮件(不阻塞主链路,见 cloudflare-bindings rule)。
  await c.env.EMAIL_QUEUE.send({
    type: 'magic_link',
    recipient: email,
    payload: {
      tenantId: tenant.tenantId,
      userId,
      token,
      link: verifyUrl.toString(),
      expires: 15,
      expiresInMin: 15,
    },
  })
}

// 验签 magic link JWT:签名(租户公钥集)+ exp + iss,提取 jti。失败抛 magic_link_*。
async function verifyMagicJwt(
  tenant: TenantVar,
  rawToken: string,
): Promise<{ jti: string; action: MagicLinkAction }> {
  const verifyKeys = await buildVerifyKeySet(tenant)
  const verified = await verifyJwt(rawToken, verifyKeys, { expectedIssuer: tenant.issuer })
  if (!verified.ok) {
    throw new AppError(
      verified.error.reason === 'expired' ? 'magic_link_expired' : 'magic_link_invalid',
    )
  }
  const { sub: userId, jti, purpose, action } = verified.value.payload
  if (!userId || !jti || purpose !== 'magic_link') throw new AppError('magic_link_invalid')
  if (action !== 'login' && action !== 'user_creation') throw new AppError('magic_link_invalid')
  return { jti, action }
}

// jti 一次性消费:按 tokenHash 查行 + 状态校验 + 标记 consumed,返回绑定 userId(防签名有效 token 重放)。
async function consumeMagicToken(
  db: ReturnType<typeof createTenantDb>,
  jti: string,
): Promise<string> {
  const tokenHash = await sha256Hex(jti)
  const tokenRow = await db.verificationTokens.findOne(
    eq(schema.verificationTokens.tokenHash, tokenHash),
  )
  if (!tokenRow || tokenRow.consumedAt !== null) throw new AppError('magic_link_invalid')
  if (tokenRow.expiresAt.getTime() <= Date.now()) throw new AppError('magic_link_expired')
  if (tokenRow.purpose !== 'magic_link') throw new AppError('magic_link_invalid')
  const consumed = await db.verificationTokens.update(
    { consumedAt: new Date() },
    and(
      eq(schema.verificationTokens.tokenHash, tokenHash),
      eq(schema.verificationTokens.purpose, 'magic_link'),
      isNull(schema.verificationTokens.consumedAt),
      gt(schema.verificationTokens.expiresAt, new Date()),
    ),
  )
  if (consumed && consumed.length === 0 && tokenRow.id) throw new AppError('magic_link_invalid')
  return tokenRow.userId
}

const magicLinkVerifyQuerySchema = v.object({ token: v.pipe(v.string(), v.minLength(1)) })

export async function handleMagicLinkVerify(c: Context<XidHonoEnv>): Promise<Response> {
  // token 是凭证:缺失/形状失败与无效 token 同 magic_link_invalid(枚举防护)。
  const query = v.safeParse(magicLinkVerifyQuerySchema, { token: c.req.query('token') })
  if (!query.success) throw new AppError('magic_link_invalid')
  const rawToken = query.output.token
  const tenant = await resolveMagicLinkTenant(c, rawToken)

  if (shouldRedirectToHostedAuthOrigin(c, tenant)) {
    return magicLinkHostedAuthRedirect(c, tenant, rawToken)
  }

  // 失败限流:IP 级 50/min(account 未知,仅按 IP,anti-abuse rule)。
  await enforceVerifyRateLimit({
    env: c.env,
    tenantId: tenant.tenantId,
    scope: 'magic_link',
    account: null,
    ip: c.req.header('cf-connecting-ip') ?? null,
  })

  return withTenant(c, tenant, async () => {
    const { jti, action } = await verifyMagicJwt(tenant, rawToken)
    try {
      assertMethodAllowed(tenant, 'magicLink', action)
    } catch (error) {
      throw await auditPolicyDeniedError(c, error, {
        tenant,
        method: 'magicLink',
        action,
      })
    }

    const db = createTenantDb(c.env.DB, tenant)
    const userId = await consumeMagicToken(db, jti)
    await markPrimaryEmailVerified(db, userId)

    const now = new Date()
    const invitationToken = c.req.query('invitation_token')
    let continuePath = safeContinuePath(c.req.query('continue'))
    if (invitationToken?.trim()) {
      continuePath = `/accept-invitation?token=${encodeURIComponent(invitationToken.trim())}`
    }
    const mfaGate = await resolvePostAuthMfaGate(c, tenant, { userId, returnPath: continuePath })
    const issued = await issueSession(c, {
      sessionId: crypto.randomUUID(),
      userId,
      ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
      authContext: MAGIC_LINK_AUTH_CONTEXT,
      authenticatedAt: now,
      ip: c.req.header('cf-connecting-ip') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
    })

    if (invitationToken && !mfaGate.redirectUrl) {
      const user = await db.users.findOne(eq(schema.users.id, userId))
      const userEmail = user
        ? await loadPrimaryEmailForUserId(db, user.id, user.primaryEmailId)
        : null
      const accepted = await acceptInvitationByToken({
        db,
        env: c.env,
        tenantId: tenant.tenantId,
        rawToken: invitationToken,
        userId,
        userEmail,
      })
      await db.sessions.update(
        { activeOrgId: accepted.orgId },
        eq(schema.sessions.id, issued.session.sessionId),
      )
      const org = await db.organizations.findOne(eq(schema.organizations.id, accepted.orgId))
      const orgName = org?.name ?? org?.slug ?? accepted.orgId
      continuePath = invitationAcceptContinuePath(accepted.orgId, orgName)
    }

    return noStoreRedirect(c, mfaGate.redirectUrl ?? continuePath)
  })
}
