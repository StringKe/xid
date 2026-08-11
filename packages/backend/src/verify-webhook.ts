// svix 风格验签:底文 `${id}.${timestamp}.${body}`,多 v1 签名并存以支持密钥轮换,默认 5min 防重放。

import type { Result } from '@xid-kit/types'
import { base64UrlDecode, hmacSha256Verify } from '@xid-kit/crypto'

const WHSEC_PREFIX = 'whsec_'
const SIG_VERSION = 'v1'
const DEFAULT_TOLERANCE_SEC = 300
const LEGACY_HEX_SECRET = /^[0-9a-f]{64}$/u

export type VerifyWebhookOptions = {
  secret: string
  toleranceSec?: number
  now?: number
}

export type WebhookVerifyError =
  | 'missing_headers'
  | 'invalid_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'no_matching_signature'
  | 'invalid_payload'

export type WebhookEventPayload = {
  type: string
  data: unknown
}

export type VerifiedWebhook = {
  id: string
  timestamp: number
  payload: WebhookEventPayload
}

function err(error: WebhookVerifyError): Result<VerifiedWebhook, WebhookVerifyError> {
  return { ok: false, error }
}

// 旧版 secret 为 64 位 hex 的 UTF-8 字节,非 base64;兼容存量订阅直至轮换。
function decodeSecret(secret: string): Uint8Array {
  if (!secret.startsWith(WHSEC_PREFIX) && LEGACY_HEX_SECRET.test(secret)) {
    return new TextEncoder().encode(secret)
  }
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

// 任一 v1 签名匹配即可(轮换期多签名并存)。
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

  let payload: unknown
  try {
    payload = JSON.parse(body) as unknown
  } catch {
    return err('invalid_payload')
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    typeof (payload as Record<string, unknown>)['type'] !== 'string' ||
    !Object.hasOwn(payload, 'data')
  ) {
    return err('invalid_payload')
  }

  return {
    ok: true,
    value: {
      id,
      timestamp: ts.value,
      payload: payload as WebhookEventPayload,
    },
  }
}
