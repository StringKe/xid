// Queue Consumers 统一导出 + 按 queue 名分发。
// 见 docs/design/07-platform-operations.md(邮件/审计/计量)、api-sdk-conventions rule(webhook)。
// wrangler.jsonc consumers 队列名包含通知、审计、webhook、计量、xid-scim-sync 与 privacy。

import type {
  EmailQueueMessage,
  WhatsappQueueMessage,
  SmsQueueMessage,
  AuditQueueMessage,
  WebhookQueueMessage,
  MeteringQueueEnvelope,
  ScimSyncQueueMessage,
  PrivacyQueueMessage,
} from '@xid-kit/types'
import { handleEmailBatch } from './email'
import { handleWhatsappBatch } from './whatsapp'
import { handleSmsBatch } from './sms'
import { handleAuditBatch } from './audit'
import { handleWebhookBatch } from './webhook'
import { handleMeteringBatch } from './metering'
import { handleScimSyncBatch } from './scim-sync'
import { handlePrivacyBatch } from './privacy'
import { DEAD_LETTER_SOURCES, handleDeadLetterBatch } from './dead-letter'

export { handleEmailBatch } from './email'
export { handleWhatsappBatch } from './whatsapp'
export { handleSmsBatch } from './sms'
export { handleAuditBatch } from './audit'
export { handleWebhookBatch } from './webhook'
export { handleMeteringBatch } from './metering'
export { handleScimSyncBatch } from './scim-sync'
export { handlePrivacyBatch } from './privacy'
export {
  DEAD_LETTER_SOURCES,
  deadLetterMetadata,
  handleDeadLetterBatch,
  replayDeadLetter,
} from './dead-letter'

type AnyQueueMessage =
  | EmailQueueMessage
  | WhatsappQueueMessage
  | SmsQueueMessage
  | AuditQueueMessage
  | WebhookQueueMessage
  | MeteringQueueEnvelope
  | ScimSyncQueueMessage
  | PrivacyQueueMessage

export const QUEUE_NAMES = {
  email: 'xid-email',
  whatsapp: 'xid-whatsapp',
  sms: 'xid-sms',
  audit: 'xid-audit',
  webhook: 'xid-webhook',
  metering: 'xid-metering',
  scimSync: 'xid-scim-sync',
  privacy: 'xid-privacy',
} as const

const DEAD_LETTER_QUEUE_NAMES = new Set<string>(
  DEAD_LETTER_SOURCES.map((source) => source.deadLetterQueue),
)

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
      await handleMeteringBatch(batch as MessageBatch<MeteringQueueEnvelope>, env)
      return
    case QUEUE_NAMES.scimSync:
      await handleScimSyncBatch(batch as MessageBatch<ScimSyncQueueMessage>, env)
      return
    case QUEUE_NAMES.privacy:
      await handlePrivacyBatch(batch as MessageBatch<PrivacyQueueMessage>, env)
      return
    default:
      if (DEAD_LETTER_QUEUE_NAMES.has(batch.queue)) {
        await handleDeadLetterBatch(batch as MessageBatch<unknown>, env)
        return
      }
      batch.retryAll()
  }
}
