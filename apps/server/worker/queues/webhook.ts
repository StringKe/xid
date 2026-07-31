// Webhook Queue Consumer:svix 风格 HMAC-SHA256 签名投递。
// 见 docs/design/06-developer-experience.md webhook 节、api-sdk-conventions rule。
// - 签名:signedContent = `${svix-id}.${svix-timestamp}.${payload}`,
//   svix-signature: `v1,${base64(HMAC-SHA256(secret, signedContent))}`,5min 时间窗防重放。
// - signing secret 用 AES-256-GCM 信封加密存 D1(三 blob:iv/ciphertext/tag),
//   KEK 存 Workers Secrets,运行时 envelopeDecrypt 解密后作 HMAC key(见 signing-keys rule)。
// - 投递失败指数退避重试,超限死信 -> D1 webhook_deliveries.status='dead'。
// - markDead 用投递时的订阅快照,不重新拉取,避免死信与实际投递集不一致。
// - 手动重放接口预留(按 delivery id / 时间区间从 D1 重新投 Queue)。

import type { WebhookQueueMessage } from '@xid-kit/types'
import {
  hmacSha256Base64,
  envelopeDecrypt,
  base64UrlDecode,
  base64UrlEncodeString,
} from '@xid-kit/crypto'
import { isPublicHttpsUrl } from '../lib/validate'
import { logWorkerError } from '../lib/safe-log'

const MAX_ATTEMPTS = 5
const BACKOFF_BASE_SECONDS = 2
const BACKOFF_START_EXP = 2
const SIGNATURE_VERSION = 'v1'
const DELIVERY_TIMEOUT_MS = 10_000
const DELIVERY_CLAIM_LEASE_MS = 15_000

export type WebhookSubscription = {
  id: string
  url: string
  signingSecret: Uint8Array
}

export type SvixHeaders = {
  'svix-id': string
  'svix-timestamp': string
  'svix-signature': string
}

// 构造 svix 签名头(payload 为已序列化的 JSON 字符串)。
export async function signWebhook(
  secret: Uint8Array,
  msgId: string,
  timestampSeconds: number,
  payload: string,
): Promise<SvixHeaders> {
  const signedContent = `${msgId}.${timestampSeconds}.${payload}`
  const signature = await hmacSha256Base64(secret, signedContent)
  return {
    'svix-id': msgId,
    'svix-timestamp': String(timestampSeconds),
    'svix-signature': `${SIGNATURE_VERSION},${signature}`,
  }
}

function backoffSeconds(attempt: number): number {
  return BACKOFF_BASE_SECONDS ** (BACKOFF_START_EXP + attempt)
}

function deliveryMessageId(queueMessageId: string, webhookId: string): string {
  return `msg_${base64UrlEncodeString(`${queueMessageId}:${webhookId}`)}`
}

// KEK Workers Secret 注入为 base64 标准编码的 32 字节字符串。
// 每次调用时从 env.KEK 解码,避免模块级常量持有密钥材料(见 tenant-context rule 铁律)。
function decodeKek(kekB64: string): Uint8Array {
  const binary = atob(kekB64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// 查询某租户订阅了该事件的 active webhook,解密信封加密的签名 secret。
// signing_secret_iv / signing_secret_ciphertext / signing_secret_tag 三 blob base64url 编码。
// 旧行(三 blob 为 null)视为不可投递,跳过(日志警告),避免用哈希错误签名。
async function findSubscriptions(
  env: Env,
  tenantId: string,
  event: string,
): Promise<WebhookSubscription[]> {
  type Row = {
    id: string
    url: string
    event_types: string
    signing_secret_iv: string | null
    signing_secret_ciphertext: string | null
    signing_secret_tag: string | null
  }
  const result = await env.DB.prepare(
    `SELECT id, url, event_types,
            signing_secret_iv, signing_secret_ciphertext, signing_secret_tag
       FROM webhooks WHERE tenant_id = ? AND status = 'active'`,
  )
    .bind(tenantId)
    .all<Row>()
  const kekRaw = decodeKek(env.KEK)
  const subs: WebhookSubscription[] = []
  for (const row of result.results) {
    const types = parseEventTypes(row.event_types)
    if (!matchesEvent(types, event)) {
      continue
    }
    if (
      row.signing_secret_iv === null ||
      row.signing_secret_ciphertext === null ||
      row.signing_secret_tag === null
    ) {
      // 旧行缺少信封加密列,跳过投递避免用错误密钥签名。
      logWorkerError('webhook.signing_secret.missing', undefined, {
        component: 'webhook',
        operation: 'load-subscription',
        outcome: 'skipped',
      })
      continue
    }
    const blob = {
      iv: base64UrlDecode(row.signing_secret_iv),
      ciphertext: base64UrlDecode(row.signing_secret_ciphertext),
      tag: base64UrlDecode(row.signing_secret_tag),
      kekVersion: 1,
    }
    const signingSecret = await envelopeDecrypt(blob, kekRaw)
    subs.push({ id: row.id, url: row.url, signingSecret })
  }
  return subs
}

function parseEventTypes(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

// 事件匹配:精确匹配或通配 `<object>.*` 或全局 `*`。
function matchesEvent(types: string[], event: string): boolean {
  const object = event.split('.')[0] ?? ''
  return types.some((t) => t === '*' || t === event || t === `${object}.*`)
}

// 导出供单测覆盖 SSRF 守卫与 redirect 行为(与 resolveRedirect 同例)。
export async function deliver(
  sub: WebhookSubscription,
  event: string,
  payload: string,
  headers: SvixHeaders,
): Promise<number> {
  // 防御深度:URL 入库前已过 publicHttpsUrlSchema,投递侧再挡一次(旧行/直写 DB 的存量数据)。
  // redirect: 'manual' 拒 302 二跳,防公网 URL 跳回内网绕过入库校验。
  if (!isPublicHttpsUrl(sub.url)) throw new Error('webhook url blocked by SSRF guard')
  const response = await fetch(sub.url, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      'xid-webhook-event': event,
      ...headers,
    },
    body: payload,
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  })
  return response.status
}

type DeliveryClaim = {
  id: string
  key: string
}

type DeliveryClaimResult = DeliveryClaim | 'retry' | null

function serializeWebhookPayload(message: WebhookQueueMessage): string {
  return JSON.stringify({
    type: message.event,
    data: message.payload,
  })
}

async function claimDelivery(input: {
  env: Env
  message: WebhookQueueMessage
  queueMessageId: string
  sub: WebhookSubscription
  attempts: number
}): Promise<DeliveryClaimResult> {
  const key = deliveryMessageId(input.queueMessageId, input.sub.id)
  const id = crypto.randomUUID()
  const now = Date.now()
  const leaseUntil = now + DELIVERY_CLAIM_LEASE_MS
  const result = await input.env.DB.prepare(
    `INSERT INTO webhook_deliveries
      (id, delivery_key, tenant_id, webhook_id, event_type, payload, status, attempt_count, response_status, next_retry_at, delivered_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, NULL, ?, ?)
     ON CONFLICT(delivery_key) DO NOTHING`,
  )
    .bind(
      id,
      key,
      input.message.tenantId,
      input.sub.id,
      input.message.event,
      serializeWebhookPayload(input.message),
      input.attempts,
      leaseUntil,
      now,
      now,
    )
    .run()
  if (result?.meta?.changes === undefined || result.meta.changes === 1) return { id, key }

  const existing = await input.env.DB.prepare(
    `SELECT status FROM webhook_deliveries WHERE delivery_key = ?`,
  )
    .bind(key)
    .first<{ status: string }>()
  if (!existing) return 'retry'
  if (existing.status === 'delivered' || existing.status === 'dead') return null

  const reclaimed = await input.env.DB.prepare(
    `UPDATE webhook_deliveries
       SET id = ?, attempt_count = ?, next_retry_at = ?, updated_at = ?
       WHERE delivery_key = ? AND status = 'pending'
         AND (next_retry_at IS NULL OR next_retry_at <= ?)`,
  )
    .bind(id, input.attempts, leaseUntil, now, key, now)
    .run()
  return reclaimed?.meta?.changes === undefined || reclaimed.meta.changes === 1
    ? { id, key }
    : 'retry'
}

async function markDeliverySucceeded(
  env: Env,
  claim: DeliveryClaim,
  attempts: number,
  responseStatus: number,
): Promise<boolean> {
  const now = Date.now()
  const result = await env.DB.prepare(
    `UPDATE webhook_deliveries
       SET status = 'delivered', attempt_count = ?, response_status = ?, next_retry_at = NULL, delivered_at = ?, updated_at = ?
       WHERE id = ? AND delivery_key = ? AND status = 'pending'`,
  )
    .bind(attempts, responseStatus, now, now, claim.id, claim.key)
    .run()
  return result.meta.changes === undefined || result.meta.changes === 1
}

async function releaseDeliveryClaim(env: Env, claim: DeliveryClaim): Promise<boolean> {
  const result = await env.DB.prepare(
    `DELETE FROM webhook_deliveries WHERE id = ? AND delivery_key = ? AND status = 'pending'`,
  )
    .bind(claim.id, claim.key)
    .run()
  return result.meta.changes === undefined || result.meta.changes === 1
}

async function markDeliveryDead(
  env: Env,
  claim: DeliveryClaim,
  attempts: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE webhook_deliveries
       SET status = 'dead', attempt_count = ?, updated_at = ?
       WHERE id = ? AND delivery_key = ? AND status = 'pending'`,
  )
    .bind(attempts, Date.now(), claim.id, claim.key)
    .run()
  return result.meta.changes === undefined || result.meta.changes === 1
}

type DeliveryAttemptResult = {
  ok: boolean
  mustRetry: boolean
}

// 向单个订阅投递并记录,返回是否 2xx 成功。嵌套下沉到此辅助函数。
async function deliverToSub(args: {
  env: Env
  message: WebhookQueueMessage
  queueMessageId: string
  sub: WebhookSubscription
  timestampSeconds: number
  payload: string
  attempts: number
}): Promise<DeliveryAttemptResult> {
  const { env, message, queueMessageId, sub, timestampSeconds, payload, attempts } = args
  const claimResult = await claimDelivery({ env, message, queueMessageId, sub, attempts })
  if (claimResult === null) return { ok: true, mustRetry: false }
  if (claimResult === 'retry') return { ok: false, mustRetry: true }
  const claim = claimResult
  const msgId = deliveryMessageId(queueMessageId, sub.id)
  const headers = await signWebhook(sub.signingSecret, msgId, timestampSeconds, payload)
  let status: number
  try {
    status = await deliver(sub, message.event, payload, headers)
  } catch {
    if (attempts >= MAX_ATTEMPTS) {
      const marked = await markDeliveryDead(env, claim, attempts)
      return { ok: false, mustRetry: !marked }
    } else {
      await releaseDeliveryClaim(env, claim)
    }
    return { ok: false, mustRetry: true }
  }
  const ok = status >= 200 && status < 300
  if (ok) {
    const marked = await markDeliverySucceeded(env, claim, attempts, status)
    return { ok: marked, mustRetry: !marked }
  } else if (attempts >= MAX_ATTEMPTS) {
    const marked = await markDeliveryDead(env, claim, attempts)
    return { ok: false, mustRetry: !marked }
  } else {
    await releaseDeliveryClaim(env, claim)
    return { ok: false, mustRetry: true }
  }
}

type DeliverResult = {
  // 投递时解析的订阅快照(用于 markDead,避免死信时重新拉取导致集合不一致)。
  subs: WebhookSubscription[]
  allOk: boolean
  mustRetry: boolean
}

// 单条消息全量投递。返回订阅快照 + 全部成功标志,快照供 markDead 复用。
async function deliverMessage(args: {
  env: Env
  queueMessageId: string
  message: WebhookQueueMessage
  timestampSeconds: number
  attempts: number
}): Promise<DeliverResult> {
  const { env, queueMessageId, message, timestampSeconds, attempts } = args
  const subs = await findSubscriptions(env, message.tenantId, message.event)
  const payload = serializeWebhookPayload(message)
  let allOk = true
  let mustRetry = false
  for (const sub of subs) {
    const result = await deliverToSub({
      env,
      message,
      queueMessageId,
      sub,
      timestampSeconds,
      payload,
      attempts,
    })
    if (!result.ok) {
      allOk = false
    }
    if (result.mustRetry) mustRetry = true
  }
  return { subs, allOk, mustRetry }
}

// 按单条消息独立 ack/retry/dead,返回是否需落死信。
function settle(
  message: Message<WebhookQueueMessage>,
  attempt: number,
  result: Pick<DeliverResult, 'allOk' | 'mustRetry'>,
): void {
  if (result.mustRetry) {
    message.retry({ delaySeconds: backoffSeconds(attempt) })
    return
  }
  if (result.allOk) {
    message.ack()
    return
  }
  if (attempt >= MAX_ATTEMPTS) {
    message.ack()
    return
  }
  message.retry({ delaySeconds: backoffSeconds(attempt) })
}

export async function handleWebhookBatch(
  batch: MessageBatch<WebhookQueueMessage>,
  env: Env,
): Promise<void> {
  const timestampSeconds = Math.floor(Date.now() / 1000)
  for (const message of batch.messages) {
    const attempt = message.attempts
    try {
      const result = await deliverMessage({
        env,
        queueMessageId: message.id,
        message: message.body,
        timestampSeconds,
        attempts: attempt + 1,
      })
      settle(message, attempt, result)
    } catch {
      settle(message, attempt, { allOk: false, mustRetry: false })
    }
  }
}
