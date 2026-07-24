import { sha256Hex } from '@xid-kit/crypto'

export type NotificationFailureChannel = 'email' | 'whatsapp' | 'sms'

export type NotificationFailureRecord = {
  tenantId: string | null
  recipient: string
  payload: Record<string, unknown>
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function recipientType(channel: NotificationFailureChannel): 'email' | 'phone' {
  return channel === 'email' ? 'email' : 'phone'
}

function emailDomain(value: string): string | null {
  const at = value.lastIndexOf('@')
  return at > 0 ? value.slice(at + 1).toLowerCase() : null
}

function copyIfString(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = optionalString(source[key])
  if (value !== undefined) target[key] = value
}

function copyIfNumber(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value)) target[key] = value
}

export async function buildNotificationFailureRecord(input: {
  channel: NotificationFailureChannel
  type: string
  recipient: string
  payload: Record<string, unknown>
}): Promise<NotificationFailureRecord> {
  const tenantId = optionalString(input.payload.tenantId) ?? null
  const normalizedRecipient = input.recipient.trim().toLowerCase()
  const type = recipientType(input.channel)
  const recipientHash = await sha256Hex(`${tenantId ?? 'platform'}:${type}:${normalizedRecipient}`)
  const payload: Record<string, unknown> = {
    channel: input.channel,
    type: input.type,
    recipientType: type,
    recipientHash,
    emailDomain: input.channel === 'email' ? emailDomain(normalizedRecipient) : null,
  }

  copyIfString(payload, input.payload, 'tenantId')
  copyIfString(payload, input.payload, 'orgId')
  copyIfString(payload, input.payload, 'userId')
  copyIfString(payload, input.payload, 'locale')
  copyIfString(payload, input.payload, 'purpose')
  copyIfString(payload, input.payload, 'action')
  copyIfNumber(payload, input.payload, 'expiresInMin')

  return {
    tenantId,
    recipient: `sha256:${recipientHash}`,
    payload,
  }
}
