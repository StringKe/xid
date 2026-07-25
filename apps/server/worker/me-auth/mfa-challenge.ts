// POST /auth/mfa/sms/send + /auth/mfa/verify(前端 mfa/index.tsx;须已登录待 MFA)。
// mfa/sms/send:target 取 session 用户已验证 userPhones(MFA 第二因子,非 passwordless),persistAndSendOtp(channel='sms')。
//   已知 userId 无需枚举防护;限流超限抛 rate_limited。
// mfa/verify dispatch(三因子共用):
//   totp  -> verifyTotp @ auth/mfa.ts(防重放 + 时钟容忍,失败映射 otp_invalid/otp_expired)
//   sms   -> loadVerifiableOtp/recordOtpFailure @ auth/otp.ts(channel='sms',MFA token)
//   backup-> verifyAndConsumeBackupCode @ auth/backup-codes.ts(HMAC-SHA256,一次性,失败 otp_invalid)
// stepUp=true 走 issueStepUpToken(acr:step-up,5min),token 经 __Host-xid.acr cookie 投递(不复用 session token);
//   否则 touch session(已 MFA)。响应 { redirectTo? }(前端缺失回落 ?redirect_to= 或 /console)。

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import { setCookie } from 'hono/cookie'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { SessionData, TenantVar, XidHonoEnv } from '../lib/types'
import { readSession } from '../lib/session'
import { addMfaToAuthContext, PASSWORD_AUTH_CONTEXT } from '../lib/auth-context'
import { issueStepUpToken, verifyTotp } from '../auth/mfa'
import { verifyAndConsumeBackupCode } from '../auth/backup-codes'
import {
  consumeVerifiableOtp,
  constantTimeEqualStr,
  loadVerifiableOtp,
  persistAndSendOtp,
  recordOtpFailure,
} from '../auth/otp'
import { smsDeliveryReady } from '../auth/delivery-channels'
import { enforceVerifyRateLimit } from '../lib/verify-rate-limit'
import { enforceSendRateLimit, requestIp } from './shared'
import { readJsonBody, validateCredentialBody } from '../lib/validate'

const STEP_UP_TTL_SEC = 5 * 60

const mfaMethodSchema = v.picklist(['totp', 'backup', 'sms', 'passkey'])
type MfaMethod = v.InferOutput<typeof mfaMethodSchema>

const mfaVerifyBodySchema = v.object({
  method: mfaMethodSchema,
  code: v.optional(v.string()),
  stepUp: v.optional(v.boolean()),
})

async function requireMfaSession(c: Context<XidHonoEnv>): Promise<SessionData> {
  const current = c.get('session')
  if (current) return current
  const session = await readSession(c, ['active', 'pending_mfa'])
  if (!session) throw new AppError('unauthorized', { httpStatus: 401 })
  c.set('session', session)
  return session
}

// POST /auth/mfa/sms/send -- 给 session 用户已验证手机号发 MFA SMS OTP。
export async function handleMfaSmsSend(c: Context<XidHonoEnv>): Promise<Response> {
  const session = await requireMfaSession(c)
  const tenant = c.get('tenant')

  const db = createTenantDb(c.env.DB, tenant)
  const phoneRow = await db.userPhones.findOne(
    and(eq(schema.userPhones.userId, session.userId), eq(schema.userPhones.verified, true)),
  )
  // 无已验证手机号:不可发(MFA 已知用户,无需枚举防护,但也不泄露细节)。
  if (!phoneRow) throw new AppError('mfa_setup_required')
  if (!smsDeliveryReady(tenant, c.env)) throw new AppError('invalid_request')

  await enforceSendRateLimit(c.env, `mfasms:${tenant.tenantId}`, phoneRow.phone)
  await persistAndSendOtp({
    c,
    db,
    tenantId: tenant.tenantId,
    channel: 'sms',
    target: phoneRow.phone,
    userId: session.userId,
  })
  return c.json({ ok: true })
}

// totp:取该用户 active totp factor,verifyTotp(KEK 解密 + 防重放 + 时钟容忍)。
async function verifyTotpFactor(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  userId: string,
  code: string,
): Promise<void> {
  const db = createTenantDb(c.env.DB, tenant)
  const factor = await db.mfaFactors.findOne(
    and(
      eq(schema.mfaFactors.userId, userId),
      eq(schema.mfaFactors.factorType, 'totp'),
      eq(schema.mfaFactors.status, 'active'),
    ),
  )
  if (!factor) throw new AppError('otp_invalid')

  const result = await verifyTotp({
    ctx: tenant,
    d1: c.env.DB,
    cache: c.env.CACHE,
    kekRaw: c.env.KEK,
    userId,
    factorId: factor.id,
    code,
  })
  if (result.ok) return
  // 所有 TOTP 失败(replayed/invalid_code/factor/decrypt)统一模糊到 otp_invalid(枚举防护)。
  throw new AppError('otp_invalid')
}

// sms:loadVerifiableOtp(channel='sms')+ constant-time 比对 + recordOtpFailure(失败计数/一次性)。
async function verifySmsFactor(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  userId: string,
  code: string,
): Promise<void> {
  if (!/^\d{6}$/.test(code)) throw new AppError('otp_invalid')
  if (!smsDeliveryReady(tenant, c.env)) throw new AppError('otp_invalid')
  const db = createTenantDb(c.env.DB, tenant)
  const phoneRow = await db.userPhones.findOne(
    and(eq(schema.userPhones.userId, userId), eq(schema.userPhones.verified, true)),
  )
  if (!phoneRow) throw new AppError('otp_invalid')

  const tokenRow = await loadVerifiableOtp(db, 'sms', phoneRow.phone)
  const codeHash = await sha256Hex(code)
  if (!constantTimeEqualStr(codeHash, tokenRow.codeHash ?? '')) {
    await recordOtpFailure(db, tokenRow)
    throw new AppError('otp_invalid')
  }
  if (!(await consumeVerifiableOtp(db, tokenRow))) throw new AppError('otp_invalid')
}

// backup:verifyAndConsumeBackupCode(HMAC-SHA256,一次性)。not_found/already_used -> otp_invalid。
async function verifyBackupFactor(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  userId: string,
  code: string,
): Promise<void> {
  const result = await verifyAndConsumeBackupCode({
    ctx: tenant,
    d1: c.env.DB,
    userId,
    code,
    pepper: c.env.PEPPER,
  })
  if (!result.ok) throw new AppError('otp_invalid')
}

async function dispatchVerify(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  input: { session: SessionData; method: MfaMethod; code: string },
): Promise<void> {
  const { session, method, code } = input
  if (method === 'passkey') {
    throw new AppError('invalid_request', {
      longMessage: 'Use POST /auth/mfa/passkey/verify for passkey MFA',
    })
  }
  if (method === 'totp') return verifyTotpFactor(c, tenant, session.userId, code)
  if (method === 'sms') return verifySmsFactor(c, tenant, session.userId, code)
  return verifyBackupFactor(c, tenant, session.userId, code)
}

export async function handleMfaVerify(c: Context<XidHonoEnv>): Promise<Response> {
  const session = await requireMfaSession(c)
  const tenant = c.get('tenant')
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('otp_invalid')
  // method/code 是凭证:未知 method 与错码同 otp_invalid(枚举防护);stepUp 非凭证走 422。
  const body = validateCredentialBody(mfaVerifyBodySchema, json.value, {
    code: 'otp_invalid',
    credentialFields: ['method', 'code'],
  })

  const method = body.method
  const code = (body.code ?? '').trim()
  if (method !== 'passkey' && !code) throw new AppError('otp_invalid')

  // 失败限流:account=userId + IP(anti-abuse rule)。
  await enforceVerifyRateLimit({
    env: c.env,
    tenantId: tenant.tenantId,
    scope: 'mfa',
    account: session.userId,
    ip: requestIp(c),
  })

  await dispatchVerify(c, tenant, { session, method, code })

  if (body.stepUp === true) {
    // step-up:独立颁发 acr:step-up token(5min),经 __Host-xid.acr cookie 投递,不复用 session token。
    const { token } = await issueStepUpToken({
      userId: session.userId,
      sessionId: session.sessionId,
      method,
      pepperRaw: c.env.PEPPER,
    })
    setCookie(c, '__Host-xid.acr', token, {
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: STEP_UP_TTL_SEC,
    })
    return c.json({})
  }

  // 非 step-up:touch session(已 MFA);MFA 门控在 token 签发处校验(超本端点范围)。
  const db = createTenantDb(c.env.DB, tenant)
  const nextAuthContext = addMfaToAuthContext(
    {
      acr: session.acr ?? PASSWORD_AUTH_CONTEXT.acr,
      amr: session.amr ?? PASSWORD_AUTH_CONTEXT.amr,
      aal: session.aal === 1 || session.aal === 2 || session.aal === 3 ? session.aal : 1,
    },
    method,
  )
  await db.sessions.update(
    {
      status: 'active',
      lastActiveAt: new Date(),
      acr: nextAuthContext.acr,
      amr: [...nextAuthContext.amr],
      aal: nextAuthContext.aal,
    },
    eq(schema.sessions.id, session.sessionId),
  )
  return c.json({})
}
