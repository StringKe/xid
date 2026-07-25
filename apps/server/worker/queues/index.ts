// Queue Consumers 统一导出 + 按 queue 名分发。
// 见 docs/design/07-platform-operations.md(邮件/审计/计量)、api-sdk-conventions rule(webhook)。
// wrangler.jsonc consumers 队列名:xid-email / xid-audit / xid-webhook / xid-metering。

import type {
  EmailQueueMessage,
  WhatsappQueueMessage,
  SmsQueueMessage,
  AuditQueueMessage,
  WebhookQueueMessage,
  MeteringQueueMessage,
} from '@xid-kit/types'
import { handleEmailBatch } from './email'
import { handleWhatsappBatch } from './whatsapp'
import { handleSmsBatch } from './sms'
import { handleAuditBatch } from './audit'
import { handleWebhookBatch } from './webhook'
import { handleMeteringBatch } from './metering'

export { handleEmailBatch } from './email'
export { handleWhatsappBatch } from './whatsapp'
export { handleSmsBatch } from './sms'
export { handleAuditBatch } from './audit'
export { handleWebhookBatch } from './webhook'
export { handleMeteringBatch } from './metering'

type AnyQueueMessage =
  | EmailQueueMessage
  | WhatsappQueueMessage
  | SmsQueueMessage
  | AuditQueueMessage
  | WebhookQueueMessage
  | MeteringQueueMessage

export const QUEUE_NAMES = {
  email: 'xid-email',
  whatsapp: 'xid-whatsapp',
  sms: 'xid-sms',
  audit: 'xid-audit',
  webhook: 'xid-webhook',
  metering: 'xid-metering',
} as const

// 按 batch.queue 名分发到对应 consumer。
// 未知队列不能确认安全丢弃,必须重试并保留原消息供配置修复后处理。
export async function dispatchQueue(batch: MessageBatch<AnyQueueMessage>, env: Env): Promise<void> {
  switch (batch.queue) {
    case QUEUE_NAMES.email:
      await handleEmailBatch(batch as MessageBatch<EmailQueueMessage>, env)
      return
    case QUEUE_NAMES.whatsapp:
      await handleWhatsappBatch(batch as MessageBatch<WhatsappQueueMessage>, env)
      return
    case QUEUE_NAMES.sms:
      await handleSmsBatch(batch as MessageBatch<SmsQueueMessage>, env)
      return
    case QUEUE_NAMES.audit:
      await handleAuditBatch(batch as MessageBatch<AuditQueueMessage>, env)
      return
    case QUEUE_NAMES.webhook:
      await handleWebhookBatch(batch as MessageBatch<WebhookQueueMessage>, env)
      return
    case QUEUE_NAMES.metering:
      await handleMeteringBatch(batch as MessageBatch<MeteringQueueMessage>, env)
      return
    default:
      batch.retryAll()
  }
}
