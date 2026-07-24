const REDACTED = '[redacted]'

const SENSITIVE_EXACT_KEYS = new Set([
  'authorization',
  'cookie',
  'currentpassword',
  'newpassword',
  'oldpassword',
  'password',
  'query',
  'samlresponse',
])

const SAFE_EXACT_KEYS = new Set([
  'emaildomain',
  'errorcode',
  'recipienthash',
  'recipienttype',
  'statuscode',
])

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isSafeAuditKey(normalizedKey: string): boolean {
  return SAFE_EXACT_KEYS.has(normalizedKey) || normalizedKey.endsWith('hash')
}

function isSensitiveAuditKey(key: string): boolean {
  const normalizedKey = normalizeKey(key)
  if (isSafeAuditKey(normalizedKey)) return false
  if (SENSITIVE_EXACT_KEYS.has(normalizedKey)) return true
  if (normalizedKey.includes('email')) return true
  if (normalizedKey.includes('phone')) return true
  if (normalizedKey.includes('recipient')) return true
  if (normalizedKey.includes('token')) return true
  if (normalizedKey.includes('secret')) return true
  if (normalizedKey.includes('credential')) return true
  if (normalizedKey.includes('otp')) return true
  if (normalizedKey.includes('link')) return true
  if (normalizedKey.endsWith('url')) return true
  if (normalizedKey === 'code') return true
  if (
    normalizedKey.endsWith('code') &&
    normalizedKey !== 'errorcode' &&
    normalizedKey !== 'statuscode'
  ) {
    return true
  }
  return false
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function redactAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactAuditValue(item))
  if (isPlainRecord(value)) return redactAuditPayload(value)
  return value
}

export function redactAuditPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    redacted[key] = isSensitiveAuditKey(key) ? REDACTED : redactAuditValue(value)
  }
  return redacted
}
