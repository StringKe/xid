import { sha256Hex } from '@xid-kit/crypto'
import type { AuditQueueMessage } from '@xid-kit/types'

type NotificationAuditInput = {
  messageId: string
  channel: 'email' | 'whatsapp' | 'sms'
  type: string
  recipient: string
  provider: string
  payload: Record<string, unknown>
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function recipientType(channel: NotificationAuditInput['channel']): string {
  return channel === 'email' ? 'email' : 'phone'
}

function emailDomain(value: string): string | null {
  const at = value.lastIndexOf('@')
  return at > 0 ? value.slice(at + 1).toLowerCase() : null
}

function notificationAuditSourceIdentity(input: NotificationAuditInput): string {
  if (input.messageId === '') throw new Error('notification_message_id_missing')
  return `notification:${input.channel}:${input.messageId}`
}

export async function recordNotificationSent(
  env: Env,
  input: NotificationAuditInput,
): Promise<void> {
  const tenantId = optionalString(input.payload.tenantId)
  if (tenantId === undefined) return
  const normalizedRecipient = input.recipient.trim().toLowerCase()
  const type = recipientType(input.channel)
  const auditMessage: AuditQueueMessage = {
    tenantId,
    orgId: optionalString(input.payload.orgId),
    action: 'notification.sent',
    actorId: optionalString(input.payload.userId),
    ts: Date.now(),
    payload: {
      sourceMessageId: notificationAuditSourceIdentity(input),
      channel: input.channel,
      type: input.type,
      provider: input.provider,
      recipientType: type,
      recipientHash: await sha256Hex(`${tenantId}:${type}:${normalizedRecipient}`),
      emailDomain: input.channel === 'email' ? emailDomain(normalizedRecipient) : null,
    },
  }
  await env.AUDIT_QUEUE.send(auditMessage)
}
