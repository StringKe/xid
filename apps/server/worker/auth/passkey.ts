// passkey.ts:WebAuthn 注册 handler。登录走 me-auth/passkey-signin.ts,第二因子走 me-auth/passkey-mfa-challenge.ts。
// challenge 存 WEBAUTHN_CHALLENGE DO(ChallengeStore),验证后销毁(一次性防重放)。
// rpId 从 TenantContext 取,禁模块级常量(tenant-context rule)。
// PasskeyCredential 存 @xid-kit/db 租户查询层(自动注入 tenant_id,tenant-isolation rule)。

import { base64UrlEncode } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { defaultLandingPathFor } from '@xid-kit/types'
import { verifyRegistration } from '@xid-kit/webauthn'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { issueSession } from '../lib/session'
import { readJsonBody } from '../lib/validate'
import { PASSKEY_AUTH_CONTEXT } from '../lib/auth-context'
import { requireStepUp } from '../lib/step-up'
import {
  CHALLENGE_TTL_MS,
  PASSKEY_DEVICE_NAME_MAX_LENGTH,
  PASSKEY_LIMIT,
  consumeChallenge,
  createChallenge,
  persistNewCredential,
} from './passkey-helpers'
import { decodeWebAuthnBytes, webAuthnOrigins } from './passkey-assertion'
import { assertMethodAllowed, assertTenantResolvedForWebAuthn } from './hosted-policy'
import { auditPolicyDeniedError } from './hosted-audit'
import { activateSessionAfterMfaSetup, resolvePostAuthMfaGate } from '../lib/mfa-session'
import { loadUserCredentialLabel, requireSession, type SessionRequirement } from '../me/shared'
import { loadGuestConversionContext, markGuestConverted } from '../me-auth/guest-conversion'
import { trustedRootsKvKey } from '../v1/webauthn-trusted-roots'
import { handleSessionHandoff, passkeyCeremonyOrigin } from '../me-auth/passkey-handoff'

const passkey = new Hono<XidHonoEnv>()

// 强制 MFA 绑定(pending_mfa_setup)可以注册 passkey 作为满足策略的因子;pending_mfa 不行。
const PASSKEY_ENROLLMENT_SESSION: SessionRequirement = { pendingStatuses: ['pending_mfa_setup'] }

// attestation body 形状:嵌套 response 字段必须是非空 base64url 字符串。
// 形状失败不落 validation_failed:与验签失败统一 invalid_credentials(枚举防护,见 01 章 step 2)。
const attestationBodySchema = v.object({
  id: v.optional(v.string()),
  rawId: v.optional(v.string()),
  response: v.object({
    clientDataJSON: v.pipe(v.string(), v.minLength(1)),
    attestationObject: v.pipe(v.string(), v.minLength(1)),
  }),
  transports: v.optional(v.array(v.string())),
  deviceName: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(PASSKEY_DEVICE_NAME_MAX_LENGTH))),
})

async function readCeremonyBody(
  c: Context<XidHonoEnv>,
): Promise<v.InferOutput<typeof attestationBodySchema>> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('invalid_credentials')
  const result = v.safeParse(attestationBodySchema, json.value)
  if (!result.success) throw new AppError('invalid_credentials')
  return result.output
}

function resolveAttestationPreference(tenant: TenantVar): 'none' | 'indirect' | 'direct' {
  const mode = tenant.policy.hostedAuth?.attestationMode ?? 'none'
  if (mode === 'direct') return 'direct'
  if (mode === 'indirect') return 'indirect'
  return 'none'
}

// 实例级根(Workers 变量)与租户在 Management API 配置的根都可用;注册仪式按证书逐级验签到其中之一。
async function loadTrustedAttestationRoots(
  c: Context<XidHonoEnv>,
  tenantId: string,
): Promise<string[]> {
  const tenantRoots = await c.env.CACHE.get(trustedRootsKvKey(tenantId))
  return [c.env.WEBAUTHN_TRUSTED_ROOTS_PEM, tenantRoots].filter(
    (pem): pem is string => typeof pem === 'string' && pem.length > 0,
  )
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
  // 凭证只能绑定到组织自己的 rpId 主机,不能在根域以父域或别的主机注册。
  if (passkeyCeremonyOrigin(c, tenant)) throw new AppError('invalid_request')
}

function registrationChallengeKey(userId: string, tenantId: string): string {
  return `reg:${userId}:${tenantId}`
}

// POST /auth/passkey/register/options -- 返回 PublicKeyCredentialCreationOptions
passkey.post('/register/options', async (c) => {
  const tenant = c.get('tenant')
  const session = await requireSession(c, PASSKEY_ENROLLMENT_SESSION)
  await assertResolvedWebAuthnTenant(c, tenant)

  const db = createTenantDb(c.env.DB, tenant)
  const existing = await db.passkeyCredentials.findMany(
    and(
      eq(schema.passkeyCredentials.userId, session.userId),
      isNull(schema.passkeyCredentials.revokedAt),
    ),
    { limit: PASSKEY_LIMIT },
  )
  if (existing.length >= PASSKEY_LIMIT) throw new AppError('passkey_limit_reached')
  // 已有强因子时新增凭证属于敏感操作:否则劫持会话的人可以先绑定自己的认证器再完成 step-up。
  await requireStepUp(c, tenant, session)

  const label = await loadUserCredentialLabel(db, session.userId)
  const challenge = await createChallenge(
    c.env,
    registrationChallengeKey(session.userId, tenant.tenantId),
  )
  return c.json({
    challenge,
    rp: { id: tenant.rpId, name: tenant.issuer },
    user: {
      id: base64UrlEncode(new TextEncoder().encode(session.userId)),
      name: label.name,
      displayName: label.displayName,
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
    excludeCredentials: existing.map((row) => ({
      type: 'public-key',
      id: row.credentialId,
      transports: row.transports ?? [],
    })),
    attestation: resolveAttestationPreference(tenant),
    timeout: CHALLENGE_TTL_MS,
  })
})

// POST /auth/passkey/register/verify -- 验证注册 attestation
passkey.post('/register/verify', async (c) => {
  const tenant = c.get('tenant')
  const session = await requireSession(c, PASSKEY_ENROLLMENT_SESSION)
  await assertResolvedWebAuthnTenant(c, tenant)

  const body = await readCeremonyBody(c)
  const challengeVal = await consumeChallenge(
    c.env,
    registrationChallengeKey(session.userId, tenant.tenantId),
  )
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

  const db = createTenantDb(c.env.DB, tenant)
  await persistNewCredential({
    db,
    tenantId: tenant.tenantId,
    userId: session.userId,
    credentialIdBase64: base64UrlEncode(result.value.credentialId),
    verified: result.value,
    transports: body.transports ?? [],
    deviceName: body.deviceName || null,
  })

  // guest 转正:guest session 注册首个 passkey 成功即转正 -- 钩子改写 provisionedBy /
  // 吊销旧 guest session / 审计 / 解绑,随后按既有 MFA gate 轮换签发新 session。
  const guest = await loadGuestConversionContext(c, db)
  if (guest) {
    await markGuestConverted({ c, tenant, db, guest, provisionedBy: 'hosted_passkey' })
    const mfaGate = await resolvePostAuthMfaGate(c, tenant, {
      userId: guest.userId,
      returnPath: defaultLandingPathFor(tenant),
      sessionAmr: PASSKEY_AUTH_CONTEXT.amr,
    })
    await issueSession(c, {
      sessionId: createPersistedId('session'),
      userId: guest.userId,
      ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
      authContext: PASSKEY_AUTH_CONTEXT,
      authenticatedAt: new Date(),
      rememberMe: true,
      ip: c.req.header('cf-connecting-ip') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
    })
    return c.json({ ok: true })
  }

  await activateSessionAfterMfaSetup(c, tenant, { session, method: 'passkey' })
  return c.json({ ok: true })
})

// POST /auth/passkey/handoff -- rpId 主机完成 passkey 登录后,浏览器把一次性交接 grant 带回 issuer 主机
passkey.post('/handoff', handleSessionHandoff)

export function registerPasskeyRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/auth/passkey', passkey)
}
