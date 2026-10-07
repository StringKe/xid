import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { usageBillingConfiguration, type UsageBillingConfiguration } from '../lib/usage-billing'

const STRIPE_API_BASE = 'https://api.stripe.com'
const STRIPE_REQUEST_TIMEOUT_MS = 10_000
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300

export type StripeEvent = {
  id: string
  type: string
  created: number
  data: {
    object: Record<string, unknown>
  }
}

const stripeEventSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  type: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  created: v.pipe(v.number(), v.integer(), v.minValue(0)),
  data: v.object({
    object: v.record(v.string(), v.unknown()),
  }),
})

const stripeSessionSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  url: v.pipe(v.string(), v.url()),
  expires_at: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
})

export type StripeHostedSession = {
  id: string
  url: string
  expiresAt: number | null
}

export class StripeApiError extends Error {
  readonly status: number

  constructor(status: number) {
    super('stripe_api_request_failed')
    this.name = 'StripeApiError'
    this.status = status
  }
}

// 计费关闭时 Stripe 调用不可用;部分配置由 usageBillingConfiguration 抛 server_error。
export function requireUsageBilling(env: Env): UsageBillingConfiguration {
  const config = usageBillingConfiguration(env)
  if (!config) throw new AppError('service_unavailable', { httpStatus: 503 })
  return config
}

function parseSignatureHeader(header: string): {
  timestamp: number
  signatures: Uint8Array[]
} | null {
  let timestamp: number | null = null
  const signatures: Uint8Array[] = []
  for (const item of header.split(',')) {
    const separator = item.indexOf('=')
    if (separator <= 0) continue
    const key = item.slice(0, separator).trim()
    const value = item.slice(separator + 1).trim()
    if (key === 't' && /^\d{1,16}$/u.test(value)) {
      const parsed = Number(value)
      if (Number.isSafeInteger(parsed)) timestamp = parsed
      continue
    }
    if (key !== 'v1' || !/^[0-9a-f]{64}$/iu.test(value)) continue
    const bytes = new Uint8Array(32)
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
    }
    signatures.push(bytes)
  }
  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures }
}

function constantTimeBytesEqual(actual: Uint8Array, expected: Uint8Array): boolean {
  let diff = actual.length ^ expected.length
  const length = Math.max(actual.length, expected.length)
  for (let index = 0; index < length; index += 1) {
    diff |= (actual[index] ?? 0) ^ (expected[index] ?? 0)
  }
  return diff === 0
}

export async function verifyStripeWebhookSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string,
  secret: string,
  now: Date = new Date(),
): Promise<boolean> {
  const parsed = parseSignatureHeader(signatureHeader)
  if (!parsed) return false
  const nowSeconds = Math.floor(now.getTime() / 1000)
  if (Math.abs(nowSeconds - parsed.timestamp) > STRIPE_WEBHOOK_TOLERANCE_SECONDS) return false

  const encoder = new TextEncoder()
  const prefix = encoder.encode(`${parsed.timestamp}.`)
  const payload = typeof rawBody === 'string' ? encoder.encode(rawBody) : rawBody
  const signedPayload = new Uint8Array(prefix.length + payload.length)
  signedPayload.set(prefix)
  signedPayload.set(payload, prefix.length)
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, signedPayload))
  return parsed.signatures.some((signature) => constantTimeBytesEqual(signature, expected))
}

export function parseStripeEvent(rawBody: string): StripeEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch (cause) {
    throw new AppError('validation_failed', { httpStatus: 400, cause })
  }
  const result = v.safeParse(stripeEventSchema, parsed)
  if (!result.success) throw new AppError('validation_failed', { httpStatus: 400 })
  return result.output
}

async function stripeFormRequest(
  env: Env,
  path: string,
  body: URLSearchParams,
  idempotencyKey?: string,
): Promise<unknown> {
  const secret = requireUsageBilling(env).secretKey
  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/x-www-form-urlencoded',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: body.toString(),
    signal: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new StripeApiError(response.status)
  return response.json()
}

function parseHostedSession(value: unknown): StripeHostedSession {
  const parsed = v.safeParse(stripeSessionSchema, value)
  if (!parsed.success) throw new StripeApiError(502)
  const url = new URL(parsed.output.url)
  if (
    url.protocol !== 'https:' ||
    !(url.hostname === 'stripe.com' || url.hostname.endsWith('.stripe.com'))
  ) {
    throw new StripeApiError(502)
  }
  return {
    id: parsed.output.id,
    url: parsed.output.url,
    expiresAt: parsed.output.expires_at === undefined ? null : parsed.output.expires_at * 1000,
  }
}

export async function createStripePortalSession(
  env: Env,
  input: { customerId: string; returnUrl: string },
): Promise<StripeHostedSession> {
  const body = new URLSearchParams({
    customer: input.customerId,
    return_url: input.returnUrl,
  })
  return parseHostedSession(await stripeFormRequest(env, '/v1/billing_portal/sessions', body))
}

export async function createStripeMeterEvent(
  env: Env,
  input: {
    eventName: string
    identifier: string
    customerId: string
    value: number
    timestampSeconds: number
  },
): Promise<void> {
  const body = new URLSearchParams({
    event_name: input.eventName,
    identifier: input.identifier,
    timestamp: String(input.timestampSeconds),
    'payload[stripe_customer_id]': input.customerId,
    'payload[value]': String(input.value),
  })
  await stripeFormRequest(env, '/v1/billing/meter_events', body, input.identifier)
}
