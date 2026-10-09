// MFA 挑战:sms/send 给显式登记的 SMS 因子发码;verify 分发 totp/sms/backup,失败统一 otp_invalid。
// stepUp 经独立 __Host-xid.acr cookie(5min),不复用 session token。

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { SessionData, TenantVar, XidHonoEnv } from '../lib/types'
import { verifyTotp } from '../auth/mfa'
import { verifyAndConsumeBackupCode } from '../auth/backup-codes'
import {
  consumeVerifiableOtp,
  constantTimeEqualStr,
  loadVerifiableOtp,
  MFA_OTP_PURPOSE,
  persistAndSendOtp,
  recordOtpFailure,
} from '../auth/otp'
import { smsDeliveryReady } from '../auth/delivery-channels'
import { reservePhoneOtpIpBudget, reservePhoneOtpTenantBudget } from '../auth/phone-otp-budget'
import { excludedMfaMethods } from '../auth/passkey-mfa-eligibility'
import { findActiveSmsFactor } from '../lib/mfa-methods'
import { completeMfaOnSession, requireMfaSession } from '../lib/mfa-session'
import { issueStepUpCookie } from '../lib/step-up'
import { enforceVerifyRateLimit, resetVerifyAccountRateLimit } from '../lib/verify-rate-limit'
import { enforceSendRateLimit, requestIp } from './shared'
import { readJsonBody, validateCredentialBody } from '../lib/validate'

export const MFA_VERIFY_SCOPE = 'mfa'

const mfaVerifyBodySchema = v.object({
  method: v.picklist(['totp', 'backup', 'sms']),
  code: v.pipe(v.string(), v.trim(), v.minLength(1)),
  stepUp: v.optional(v.boolean()),
})
type CodeMfaMethod = v.InferOutput<typeof mfaVerifyBodySchema>['method']

async function loadSmsFactorForSession(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  session: SessionData,
): Promise<{ phone: string } | null> {
  if (!smsDeliveryReady(tenant, c.env)) return null
  if (excludedMfaMethods(session).includes('sms')) return null
  return findActiveSmsFactor(createTenantDb(c.env.DB, tenant), session.userId)
}

// POST /auth/mfa/sms/send -- 给显式登记的 SMS 因子手机号发 MFA 验证码。
export async function handleMfaSmsSend(c: Context<XidHonoEnv>): Promise<Response> {
  const session = await requireMfaSession(c)
  const tenant = c.get('tenant')
  const factor = await loadSmsFactorForSession(c, tenant, session)
  if (!factor) throw new AppError('mfa_setup_required')

  const ip = requestIp(c)
  if (ip) await reservePhoneOtpIpBudget(c.env, ip)
  await reservePhoneOtpTenantBudget(c.env, tenant.tenantId)
  await enforceSendRateLimit(c.env, `mfasms:${tenant.tenantId}`, factor.phone)
  await persistAndSendOtp({
    c,
    db: createTenantDb(c.env.DB, tenant),
    tenantId: tenant.tenantId,
    channel: 'sms',
    purpose: MFA_OTP_PURPOSE,
    target: factor.phone,
    userId: session.userId,
  })
  return c.json({ ok: true })
}

// totp:取该用户 active totp factor,verifyTotp(KEK 解密 + 防重放 + 时钟容忍)。
async function verifyTotpFactor(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  input: { userId: string; code: string },
): Promise<void> {
  const db = createTenantDb(c.env.DB, tenant)
  const factor = await db.mfaFactors.findOne(
    and(
      eq(schema.mfaFactors.userId, input.userId),
      eq(schema.mfaFactors.factorType, 'totp'),
      eq(schema.mfaFactors.status, 'active'),
    ),
  )
  if (!factor) throw new AppError('otp_invalid')

  const result = await verifyTotp({
    ctx: tenant,
    d1: c.env.DB,
    replayStore: c.env.WEBAUTHN_CHALLENGE,
    kekRaw: c.env.KEK,
    userId: input.userId,
    factorId: factor.id,
    code: input.code,
  })
  // 所有 TOTP 失败(replayed/invalid_code/factor/decrypt)统一模糊到 otp_invalid(枚举防护)。
  if (!result.ok) throw new AppError('otp_invalid')
}

// sms:只接受显式 SMS 因子 + MFA 专用 purpose 的验证码,免密登录码不能在这里通过。
async function verifySmsFactor(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  input: { session: SessionData; code: string },
): Promise<void> {
  if (!/^\d{6}$/.test(input.code)) throw new AppError('otp_invalid')
  const factor = await loadSmsFactorForSession(c, tenant, input.session)
  if (!factor) throw new AppError('otp_invalid')

  const db = createTenantDb(c.env.DB, tenant)
  const tokenRow = await loadVerifiableOtp(db, 'sms', factor.phone, MFA_OTP_PURPOSE)
  const codeHash = await sha256Hex(input.code)
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
  input: { userId: string; code: string },
): Promise<void> {
  const result = await verifyAndConsumeBackupCode({
    ctx: tenant,
    d1: c.env.DB,
    userId: input.userId,
    code: input.code,
    pepper: c.env.PEPPER,
  })
  if (!result.ok) throw new AppError('otp_invalid')
}

async function dispatchVerify(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  input: { session: SessionData; method: CodeMfaMethod; code: string },
): Promise<void> {
  const { session, method, code } = input
  if (method === 'totp') return verifyTotpFactor(c, tenant, { userId: session.userId, code })
  if (method === 'sms') return verifySmsFactor(c, tenant, { session, code })
  return verifyBackupFactor(c, tenant, { userId: session.userId, code })
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
  // 短信码可被 SIM 劫持截获,只能作登录第二因子,不能确认敏感改动;在消费验证码前拒绝。
  if (body.stepUp === true && body.method === 'sms') {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'method' } })
  }

  // 失败限流:account=userId + IP(anti-abuse rule);成功后清除 account 维度计数与退避档。
  await enforceVerifyRateLimit({
    env: c.env,
    tenantId: tenant.tenantId,
    scope: MFA_VERIFY_SCOPE,
    account: session.userId,
    ip: requestIp(c),
  })
  await dispatchVerify(c, tenant, { session, method: body.method, code: body.code })
  await resetVerifyAccountRateLimit({
    env: c.env,
    tenantId: tenant.tenantId,
    scope: MFA_VERIFY_SCOPE,
    account: session.userId,
  })

  if (body.stepUp === true) {
    await issueStepUpCookie(c, { session, method: body.method })
    return c.json({})
  }
  await completeMfaOnSession(c, tenant, { session, method: body.method })
  return c.json({})
}
