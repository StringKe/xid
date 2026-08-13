// magic-link.ts:Email magic link passwordless 认证 handler。
// token = instance ES256 签名 JWT(sub/exp/jti),15min 单次有效(01 章 4)。
// server 只存 jti SHA-256 哈希(magicLinkTokens.tokenHash)用于作废;token 明文不入 DB。
// 限流:同一邮箱 1/min + 5/hour(RateLimitStore DO,anti-abuse rule)。
// 枚举防护:邮箱不存在与已发送统一模糊响应(01 章 7 / anti-abuse rule)。

import { base64UrlEncode, sha256Hex, signJwt, verifyJwt } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import type { JwtClaims } from '@xid-kit/crypto'
import { and, eq, gt, isNotNull, isNull, lte, or } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
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
  createPasswordlessEmailUser,
  markPrimaryEmailVerified,
  shouldSkipDefaultMembership,
} from '../me-auth/passwordless-users'
import { resolveTokenTenant } from '../me-auth/token-tenant'
import { recordAuthTokenIssued } from './token-audit'
import { resolvePostAuthMfaGate } from '../lib/mfa-session'
import { reserveRateLimitWindows } from '../lib/rate-limit'
import { MAGIC_LINK_TTL_MS } from '../lib/ttl'
import { SEND_PER_HOUR_POLICY } from '../me-auth/shared'
import { readJsonBody, validateCredentialBody } from '../lib/validate'
import {
  createPasswordlessFlowContext,
  parsePasswordlessFlowContext,
  serializePasswordlessFlowContext,
  type PasswordlessFlowContext,
} from './passwordless-flow'

// 限流:1/min per 邮箱
const RL_PER_MIN_KEY = (email: string, tenantId: string) => `ml:min:${tenantId}:${email}`
// 限流:5/hour per 邮箱
const RL_PER_HOUR_KEY = (email: string, tenantId: string) => `ml:hour:${tenantId}:${email}`

const VERIFY_REDIRECT_HEADERS = { 'cache-control': 'no-store' } as const

type SignMagicTokenInput = {
  tenantIssuer: string
  signer: Awaited<ReturnType<typeof loadActiveSigner>>
  userId: string
  action: MagicLinkAction
  tenantId: string
  flow: PasswordlessFlowContext
}

type MagicLinkAction = 'login' | 'user_creation'

async function resolveMagicLinkTenant(
  c: Context<XidHonoEnv>,
  rawToken: string,
): Promise<TenantVar> {
  return resolveTokenTenant(c, rawToken, 'magic_link_invalid')
}

function noStoreRedirect(c: Context<XidHonoEnv>, url: string): Response {
  const res = c.redirect(url, 303)
  res.headers.set('cache-control', VERIFY_REDIRECT_HEADERS['cache-control'])
  return res
}

function magicLinkConfirmationUrl(tenant: TenantVar, rawToken: string): string {
  const redirectUrl = new URL('/magic-link', hostedAuthOriginForTenant(tenant))
  redirectUrl.hash = new URLSearchParams({ token: rawToken }).toString()
  return redirectUrl.toString()
}

function magicLinkErrorUrl(c: Context<XidHonoEnv>): string {
  return new URL('/magic-link', c.req.url).toString()
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
    flow_context: serializePasswordlessFlowContext(opts.flow),
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
  intent?: string | null
  applicationClientId?: string | null
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
  // Raw invitation tokens belong exclusively to the proof-first invitation claim route.
  // Fail before rate-limit reservations, account lookup, user creation, or token issuance.
  if (options.invitationToken?.trim()) throw new AppError('invalid_request')

  // 限流检查(枚举防护:限流后仍返回 200 不泄露邮箱是否存在)
  await reserveRateLimitWindows(c.env, `ml:send:${tenant.tenantId}:${email}`, [
    { key: RL_PER_MIN_KEY(email, tenant.tenantId), policy: POLICIES.OTP_SEND },
    { key: RL_PER_HOUR_KEY(email, tenant.tenantId), policy: SEND_PER_HOUR_POLICY },
  ])

  const db = createTenantDb(c.env.DB, tenant)
  const flow = createPasswordlessFlowContext({
    intent: options.intent,
    continuePath: options.continuePath,
    applicationClientId: options.applicationClientId,
  })
  const skipDefaultMembership =
    options.skipDefaultMembership ??
    shouldSkipDefaultMembership({
      redirectAfterLogin: flow.continuePath,
      intent: flow.intent,
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
        d1: c.env.DB,
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
    flow,
  })
  // 只存 jti 的 SHA-256 哈希,token 明文不入 DB(01 章 / password-auth rule)。
  const tokenHash = await sha256Hex(jti)

  const now = new Date()
  await db.magicLinkTokens.hardDelete(
    and(
      eq(schema.magicLinkTokens.userId, userId),
      or(isNotNull(schema.magicLinkTokens.consumedAt), lte(schema.magicLinkTokens.expiresAt, now)),
    ),
  )
  await db.magicLinkTokens.insert({
    id: crypto.randomUUID(),
    tenantId: tenant.tenantId,
    userId,
    tokenHash,
    flowContext: serializePasswordlessFlowContext(flow),
    expiresAt: new Date(now.getTime() + MAGIC_LINK_TTL_MS),
  })
  await recordAuthTokenIssued({
    env: c.env,
    tenant,
    purpose: 'magic_link',
    userId,
    kid: signer.kid,
  })

  // 异步发邮件(不阻塞主链路,见 cloudflare-bindings rule)。
  await c.env.EMAIL_QUEUE.send({
    type: 'magic_link',
    recipient: email,
    payload: {
      tenantId: tenant.tenantId,
      userId,
      token,
      link: magicLinkConfirmationUrl(tenant, token),
      expires: 15,
      expiresInMin: 15,
    },
  })
}

// 验签 magic link JWT:签名(租户公钥集)+ exp + iss,提取 jti。失败抛 magic_link_*。
async function verifyMagicJwt(
  tenant: TenantVar,
  rawToken: string,
): Promise<{
  jti: string
  userId: string
  action: MagicLinkAction
  flow: PasswordlessFlowContext
}> {
  const verifyKeys = await buildVerifyKeySet(tenant)
  const verified = await verifyJwt(rawToken, verifyKeys, { expectedIssuer: tenant.issuer })
  if (!verified.ok) {
    throw new AppError(
      verified.error.reason === 'expired' ? 'magic_link_expired' : 'magic_link_invalid',
    )
  }
  const { sub: userId, jti, purpose, action, flow_context: rawFlowContext } = verified.value.payload
  if (!userId || !jti || purpose !== 'magic_link') throw new AppError('magic_link_invalid')
  if (action !== 'login' && action !== 'user_creation') throw new AppError('magic_link_invalid')
  if (typeof rawFlowContext !== 'string') throw new AppError('magic_link_invalid')
  return {
    jti,
    userId,
    action,
    flow: parsePasswordlessFlowContext(rawFlowContext, 'magic_link_invalid'),
  }
}

// jti 一次性消费:按 tokenHash 查行 + 状态校验 + 标记 consumed,返回绑定 userId(防签名有效 token 重放)。
async function consumeMagicToken(
  db: ReturnType<typeof createTenantDb>,
  jti: string,
  signedUserId: string,
  signedFlow: PasswordlessFlowContext,
): Promise<string> {
  const tokenHash = await sha256Hex(jti)
  const ledgerRow = await db.magicLinkTokens.findOne(
    eq(schema.magicLinkTokens.tokenHash, tokenHash),
  )
  const legacyRow = ledgerRow
    ? undefined
    : await db.verificationTokens.findOne(eq(schema.verificationTokens.tokenHash, tokenHash))
  const tokenRow = ledgerRow ?? legacyRow
  if (!tokenRow || tokenRow.consumedAt !== null) throw new AppError('magic_link_invalid')
  if (tokenRow.expiresAt.getTime() <= Date.now()) throw new AppError('magic_link_expired')
  if (legacyRow && legacyRow.purpose !== 'magic_link') throw new AppError('magic_link_invalid')
  if (
    tokenRow.userId !== signedUserId ||
    tokenRow.flowContext !== serializePasswordlessFlowContext(signedFlow)
  ) {
    throw new AppError('magic_link_invalid')
  }
  const consumed = ledgerRow
    ? await db.magicLinkTokens.update(
        { consumedAt: new Date() },
        and(
          eq(schema.magicLinkTokens.tokenHash, tokenHash),
          isNull(schema.magicLinkTokens.consumedAt),
          gt(schema.magicLinkTokens.expiresAt, new Date()),
        ),
      )
    : await db.verificationTokens.update(
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
const magicLinkVerifyBodySchema = v.object({ token: v.pipe(v.string(), v.minLength(1)) })

// 存量 query-string 链接只做 Hosted UI 跳转。GET 永不验签、消费 token 或签发 session。
export async function handleMagicLinkVerifyRedirect(c: Context<XidHonoEnv>): Promise<Response> {
  const query = v.safeParse(magicLinkVerifyQuerySchema, { token: c.req.query('token') })
  if (!query.success) return noStoreRedirect(c, magicLinkErrorUrl(c))
  const rawToken = query.output.token
  let tenant: TenantVar
  try {
    tenant = await resolveMagicLinkTenant(c, rawToken)
  } catch (error) {
    if (error instanceof AppError && error.code === 'magic_link_invalid') {
      return noStoreRedirect(c, magicLinkErrorUrl(c))
    }
    throw error
  }
  return noStoreRedirect(c, magicLinkConfirmationUrl(tenant, rawToken))
}

export async function handleMagicLinkVerify(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('magic_link_invalid')
  const body = validateCredentialBody(magicLinkVerifyBodySchema, json.value, {
    code: 'magic_link_invalid',
    credentialFields: ['token'],
  })
  const rawToken = body.token
  const tenant = await resolveMagicLinkTenant(c, rawToken)

  // 失败限流:IP 级 50/min(account 未知,仅按 IP,anti-abuse rule)。
  await enforceVerifyRateLimit({
    env: c.env,
    tenantId: tenant.tenantId,
    scope: 'magic_link',
    account: null,
    ip: c.req.header('cf-connecting-ip') ?? null,
  })

  return withTenant(c, tenant, async () => {
    const { jti, userId: signedUserId, action, flow } = await verifyMagicJwt(tenant, rawToken)
    // Legacy magic-link tokens carrying an invitation continuation must never consume or accept it.
    if (flow.invitationId) throw new AppError('magic_link_invalid')
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
    const userId = await consumeMagicToken(db, jti, signedUserId, flow)
    await markPrimaryEmailVerified(db, userId)

    const now = new Date()
    const sessionId = createPersistedId('session')
    const continuePath = flow.continuePath
    const mfaGate = await resolvePostAuthMfaGate(c, tenant, { userId, returnPath: continuePath })
    await issueSession(c, {
      sessionId,
      userId,
      ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
      authContext: MAGIC_LINK_AUTH_CONTEXT,
      authenticatedAt: now,
      ip: c.req.header('cf-connecting-ip') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
    })

    return c.json({ redirectUrl: mfaGate.redirectUrl ?? flow.continuePath })
  })
}
