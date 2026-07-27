// passkey.ts:WebAuthn 注册/登录 handler。
// challenge 存 WEBAUTHN_CHALLENGE DO(ChallengeStore),验证后销毁(一次性防重放)。
// 四验证:challenge(constant-time)/origin/rpIdHash/signature -- 无跳过路径(webauthn rule)。
// rpId 从 TenantContext 取,禁模块级常量(tenant-context rule)。
// sign_count 克隆检测:两 0 接受;新 <= 旧非零标记 signCountAnomaly(非拒绝,见 01 章 step 7)。
// PasskeyCredential 存 @xid-kit/db 租户查询层(自动注入 tenant_id,tenant-isolation rule)。
// 枚举防护:凭证不存在与验签失败返回相同模糊响应(01 章 认证验证 step 2)。
// challenge DO 读写 / 凭证构建与持久化等纯辅助见 passkey-helpers.ts。

import { base64UrlDecode, base64UrlEncode } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { verifyAuthentication, verifyRegistration } from '@xid-kit/webauthn'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { hostedAuthOriginForTenant } from '../lib/hosted-origin'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { issueSession } from '../lib/session'
import { readJsonBody } from '../lib/validate'
import { PASSKEY_AUTH_CONTEXT } from '../lib/auth-context'
import { enforceVerifyRateLimit } from '../lib/verify-rate-limit'
import {
  CHALLENGE_TTL_MS,
  PASSKEY_LIMIT,
  buildStoredCredential,
  consumeChallenge,
  createChallenge,
  getOrCreateAnonKey,
  persistNewCredential,
  persistSignCount,
} from './passkey-helpers'
import { assertMethodAllowed, assertTenantResolvedForWebAuthn } from './hosted-policy'
import { auditPolicyDeniedError } from './hosted-audit'
import { resolvePostAuthMfaGate, sanitizeLocalReturn } from '../lib/mfa-session'
import { loadGuestConversionContext, markGuestConverted } from '../me-auth/guest-conversion'

const passkey = new Hono<XidHonoEnv>()

// attestation/assertion body 形状:嵌套 response 字段必须是非空 base64url 字符串。
// 形状失败不落 validation_failed:与验签失败统一 invalid_credentials(枚举防护,见 01 章 step 2)。
const attestationBodySchema = v.object({
  id: v.optional(v.string()),
  rawId: v.optional(v.string()),
  response: v.object({
    clientDataJSON: v.pipe(v.string(), v.minLength(1)),
    attestationObject: v.pipe(v.string(), v.minLength(1)),
  }),
  transports: v.optional(v.array(v.string())),
  deviceName: v.optional(v.string()),
})

const assertionBodySchema = v.object({
  id: v.optional(v.string()),
  rawId: v.string(),
  response: v.object({
    clientDataJSON: v.pipe(v.string(), v.minLength(1)),
    authenticatorData: v.pipe(v.string(), v.minLength(1)),
    signature: v.pipe(v.string(), v.minLength(1)),
    userHandle: v.optional(v.string()),
  }),
  anonKey: v.pipe(v.string(), v.minLength(1)),
  sessionExpiryDays: v.optional(v.number()),
})

// ceremony body 统一入口:坏 JSON / 形状失败都映射为 invalid_credentials(不走 422,见上方注释)。
async function readCeremonyBody<TSchema extends v.GenericSchema>(
  c: Context<XidHonoEnv>,
  bodySchema: TSchema,
): Promise<v.InferOutput<TSchema>> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('invalid_credentials')
  const result = v.safeParse(bodySchema, json.value)
  if (!result.success) throw new AppError('invalid_credentials')
  return result.output
}

function resolveAttestationPreference(tenant: TenantVar): 'none' | 'indirect' | 'direct' {
  const mode = tenant.policy.hostedAuth?.attestationMode ?? 'none'
  if (mode === 'direct') return 'direct'
  if (mode === 'indirect') return 'indirect'
  return 'none'
}

async function loadTrustedAttestationRoots(
  c: Context<XidHonoEnv>,
  tenantId: string,
): Promise<string[]> {
  const fromEnv = c.env.WEBAUTHN_TRUSTED_ROOTS_PEM
  if (fromEnv)
    return fromEnv
      .split('-----END CERTIFICATE-----')
      .filter(Boolean)
      .map((part) => `${part}-----END CERTIFICATE-----`)
  const cached = c.env.CACHE ? await c.env.CACHE.get(`webauthn:trusted_roots:${tenantId}`) : null
  if (!cached) return []
  return cached
    .split('-----END CERTIFICATE-----')
    .filter(Boolean)
    .map((part) => `${part}-----END CERTIFICATE-----`)
}

function webAuthnOrigins(tenant: TenantVar, requestOrigin: string): string[] {
  return [
    ...new Set([
      tenant.issuer,
      `https://${tenant.rpId}`,
      hostedAuthOriginForTenant(tenant, requestOrigin),
      requestOrigin,
    ]),
  ]
}

function decodeWebAuthnBytes(value: string): Uint8Array {
  try {
    return base64UrlDecode(value)
  } catch {
    throw new AppError('invalid_credentials')
  }
}

async function assertResolvedWebAuthnTenant(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
): Promise<void> {
  try {
    assertTenantResolvedForWebAuthn(tenant)
    assertMethodAllowed(tenant, 'passkey', 'login')
  } catch (error) {
    throw await auditPolicyDeniedError(c, error, {
      tenant,
      method: 'passkey',
      action: 'login',
    })
  }
}

// POST /auth/passkey/register/options -- 返回 PublicKeyCredentialCreationOptions
passkey.post('/register/options', async (c) => {
  const tenant = c.get('tenant')
  const session = c.get('session')
  if (!session) throw new AppError('mfa_required', { httpStatus: 401 })
  await assertResolvedWebAuthnTenant(c, tenant)

  const anonKey = `reg:${session.userId}:${tenant.tenantId}`
  const challenge = await createChallenge(c.env, anonKey)

  const db = createTenantDb(c.env.DB, tenant)
  const existing = await db.passkeyCredentials.count(
    and(
      eq(schema.passkeyCredentials.userId, session.userId),
      isNull(schema.passkeyCredentials.revokedAt),
    ),
  )
  if (existing >= PASSKEY_LIMIT) {
    throw new AppError('validation_failed', { longMessage: 'Passkey limit reached' })
  }

  return c.json({
    challenge,
    rp: { id: tenant.rpId, name: tenant.issuer },
    user: {
      id: base64UrlEncode(new TextEncoder().encode(session.userId)),
      name: session.userId,
      displayName: session.userId,
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
      { type: 'public-key', alg: -8 },
    ],
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
    attestation: resolveAttestationPreference(tenant),
    timeout: CHALLENGE_TTL_MS,
  })
})

// POST /auth/passkey/register/verify -- 验证注册 attestation
passkey.post('/register/verify', async (c) => {
  const tenant = c.get('tenant')
  const session = c.get('session')
  if (!session) throw new AppError('mfa_required', { httpStatus: 401 })
  await assertResolvedWebAuthnTenant(c, tenant)

  const body = await readCeremonyBody(c, attestationBodySchema)

  const anonKey = `reg:${session.userId}:${tenant.tenantId}`
  const challengeVal = await consumeChallenge(c.env, anonKey)
  if (!challengeVal) throw new AppError('challenge_invalid')

  const attestationMode = tenant.policy.hostedAuth?.attestationMode ?? 'none'
  const trustedRoots = await loadTrustedAttestationRoots(c, tenant.tenantId)
  const result = await verifyRegistration(
    {
      ceremony: 'registration',
      expectedChallenge: decodeWebAuthnBytes(challengeVal),
      expectedRpId: tenant.rpId,
      expectedOrigins: webAuthnOrigins(tenant, new URL(c.req.url).origin),
      clientDataJson: decodeWebAuthnBytes(body.response.clientDataJSON),
      authenticatorData: new Uint8Array(0),
      attestationObject: decodeWebAuthnBytes(body.response.attestationObject),
    },
    {
      attestationPolicy: attestationMode,
      trustedRootsPem: trustedRoots,
    },
  )

  if (!result.ok) throw new AppError('invalid_credentials')

  const credentialIdBase64 = base64UrlEncode(result.value.credentialId)
  const db = createTenantDb(c.env.DB, tenant)
  await persistNewCredential({
    db,
    tenantId: tenant.tenantId,
    userId: session.userId,
    credentialIdBase64,
    verified: result.value,
    transports: body.transports ?? [],
    deviceName: body.deviceName ?? null,
    sessionAmr: session.amr,
  })

  // guest 转正:guest session 注册首个 passkey 成功即转正 -- 钩子改写 provisionedBy /
  // 吊销旧 guest session / 审计 / 解绑,随后按既有 MFA gate 轮换签发新 session。
  const guest = await loadGuestConversionContext(c, db)
  if (guest) {
    await markGuestConverted({ c, tenant, db, guest, provisionedBy: 'hosted_passkey' })
    const mfaGate = await resolvePostAuthMfaGate(c, tenant, {
      userId: guest.userId,
      returnPath: sanitizeLocalReturn(null),
      sessionAmr: PASSKEY_AUTH_CONTEXT.amr,
    })
    await issueSession(c, {
      sessionId: crypto.randomUUID(),
      userId: guest.userId,
      ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
      authContext: PASSKEY_AUTH_CONTEXT,
      authenticatedAt: new Date(),
      rememberMe: true,
      ip: c.req.header('cf-connecting-ip') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
    })
  }

  return c.json({ ok: true })
})

// POST /auth/passkey/login/options -- 返回 PublicKeyCredentialRequestOptions
passkey.post('/login/options', async (c) => {
  const tenant = c.get('tenant')
  try {
    assertTenantResolvedForWebAuthn(tenant)
    assertMethodAllowed(tenant, 'passkey', 'login')
  } catch (error) {
    throw await auditPolicyDeniedError(c, error, {
      tenant,
      method: 'passkey',
      action: 'login',
    })
  }
  const anonKey = getOrCreateAnonKey(c)
  const challenge = await createChallenge(c.env, `auth:${anonKey}:${tenant.tenantId}`)

  c.header(
    'Set-Cookie',
    `__Host-xid.anon=${anonKey}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${CHALLENGE_TTL_MS / 1000}`,
  )

  return c.json({
    challenge,
    rpId: tenant.rpId,
    userVerification: 'required',
    timeout: CHALLENGE_TTL_MS,
  })
})

// POST /auth/passkey/login/verify -- 验证认证 assertion
passkey.post('/login/verify', async (c) => {
  const tenant = c.get('tenant')
  try {
    assertTenantResolvedForWebAuthn(tenant)
    assertMethodAllowed(tenant, 'passkey', 'login')
  } catch (error) {
    throw await auditPolicyDeniedError(c, error, {
      tenant,
      method: 'passkey',
      action: 'login',
    })
  }

  const body = await readCeremonyBody(c, assertionBodySchema)

  const anonKey = body.anonKey
  const credentialIdBase64 = body.rawId
  // 失败限流:credentialId 账户级 10/15min + IP 级 50/min(anti-abuse rule)。
  await enforceVerifyRateLimit({
    env: c.env,
    tenantId: tenant.tenantId,
    scope: 'passkey',
    account: credentialIdBase64 || null,
    ip: c.req.header('cf-connecting-ip') ?? null,
  })

  const db = createTenantDb(c.env.DB, tenant)
  const userId = await verifyPasskeyAssertion({
    c,
    tenant,
    db,
    anonKey,
    credentialIdBase64,
    response: body.response,
  })

  const now = new Date()
  // sessionExpiryDays 是调用方显式覆盖(可短于策略默认,用于短期会话);未传时走 policy.session.absoluteTimeoutDays。
  const expiresAt =
    body.sessionExpiryDays === undefined
      ? undefined
      : new Date(now.getTime() + body.sessionExpiryDays * 24 * 60 * 60 * 1000)
  const { session } = await issueSession(c, {
    sessionId: crypto.randomUUID(),
    userId,
    authContext: PASSKEY_AUTH_CONTEXT,
    authenticatedAt: now,
    ...(expiresAt ? { expiresAt } : {}),
    rememberMe: true,
    ip: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  })

  return c.json({ sessionId: session.sessionId, userId: session.userId })
})

type AssertionResponse = {
  clientDataJSON: string
  authenticatorData: string
  signature: string
  userHandle?: string
}

// 认证 assertion 四验证编排:消费 challenge + 查凭证 + verifyAuthentication + sign_count 持久化。
// 查不到凭证与验签失败返回相同 invalid_credentials(枚举防护,01 章 step 2)。返回凭证绑定的 userId。
async function verifyPasskeyAssertion(opts: {
  c: Context<XidHonoEnv>
  tenant: TenantVar
  db: ReturnType<typeof createTenantDb>
  anonKey: string
  credentialIdBase64: string
  response: AssertionResponse
}): Promise<string> {
  const { c, tenant, db, anonKey, credentialIdBase64, response } = opts
  const challengeVal = await consumeChallenge(c.env, `auth:${anonKey}:${tenant.tenantId}`)
  if (!challengeVal) throw new AppError('challenge_invalid')

  const cred = await db.passkeyCredentials.findOne(
    and(
      eq(schema.passkeyCredentials.credentialId, credentialIdBase64),
      isNull(schema.passkeyCredentials.revokedAt),
    ),
  )
  const stored = cred ? buildStoredCredential(cred) : undefined

  const result = await verifyAuthentication({
    ceremony: 'authentication',
    expectedChallenge: decodeWebAuthnBytes(challengeVal),
    expectedRpId: tenant.rpId,
    expectedOrigins: webAuthnOrigins(tenant, new URL(c.req.url).origin),
    clientDataJson: decodeWebAuthnBytes(response.clientDataJSON),
    authenticatorData: decodeWebAuthnBytes(response.authenticatorData),
    signature: decodeWebAuthnBytes(response.signature),
    storedCredential: stored,
  })
  if (!result.ok || !cred) throw new AppError('invalid_credentials')

  await persistSignCount({
    env: c.env,
    tenantId: tenant.tenantId,
    cred: { userId: cred.userId, signCount: cred.signCount, credentialId: credentialIdBase64 },
    newSignCount: result.value.signCount,
    signCountAnomaly: result.value.signCountAnomaly,
    db,
  })
  return cred.userId
}

export function registerPasskeyRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/auth/passkey', passkey)
}
