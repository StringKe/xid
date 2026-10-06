// 各登录方式请求体的共享部分:组织选择 + Hosted Auth 续跑字段 + 单次 Turnstile token。
// 凭证字段(identifier / password / code)由各 mutation 自己放。

import type { OtpSignInMethod } from './shared'
import type { SignInFlowFields } from './sign-in-flow'

type OtpTarget = { channel: 'email' | 'whatsapp' | 'sms'; field: 'email' | 'phone' }

const OTP_TARGETS: Readonly<Record<OtpSignInMethod, OtpTarget>> = {
  'otp-email': { channel: 'email', field: 'email' },
  'otp-whatsapp': { channel: 'whatsapp', field: 'phone' },
  'otp-sms': { channel: 'sms', field: 'phone' },
}

export function otpTarget(method: OtpSignInMethod): OtpTarget {
  return OTP_TARGETS[method]
}

export function otpEndpoint(method: OtpSignInMethod, step: 'send' | 'verify'): string {
  return `/auth/otp/${OTP_TARGETS[method].channel}/${step}`
}

export function buildFlowPayload(input: {
  organizationId: string | null
  flowFields: SignInFlowFields
  turnstileToken?: string | null
}): Record<string, unknown> {
  return {
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    ...input.flowFields,
    ...(input.turnstileToken === undefined ? {} : { turnstileToken: input.turnstileToken }),
  }
}

// 多组织 identifier:把输入写回 login_hint,让 /auth/config 重新解析并展示组织选择。
export function organizationSelectionPath(
  search: Readonly<Record<string, string | undefined>>,
  identifier: string,
): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(search)) {
    if (value) params.set(key, String(value))
  }
  params.set('login_hint', identifier.trim())
  params.delete('organization_id')
  return `/sign-in?${params.toString()}`
}
