// 通知投递的身份与输入:outbox 生产侧和 consumer 状态机共用同一个 (tenant, channel:messageId) 身份。

export type NotificationChannel = 'email' | 'sms' | 'whatsapp'

export type NotificationDeliveryInput = {
  messageId: string
  deliveryKey?: string
  tenantId: string | undefined
  channel: NotificationChannel
  type: string
  provider: string
  recipient: string
  payload: Record<string, unknown>
}

export function notificationDeliveryIdentity(
  input: Pick<NotificationDeliveryInput, 'channel' | 'messageId'>,
): string {
  if (input.messageId === '') throw new Error('notification_message_id_missing')
  return `${input.channel}:${input.messageId}`
}

export function notificationDeliveryKey(input: NotificationDeliveryInput): string {
  return input.deliveryKey ?? notificationDeliveryIdentity(input)
}

export function requiredTenantId(tenantId: string | undefined): string {
  if (tenantId === undefined || tenantId === '') throw new Error('notification_tenant_missing')
  return tenantId
}
