// passwordless 登录:magic-link/send + otp/email|whatsapp|sms/send|verify(前端 useSignIn)。
// 复用 auth/magic-link.ts sendMagicLink 与 auth/otp.ts persistAndSendOtp/loadVerifiableOtp/recordOtpFailure
// (单一真相源,不重复实现 token 逻辑)。契约差异:前端按渠道拆端点 + 传 turnstileToken。
// 枚举防护(铁律):send 统一 200 不区分存在性;verify 失败统一 otp_invalid/otp_expired。
// verify 成功:issueSession 设 cookie,响应 { redirectUrl? }(此处省略 redirectUrl,前端回落 continue)。

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb } from '@xid-kit/db'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { issueSession } from '../lib/session'
import { EMAIL_OTP_AUTH_CONTEXT, SMS_OTP_AUTH_CONTEXT } from '../lib/auth-context'
import { enforceVerifyRateLimit } from '../lib/verify-rate-limit'
import { otpCodeSchema, readJsonBody, validateCredentialBody } from '../lib/validate'
import { handleMagicLinkVerify, sendMagicLink } from '../auth/magic-link'
import {
  consumeVerifiableOtp,
  constantTimeEqualStr,
  loadVerifiableOtp,
  persistAndSendOtp,
  recordOtpFailure,
  reserveOtpSendRateLimit,
  resolveTargetUserId,
  validatePhoneOtpTarget,
} from '../auth/otp'
import type { OtpChannel } from '../auth/otp'
import { requestIp, requestUserAgent, verifyTurnstile } from './shared'
import {
  assertEmailAllowed,
  assertMethodAllowedWithCapabilities,
  assertMethodAvailableWithCapabilities,
} from '../auth/hosted-policy'
import type { HostedAuthMethod } from '../auth/hosted-policy'
import { auditPolicyDeniedError } from '../auth/hosted-audit'
import { normalizeProfileFields } from '../auth/profile-fields'
import type { ProfileFieldInput } from '../auth/profile-fields'
import {
  attachPasswordlessEmail,
  attachPasswordlessPhone,
  createPasswordlessEmailUser,
  createPasswordlessPhoneUser,
  markPrimaryEmailVerified,
  markPrimaryPhoneVerified,
  shouldSkipDefaultMembership,
} from './passwordless-users'
import { loadGuestConversionContext, markGuestConverted } from './guest-conversion'
import { smsDeliveryReady, whatsappDeliveryReady } from '../auth/delivery-channels'
import { resolveEntryTenant, withTenant } from './instance-login'
import { resolvePostAuthMfaGate } from '../lib/mfa-session'
import {
  createPasswordlessFlowContext,
  parsePasswordlessFlowContext,
} from '../auth/passwordless-flow'
import { startInvitationEmailClaim } from './invitation-claim'

function identifierTypeForChannel(channel: OtpChannel): 'email' | 'phone' {
  return channel === 'email' ? 'email' : 'phone'
}

const nullableString = v.optional(v.nullable(v.string()))

// email/phone 同时是标识字段与 profile 字段,schema 里只声明一次。
const magicLinkBodySchema = v.object({
  email: v.optional(v.string()),
  username: nullableString,
  phone: nullableString,
  name: nullableString,
  givenName: nullableString,
  familyName: nullableString,
  organizationId: nullableString,
  clientId: nullableString,
  invitationToken: nullableString,
  intent: nullableString,
  continue: nullableString,
  turnstileToken: nullableString,
})
const otpSendBodySchema = v.object({
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  username: nullableString,
  name: nullableString,
  givenName: nullableString,
  familyName: nullableString,
  organizationId: nullableString,
  clientId: nullableString,
  invitationToken: nullableString,
  intent: nullableString,
  continue: nullableString,
  turnstileToken: nullableString,
})
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
type OtpSendInput = {
  c: Context<XidHonoEnv>
  channel: OtpChannel
  target: string
  profileInput: ProfileFieldInput
  organizationId?: string | null
  applicationClientId?: string | null
  invitationToken?: string | null
  intent?: string | null
  continue?: string | null
}
type OtpVerifyInput = {
  c: Context<XidHonoEnv>
  channel: OtpChannel
  target: string
  code: string
  organizationId?: string | null
  applicationClientId?: string | null
  invitationToken?: string | null
  intent?: string | null
  continue?: string | null
}

function methodForChannel(channel: OtpChannel): 'emailOtp' | 'whatsappOtp' | 'smsOtp' {
  if (channel === 'email') return 'emailOtp'
  return channel === 'whatsapp' ? 'whatsappOtp' : 'smsOtp'
}

function passwordlessCapability(
  c: Context<XidHonoEnv>,
  tenant: XidHonoEnv['Variables']['tenant'],
  method: 'emailOtp' | 'whatsappOtp' | 'smsOtp',
): boolean {
  if (method === 'whatsappOtp') return whatsappDeliveryReady(tenant, c.env)
  return method !== 'smsOtp' || smsDeliveryReady(tenant, c.env)
}

function hasPasswordlessCapability(
  c: Context<XidHonoEnv>,
  tenant: XidHonoEnv['Variables']['tenant'],
): (method: HostedAuthMethod) => boolean {
  return (method) =>
    (method !== 'whatsappOtp' || passwordlessCapability(c, tenant, method)) &&
    (method !== 'smsOtp' || passwordlessCapability(c, tenant, method))
}

async function startInvitationClaimOpaque(
  c: Context<XidHonoEnv>,
  rawInvitationToken: string,
): Promise<void> {
  try {
    await startInvitationEmailClaim({ c, rawInvitationToken })
  } catch (error) {
    if (
      error instanceof AppError &&
      (error.code === 'invitation_invalid' || error.code === 'invitation_expired')
    ) {
      return
    }
    throw error
  }
}

// POST /auth/magic-link/send -- 先过 turnstile 校验再复用 sendMagicLink(枚举防护 200)。
export async function handleMagicLinkSend(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('invalid_request')
  const body = validateCredentialBody(magicLinkBodySchema, json.value, {
    code: 'invalid_request',
    credentialFields: ['email'],
  })
  const email = (body.email ?? '').trim().toLowerCase()
  if (!email) throw new AppError('invalid_request')
  await verifyTurnstile(body.turnstileToken, c.env, requestIp(c))
  if (body.invitationToken?.trim()) {
    await startInvitationClaimOpaque(c, body.invitationToken)
    return c.json({ ok: true })
  }
  const tenant = await resolveEntryTenant(c, { kind: 'email', value: email }, body.organizationId, {
    intent: body.intent,
    applicationClientId: body.clientId,
  })
  await withTenant(c, tenant, () =>
    sendMagicLink(c, email, {
      profileInput: body,
      continuePath: body.continue,
      intent: body.intent,
      applicationClientId: body.clientId,
    }),
  )
  return c.json({ ok: true })
}

export { handleMagicLinkVerify }

// OTP 发送核心(channel/target 复用 persistAndSendOtp);限流 + 枚举防护(200)。
async function sendOtp(input: OtpSendInput): Promise<Response> {
  const {
    c,
    channel,
    target,
    profileInput,
    organizationId,
    applicationClientId,
    invitationToken,
    intent,
    continue: continueParam,
  } = input
  if (!target) throw new AppError('invalid_request')
  if (invitationToken?.trim()) {
    await startInvitationClaimOpaque(c, invitationToken)
    return c.json({ ok: true })
  }
  const tenant =
    channel === 'email'
      ? await resolveEntryTenant(
          c,
          { kind: 'email', value: target.toLowerCase() },
          organizationId,
          { intent, applicationClientId },
        )
      : await resolveEntryTenant(c, { kind: 'phone', value: target }, organizationId, {
          intent,
          applicationClientId,
        })
  if (channel !== 'email' && !validatePhoneOtpTarget(target)) {
    throw new AppError('invalid_request', { longMessage: 'Phone number not in allowed region' })
  }
  try {
    const method = methodForChannel(channel)
    assertMethodAvailableWithCapabilities(tenant, method, hasPasswordlessCapability(c, tenant))
    if (channel === 'email') assertEmailAllowed(tenant, target)
  } catch (error) {
    await auditPolicyDeniedError(c, error, {
      tenant,
      method: methodForChannel(channel),
      action: 'availability',
      identifier: { type: identifierTypeForChannel(channel), value: target },
    })
    return c.json({ ok: true })
  }

  await reserveOtpSendRateLimit(c.env, target, tenant.tenantId)

  const db = createTenantDb(c.env.DB, tenant)
  const flow = createPasswordlessFlowContext({
    intent,
    continuePath: continueParam,
    applicationClientId,
  })
  const skipDefaultMembership = shouldSkipDefaultMembership({
    redirectAfterLogin: flow.continuePath,
    invitationToken,
    intent: flow.intent,
  })
  let userId = await resolveTargetUserId(db, channel, target)
  if (userId) {
    try {
      const method = methodForChannel(channel)
      assertMethodAllowedWithCapabilities(
        tenant,
        method,
        'login',
        hasPasswordlessCapability(c, tenant),
      )
    } catch (error) {
      await auditPolicyDeniedError(c, error, {
        tenant,
        method: methodForChannel(channel),
        action: 'login',
        identifier: { type: identifierTypeForChannel(channel), value: target },
      })
      return c.json({ ok: true })
    }
  } else if (channel === 'email') {
    try {
      assertMethodAllowedWithCapabilities(
        tenant,
        'emailOtp',
        'user_creation',
        hasPasswordlessCapability(c, tenant),
      )
      // guest 转正:持有效 guest session 时不建号,目标 email 挂为 guest user 的未验证主邮箱。
      const guest = await loadGuestConversionContext(c, db)
      if (guest) {
        await attachPasswordlessEmail({
          db,
          tenantId: tenant.tenantId,
          userId: guest.userId,
          email: target,
        })
        userId = guest.userId
      } else {
        const profile = normalizeProfileFields(tenant, profileInput, { email: target })
        if (profile.email) assertEmailAllowed(tenant, profile.email)
        userId = await createPasswordlessEmailUser({
          db,
          d1: c.env.DB,
          tenantId: tenant.tenantId,
          email: target,
          profile,
          skipDefaultMembership,
        })
      }
    } catch (error) {
      await auditPolicyDeniedError(c, error, {
        tenant,
        method: 'emailOtp',
        action: 'user_creation',
        identifier: { type: 'email', value: target },
      })
      return c.json({ ok: true })
    }
  } else {
    const method = methodForChannel(channel)
    try {
      assertMethodAllowedWithCapabilities(
        tenant,
        method,
        'user_creation',
        hasPasswordlessCapability(c, tenant),
      )
      // guest 转正:同 email 分支,目标 phone 挂为 guest user 的未验证主手机号。
      const guest = await loadGuestConversionContext(c, db)
      if (guest) {
        await attachPasswordlessPhone({
          db,
          tenantId: tenant.tenantId,
          userId: guest.userId,
          phone: target,
        })
        userId = guest.userId
      } else {
        const profile = normalizeProfileFields(tenant, profileInput, {
          phone: target,
        })
        if (profile.email) assertEmailAllowed(tenant, profile.email)
        userId = await createPasswordlessPhoneUser({
          db,
          d1: c.env.DB,
          tenantId: tenant.tenantId,
          phone: target,
          profile,
          skipDefaultMembership,
        })
      }
    } catch (error) {
      await auditPolicyDeniedError(c, error, {
        tenant,
        method,
        action: 'user_creation',
        identifier: { type: 'phone', value: target },
      })
      return c.json({ ok: true })
    }
  }

  await withTenant(c, tenant, () =>
    persistAndSendOtp({
      c,
      db,
      tenantId: tenant.tenantId,
      channel,
      target,
      userId,
      flowContext: flow,
    }),
  )
  return c.json({ ok: true })
}

// OTP 验证核心:失败限流 + loadVerifiableOtp + constant-time 比对 + recordOtpFailure + issueSession。
async function verifyOtp(input: OtpVerifyInput): Promise<Response> {
  const { c, channel, target, code, organizationId, applicationClientId, invitationToken, intent } =
    input
  // Invitation ownership can only be proved by the dedicated Email claim ceremony.
  if (invitationToken?.trim()) throw new AppError('otp_invalid')
  const tenant =
    channel === 'email'
      ? await resolveEntryTenant(
          c,
          { kind: 'email', value: target.toLowerCase() },
          organizationId,
          { intent, applicationClientId },
        )
      : await resolveEntryTenant(c, { kind: 'phone', value: target }, organizationId, {
          applicationClientId,
        })
  // code 格式已由 otpVerifyBodySchema 保证(形状失败在入口已抛 otp_invalid),此处只兜空值。
  if (!target || !code) throw new AppError('otp_invalid')

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
    const flow = parsePasswordlessFlowContext(tokenRow.flowContext, 'otp_invalid')
    // Reject legacy persisted OTP flows before comparison, consumption, or user/session writes.
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
    const mfaGate = await resolvePostAuthMfaGate(c, tenant, {
      userId: tokenRow.userId,
      returnPath,
    })
    await issueSession(c, {
      sessionId,
      userId: tokenRow.userId,
      ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
      authContext: channel === 'email' ? EMAIL_OTP_AUTH_CONTEXT : SMS_OTP_AUTH_CONTEXT,
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

export async function handleOtpEmailSend(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('invalid_request')
  const body = validateCredentialBody(otpSendBodySchema, json.value, {
    code: 'invalid_request',
    credentialFields: ['email'],
  })
  await verifyTurnstile(body.turnstileToken, c.env, requestIp(c))
  return sendOtp({
    c,
    channel: 'email',
    target: (body.email ?? '').trim().toLowerCase(),
    profileInput: body,
    organizationId: body.organizationId,
    applicationClientId: body.clientId,
    invitationToken: body.invitationToken,
    intent: body.intent,
    continue: body.continue,
  })
}

export async function handleOtpSmsSend(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('invalid_request')
  const body = validateCredentialBody(otpSendBodySchema, json.value, {
    code: 'invalid_request',
    credentialFields: ['phone'],
  })
  await verifyTurnstile(body.turnstileToken, c.env, requestIp(c))
  return sendOtp({
    c,
    channel: 'sms',
    target: (body.phone ?? '').trim(),
    profileInput: body,
    organizationId: body.organizationId,
    applicationClientId: body.clientId,
    invitationToken: body.invitationToken,
    intent: body.intent,
    continue: body.continue,
  })
}

export async function handleOtpWhatsappSend(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('invalid_request')
  const body = validateCredentialBody(otpSendBodySchema, json.value, {
    code: 'invalid_request',
    credentialFields: ['phone'],
  })
  await verifyTurnstile(body.turnstileToken, c.env, requestIp(c))
  return sendOtp({
    c,
    channel: 'whatsapp',
    target: (body.phone ?? '').trim(),
    profileInput: body,
    organizationId: body.organizationId,
    applicationClientId: body.clientId,
    invitationToken: body.invitationToken,
    intent: body.intent,
    continue: body.continue,
  })
}

export async function handleOtpEmailVerify(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('otp_invalid')
  // email/code 都是凭证:形状失败与错码同 otp_invalid(枚举防护)。
  const body = validateCredentialBody(otpVerifyBodySchema, json.value, {
    code: 'otp_invalid',
    credentialFields: ['email', 'code'],
  })
  return verifyOtp({
    c,
    channel: 'email',
    target: (body.email ?? '').trim().toLowerCase(),
    code: body.code ?? '',
    organizationId: body.organizationId,
    applicationClientId: body.clientId,
    invitationToken: body.invitationToken,
    intent: body.intent,
    continue: body.continue,
  })
}

export async function handleOtpSmsVerify(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('otp_invalid')
  const body = validateCredentialBody(otpVerifyBodySchema, json.value, {
    code: 'otp_invalid',
    credentialFields: ['phone', 'code'],
  })
  return verifyOtp({
    c,
    channel: 'sms',
    target: (body.phone ?? '').trim(),
    code: body.code ?? '',
    organizationId: body.organizationId,
    applicationClientId: body.clientId,
    invitationToken: body.invitationToken,
    intent: body.intent,
    continue: body.continue,
  })
}

export async function handleOtpWhatsappVerify(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('otp_invalid')
  const body = validateCredentialBody(otpVerifyBodySchema, json.value, {
    code: 'otp_invalid',
    credentialFields: ['phone', 'code'],
  })
  return verifyOtp({
    c,
    channel: 'whatsapp',
    target: (body.phone ?? '').trim(),
    code: body.code ?? '',
    organizationId: body.organizationId,
    applicationClientId: body.clientId,
    invitationToken: body.invitationToken,
    intent: body.intent,
    continue: body.continue,
  })
}
