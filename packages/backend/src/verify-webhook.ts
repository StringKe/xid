// verifyWebhook:svix 风格 HMAC-SHA256 webhook 签名验证(见 api-sdk-conventions rule:svix-id/timestamp/signature,HMAC-SHA256,5min 窗防重放)。
// 签名底文 = `${id}.${timestamp}.${body}`,密钥为 whsec_ 前缀的 base64 secret;svix-signature 头含空格分隔的 `v1,<base64sig>` 多签名。
// HMAC 验签复用 @xid-kit/crypto hmacSha256Verify(constant-time 比较),不自研密码学原语。

import type { Result } from '@xid-kit/types'
import { base64UrlDecode, hmacSha256Verify } from '@xid-kit/crypto'

const WHSEC_PREFIX = 'whsec_'
const SIG_VERSION = 'v1'
const DEFAULT_TOLERANCE_SEC = 300

export type VerifyWebhookOptions = {
  // webhook signing secret(svix 格式 `whsec_<base64>` 或裸 base64)。
  secret: string
  // 时间窗容忍(秒),默认 300(5min,见 api-sdk-conventions rule 防重放)。
  toleranceSec?: number
  // 当前时间(秒),默认 now。测试注入用。
  now?: number
}

export type WebhookVerifyError =
  | 'missing_headers'
  | 'invalid_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'no_matching_signature'

export type VerifiedWebhook = {
  id: string
  timestamp: number
  payload: unknown
}

function err(error: WebhookVerifyError): Result<VerifiedWebhook, WebhookVerifyError> {
  return { ok: false, error }
}

// 解析 whsec_ 前缀并 base64url 解码出原始 secret 字节(svix secret 是标准 base64,base64url 解码兼容无填充)。
function decodeSecret(secret: string): Uint8Array {
  const raw = secret.startsWith(WHSEC_PREFIX) ? secret.slice(WHSEC_PREFIX.length) : secret
  return base64UrlDecode(raw)
}

function checkTimestamp(
  raw: string | null,
  now: number,
  tolerance: number,
): { ok: true; value: number } | { ok: false; error: WebhookVerifyError } {
  if (!raw) {
    return { ok: false, error: 'missing_headers' }
  }
  const timestamp = Number.parseInt(raw, 10)
  if (!Number.isFinite(timestamp) || String(timestamp) !== raw.trim()) {
    return { ok: false, error: 'invalid_timestamp' }
  }
  if (Math.abs(now - timestamp) > tolerance) {
    return { ok: false, error: 'timestamp_out_of_tolerance' }
  }
  return { ok: true, value: timestamp }
}

// 校验 svix-signature 头中任一 v1 签名匹配(头可含多签名,密钥轮换期并存)。
async function matchAnySignature(
  secret: Uint8Array,
  signingContent: string,
  signatureHeader: string,
): Promise<boolean> {
  for (const part of signatureHeader.split(' ')) {
    const comma = part.indexOf(',')
    if (comma === -1) {
      continue
    }
    if (part.slice(0, comma) !== SIG_VERSION) {
      continue
    }
    const provided = part.slice(comma + 1)
    if (await hmacSha256Verify(secret, signingContent, provided)) {
      return true
    }
  }
  return false
}

// 验证 webhook Request:取 svix-id/timestamp/signature -> 校验时间窗 -> HMAC 验签底文 `${id}.${ts}.${body}`。
// 可预期失败返回 Result error(缺头/时间窗外/签名不匹配),成功返回解析后的 payload。
export async function verifyWebhook(
  request: Request,
  options: VerifyWebhookOptions,
): Promise<Result<VerifiedWebhook, WebhookVerifyError>> {
  const id = request.headers.get('svix-id')
  const signatureHeader = request.headers.get('svix-signature')
  if (!id || !signatureHeader) {
    return err('missing_headers')
  }

  const now = options.now ?? Math.floor(Date.now() / 1000)
  const tolerance = options.toleranceSec ?? DEFAULT_TOLERANCE_SEC
  const ts = checkTimestamp(request.headers.get('svix-timestamp'), now, tolerance)
  if (!ts.ok) {
    return err(ts.error)
  }

  const body = await request.text()
  const secret = decodeSecret(options.secret)
  const signingContent = `${id}.${ts.value}.${body}`
  if (!(await matchAnySignature(secret, signingContent, signatureHeader))) {
    return err('no_matching_signature')
  }

  return { ok: true, value: { id, timestamp: ts.value, payload: JSON.parse(body) as unknown } }
}
