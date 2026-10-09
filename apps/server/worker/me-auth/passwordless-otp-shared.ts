// passwordless OTP 发送与验证共用:渠道到登录方式的映射、投递能力、租户解析和目标规范化。

import { normalizePhoneNumber } from '@xid-kit/types'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import type { OtpChannel } from '../auth/otp'
import type { HostedAuthMethod } from '../auth/hosted-policy'
import { smsDeliveryReady, whatsappDeliveryReady } from '../auth/delivery-channels'
import { resolveEntryTenant } from './instance-login'
import { startInvitationEmailClaim } from './invitation-claim-start'

export type OtpRouteOptions = {
  organizationId?: string | null
  applicationClientId?: string | null
  invitationToken?: string | null
  intent?: string | null
  continue?: string | null
}

export const nullableString = v.optional(v.nullable(v.string()))

export function identifierTypeForChannel(channel: OtpChannel): 'email' | 'phone' {
  return channel === 'email' ? 'email' : 'phone'
}

export function methodForChannel(channel: OtpChannel): 'emailOtp' | 'whatsappOtp' | 'smsOtp' {
  if (channel === 'email') return 'emailOtp'
  return channel === 'whatsapp' ? 'whatsappOtp' : 'smsOtp'
}

export function hasPasswordlessCapability(
  c: Context<XidHonoEnv>,
  tenant: XidHonoEnv['Variables']['tenant'],
): (method: HostedAuthMethod) => boolean {
  return (method) =>
    (method !== 'whatsappOtp' || whatsappDeliveryReady(tenant, c.env)) &&
    (method !== 'smsOtp' || smsDeliveryReady(tenant, c.env))
}

// send 与 verify 共用:两端必须解析到同一租户,否则验证码写在 A、校验去 B 查。
export async function resolveOtpTenant(
  c: Context<XidHonoEnv>,
  input: {
    channel: OtpChannel
    target: string
    organizationId?: string | null
    intent?: string | null
    applicationClientId?: string | null
  },
): Promise<XidHonoEnv['Variables']['tenant']> {
  const identifier =
    input.channel === 'email'
      ? ({ kind: 'email', value: input.target } as const)
      : ({ kind: 'phone', value: input.target } as const)
  return resolveEntryTenant(c, identifier, input.organizationId, {
    intent: input.intent,
    applicationClientId: input.applicationClientId,
  })
}

// 手机号统一为 E.164 后再进入租户解析、限流、查库和建号;无法规范化的输入按凭证形状失败处理。
// email/phone/code 都是凭证字段:形状失败与错码同一不透明响应(枚举防护)。
export function otpTarget(
  channel: OtpChannel,
  body: { email?: string; phone?: string },
  invalidCode: 'invalid_request' | 'otp_invalid',
): string {
  if (channel === 'email') return (body.email ?? '').trim().toLowerCase()
  const phone = normalizePhoneNumber(body.phone ?? '')
  if (!phone) throw new AppError(invalidCode)
  return phone
}

export async function startInvitationClaimOpaque(
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
