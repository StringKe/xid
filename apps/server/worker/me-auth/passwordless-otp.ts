// passwordless OTP 发送:otp/email|whatsapp|sms/send(前端 useSignIn)。
// 复用 auth/otp.ts persistAndSendOtp(单一真相源,不重复实现 token 逻辑);限流 + 枚举防护(统一 200)。

import { createTenantDb } from '@xid-kit/db'
import { defaultLandingPathFor } from '@xid-kit/types'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateCredentialBody } from '../lib/validate'
import {
  persistAndSendOtp,
  reserveOtpSendRateLimit,
  resolveTargetUserId,
  validatePhoneOtpTarget,
} from '../auth/otp'
import type { OtpChannel } from '../auth/otp'
import { requestIp, verifyTurnstile } from './shared'
import {
  assertEmailAllowed,
  assertMethodAllowedWithCapabilities,
  assertMethodAvailableWithCapabilities,
} from '../auth/hosted-policy'
import { auditPolicyDeniedError } from '../auth/hosted-audit'
import { normalizeProfileFields } from '../auth/profile-fields'
import type { ProfileFieldInput } from '../auth/profile-fields'
import {
  attachPasswordlessEmail,
  attachPasswordlessPhone,
  createPasswordlessEmailUser,
  createPasswordlessPhoneUser,
  shouldSkipDefaultMembership,
} from './passwordless-users'
import { loadGuestConversionContext } from './guest-conversion'
import { withTenant } from './instance-login'
import { createPasswordlessFlowContext } from '../auth/passwordless-flow'
import {
  hasPasswordlessCapability,
  identifierTypeForChannel,
  methodForChannel,
  nullableString,
  otpTarget,
  resolveOtpTenant,
  startInvitationClaimOpaque,
} from './passwordless-otp-shared'
import type { OtpRouteOptions } from './passwordless-otp-shared'

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

type OtpSendInput = OtpRouteOptions & {
  c: Context<XidHonoEnv>
  channel: OtpChannel
  target: string
  profileInput: ProfileFieldInput
}

type Tenant = XidHonoEnv['Variables']['tenant']
type CreateUserInput = {
  c: Context<XidHonoEnv>
  tenant: Tenant
  db: ReturnType<typeof createTenantDb>
  channel: OtpChannel
  target: string
  profileInput: ProfileFieldInput
  skipDefaultMembership: boolean
}

// 新目标:有 guest session 时把联系方式挂到 guest user(转正),否则建 passwordless 用户。
async function createOrAttachOtpUser(input: CreateUserInput): Promise<string> {
  const { c, tenant, db, channel, target, profileInput, skipDefaultMembership } = input
  assertMethodAllowedWithCapabilities(
    tenant,
    methodForChannel(channel),
    'user_creation',
    hasPasswordlessCapability(c, tenant),
  )
  const guest = await loadGuestConversionContext(c, db)
  const base = { db, tenantId: tenant.tenantId }
  if (guest) {
    if (channel === 'email') {
      await attachPasswordlessEmail({ ...base, userId: guest.userId, email: target })
    } else {
      await attachPasswordlessPhone({ ...base, userId: guest.userId, phone: target })
    }
    return guest.userId
  }
  const contact = channel === 'email' ? { email: target } : { phone: target }
  const profile = normalizeProfileFields(tenant, profileInput, contact)
  if (profile.email) assertEmailAllowed(tenant, profile.email)
  const created = { ...base, d1: c.env.DB, profile, skipDefaultMembership }
  return channel === 'email'
    ? createPasswordlessEmailUser({ ...created, email: target })
    : createPasswordlessPhoneUser({ ...created, phone: target })
}

async function sendOtp(input: OtpSendInput): Promise<Response> {
  const { c, channel, target, profileInput, invitationToken, intent } = input
  if (!target) throw new AppError('invalid_request')
  if (invitationToken?.trim()) {
    await startInvitationClaimOpaque(c, invitationToken)
    return c.json({ ok: true })
  }
  const tenant = await resolveOtpTenant(c, {
    channel,
    target,
    organizationId: input.organizationId,
    intent,
    applicationClientId: input.applicationClientId,
  })
  if (channel !== 'email' && !validatePhoneOtpTarget(target)) {
    throw new AppError('invalid_request')
  }
  const method = methodForChannel(channel)
  const identifier = { type: identifierTypeForChannel(channel), value: target }
  try {
    assertMethodAvailableWithCapabilities(tenant, method, hasPasswordlessCapability(c, tenant))
    if (channel === 'email') assertEmailAllowed(tenant, target)
  } catch (error) {
    await auditPolicyDeniedError(c, error, { tenant, method, action: 'availability', identifier })
    return c.json({ ok: true })
  }
  const flow = createPasswordlessFlowContext({
    intent,
    continuePath: input.continue,
    applicationClientId: input.applicationClientId,
    defaultContinuePath: defaultLandingPathFor(tenant),
  })

  await reserveOtpSendRateLimit(c.env, target, tenant.tenantId, { ip: requestIp(c) })

  const db = createTenantDb(c.env.DB, tenant)
  let userId = await resolveTargetUserId(db, channel, target)
  const action = userId ? 'login' : 'user_creation'
  try {
    if (userId) {
      assertMethodAllowedWithCapabilities(
        tenant,
        method,
        'login',
        hasPasswordlessCapability(c, tenant),
      )
    } else {
      userId = await createOrAttachOtpUser({
        c,
        tenant,
        db,
        channel,
        target,
        profileInput,
        skipDefaultMembership: shouldSkipDefaultMembership({
          redirectAfterLogin: flow.continuePath,
          invitationToken,
          intent: flow.intent,
        }),
      })
    }
  } catch (error) {
    await auditPolicyDeniedError(c, error, { tenant, method, action, identifier })
    return c.json({ ok: true })
  }

  const resolvedUserId = userId
  await withTenant(c, tenant, () =>
    persistAndSendOtp({
      c,
      db,
      tenantId: tenant.tenantId,
      channel,
      target,
      userId: resolvedUserId,
      flowContext: flow,
    }),
  )
  return c.json({ ok: true })
}

function otpSendHandler(channel: OtpChannel): (c: Context<XidHonoEnv>) => Promise<Response> {
  return async (c) => {
    const json = await readJsonBody(c)
    if (!json.ok) throw new AppError('invalid_request')
    const body = validateCredentialBody(otpSendBodySchema, json.value, {
      code: 'invalid_request',
      credentialFields: [identifierTypeForChannel(channel)],
    })
    await verifyTurnstile(body.turnstileToken, c.env, requestIp(c))
    return sendOtp({
      c,
      channel,
      target: otpTarget(channel, body, 'invalid_request'),
      profileInput: body,
      organizationId: body.organizationId,
      applicationClientId: body.clientId,
      invitationToken: body.invitationToken,
      intent: body.intent,
      continue: body.continue,
    })
  }
}

export const handleOtpEmailSend = otpSendHandler('email')
export const handleOtpSmsSend = otpSendHandler('sms')
export const handleOtpWhatsappSend = otpSendHandler('whatsapp')
