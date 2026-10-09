// Turnstile 对受保护操作的放行状态,以及验证码步骤说明行该说哪一句。

export type TurnstileGate = 'off' | 'checking' | 'needs_interaction' | 'ready'

export function turnstileGate(input: {
  configSettled: boolean
  siteKey: string | null
  token: string | null
  needsInteraction: boolean
}): TurnstileGate {
  if (!input.configSettled) return 'checking'
  if (input.siteKey === null) return 'off'
  if (input.token) return 'ready'
  return input.needsInteraction ? 'needs_interaction' : 'checking'
}

export function turnstilePasses(gate: TurnstileGate): boolean {
  return gate === 'off' || gate === 'ready'
}

export type OtpSendStatus = 'sent' | 'sending' | 'awaiting_check'

export function otpSendStatus(input: {
  sentAt: number | null
  requestInFlight: boolean
  gate: TurnstileGate
}): OtpSendStatus {
  if (input.sentAt !== null) return 'sent'
  if (!input.requestInFlight && input.gate === 'needs_interaction') return 'awaiting_check'
  return 'sending'
}
