// passwordless OTP 验证:失败限流 + loadVerifiableOtp + constant-time 比对 + recordOtpFailure + issueSession。
// 枚举防护(铁律):失败统一 otp_invalid/otp_expired。成功时 issueSession 设 cookie,响应 { redirectUrl }。

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb } from '@xid-kit/db'
import { defaultLandingPathFor } from '@xid-kit/types'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { issueSession } from '../lib/session'
import { EMAIL_OTP_AUTH_CONTEXT, SMS_OTP_AUTH_CONTEXT } from '../lib/auth-context'
import { enforceVerifyRateLimit, resetVerifyAccountRateLimit } from '../lib/verify-rate-limit'
import { otpCodeSchema, readJsonBody, validateCredentialBody } from '../lib/validate'
import {
  consumeVerifiableOtp,
  constantTimeEqualStr,
  loadVerifiableOtp,
  recordOtpFailure,
} from '../auth/otp'
import type { OtpChannel } from '../auth/otp'
import { requestIp, requestUserAgent } from './shared'
import { assertEmailAllowed, assertMethodAllowedWithCapabilities } from '../auth/hosted-policy'
import { auditPolicyDeniedError } from '../auth/hosted-audit'
import { markPrimaryEmailVerified, markPrimaryPhoneVerified } from './passwordless-users'
import { loadGuestConversionContext, markGuestConverted } from './guest-conversion'
import { withTenant } from './instance-login'
import { resolvePostAuthMfaGate } from '../lib/mfa-session'
import { parsePasswordlessFlowContext } from '../auth/passwordless-flow'
import {
  hasPasswordlessCapability,
  identifierTypeForChannel,
  methodForChannel,
  nullableString,
  otpTarget,
  resolveOtpTenant,
} from './passwordless-otp-shared'
import type { OtpRouteOptions } from './passwordless-otp-shared'

const otpVerifyBodySchema = v.object({
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  code: v.optional(otpCodeSchema),
  organizationId: nullableString,
  clientId: nullableString,
  invitationToken: nullableString,
  intent: nullableString,
  continue: nullableString,
})

type OtpVerifyInput = OtpRouteOptions & {
  c: Context<XidHonoEnv>
  channel: OtpChannel
  target: string
  code: string
}

async function verifyOtp(input: OtpVerifyInput): Promise<Response> {
  const { c, channel, target, code, organizationId, applicationClientId, invitationToken, intent } =
    input
  // Invitation ownership can only be proved by the dedicated Email claim ceremony.
  if (invitationToken?.trim()) throw new AppError('otp_invalid')
  // code 格式已由 otpVerifyBodySchema 保证(形状失败在入口已抛 otp_invalid),此处只兜空值。
  if (!target || !code) throw new AppError('otp_invalid')
  const tenant = await resolveOtpTenant(c, {
    channel,
    target,
    organizationId,
    intent,
    applicationClientId,
  })

  return withTenant(c, tenant, async () => {
    try {
      const method = methodForChannel(channel)
      assertMethodAllowedWithCapabilities(
        tenant,
        method,
        'login',
        hasPasswordlessCapability(c, tenant),
      )
      if (channel === 'email') assertEmailAllowed(tenant, target)
    } catch (error) {
      throw await auditPolicyDeniedError(c, error, {
        tenant,
        method: methodForChannel(channel),
        action: 'login',
        identifier: { type: identifierTypeForChannel(channel), value: target },
      })
    }

    await enforceVerifyRateLimit({
      env: c.env,
      tenantId: tenant.tenantId,
      scope: 'otp',
      account: target,
      ip: requestIp(c),
    })

    const db = createTenantDb(c.env.DB, tenant)
    const tokenRow = await loadVerifiableOtp(db, channel, target)
    const flow = parsePasswordlessFlowContext(
      tokenRow.flowContext,
      'otp_invalid',
      defaultLandingPathFor(tenant),
    )
    // 比对/消费前拒绝带 invitationId 的旧 OTP flow。
    if (flow.invitationId) throw new AppError('otp_invalid')

    const codeHash = await sha256Hex(code)
    if (!constantTimeEqualStr(codeHash, tokenRow.codeHash ?? '')) {
      await recordOtpFailure(db, tokenRow)
    }

    // guest 转正判定(验证码已证明控制权之后):
    // - OTP 目标属于本租户其他 user:拒绝挂接,invalid_credentials 口径引导登录既有账号
    //   (同 social 未验证拒绝合并;验证前的 send 阶段不泄露占用事实)。
    // - OTP 目标就是 guest user(send 阶段挂接的联系方式):验证通过即完成转正。
    const guest = await loadGuestConversionContext(c, db)
    if (guest && tokenRow.userId !== guest.userId) throw new AppError('invalid_credentials')

    if (!(await consumeVerifiableOtp(db, tokenRow))) throw new AppError('otp_invalid')
    await resetVerifyAccountRateLimit({
      env: c.env,
      tenantId: tenant.tenantId,
      scope: 'otp',
      account: target,
    })
    if (channel === 'email') {
      await markPrimaryEmailVerified(db, tokenRow.userId)
    } else {
      await markPrimaryPhoneVerified(db, tokenRow.userId)
    }
    // 转正钩子:provisionedBy 改写 + 吊销旧 guest session + 审计 + GuestStore 解绑。
    // 新 session 由下方既有 MFA gate + issueSession 签发(amr 不含 'guest')。
    if (guest) {
      await markGuestConverted({ c, tenant, db, guest, provisionedBy: 'hosted_passwordless' })
    }

    const now = new Date()
    const sessionId = createPersistedId('session')
    const returnPath = flow.continuePath
    const authContext = channel === 'email' ? EMAIL_OTP_AUTH_CONTEXT : SMS_OTP_AUTH_CONTEXT
    const mfaGate = await resolvePostAuthMfaGate(c, tenant, {
      userId: tokenRow.userId,
      returnPath,
      sessionAmr: authContext.amr,
    })
    await resetVerifyAccountRateLimit({
      env: c.env,
      tenantId: tenant.tenantId,
      scope: 'otp',
      account: target,
    })
    await issueSession(c, {
      sessionId,
      userId: tokenRow.userId,
      ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
      authContext,
      authenticatedAt: now,
      ip: requestIp(c),
      userAgent: requestUserAgent(c),
    })

    if (mfaGate.redirectUrl) {
      return c.json({ redirectUrl: mfaGate.redirectUrl })
    }

    return c.json({ redirectUrl: flow.continuePath })
  })
}

function otpVerifyHandler(channel: OtpChannel): (c: Context<XidHonoEnv>) => Promise<Response> {
  return async (c) => {
    const json = await readJsonBody(c)
    if (!json.ok) throw new AppError('otp_invalid')
    const body = validateCredentialBody(otpVerifyBodySchema, json.value, {
      code: 'otp_invalid',
      credentialFields: [identifierTypeForChannel(channel), 'code'],
    })
    return verifyOtp({
      c,
      channel,
      target: otpTarget(channel, body, 'otp_invalid'),
      code: body.code ?? '',
      organizationId: body.organizationId,
      applicationClientId: body.clientId,
      invitationToken: body.invitationToken,
      intent: body.intent,
      continue: body.continue,
    })
  }
}

export const handleOtpEmailVerify = otpVerifyHandler('email')
export const handleOtpSmsVerify = otpVerifyHandler('sms')
export const handleOtpWhatsappVerify = otpVerifyHandler('whatsapp')
