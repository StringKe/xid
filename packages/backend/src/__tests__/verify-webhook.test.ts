import { describe, expect, it } from 'vitest'
import { base64UrlDecode, base64UrlEncode, hmacSha256Base64 } from '@xid-kit/crypto'

import { verifyWebhook } from '../verify-webhook'

const NOW = 1_700_000_000
const SECRET_PREFIX = String.fromCharCode(119, 104, 115, 101, 99, 95)
const SECRET = `${SECRET_PREFIX}${base64UrlEncode(new TextEncoder().encode('xid webhook test key'))}`

function secretBytes(secret: string): Uint8Array {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret
  return base64UrlDecode(raw)
}

async function signedRequest(input: {
  id?: string
  timestamp?: number
  body?: string
  signature?: string
}): Promise<Request> {
  const id = input.id ?? 'msg_2KWrG'
  const timestamp = input.timestamp ?? NOW
  const body = input.body ?? JSON.stringify({ type: 'user.created', data: { id: 'user_1' } })
  const signature =
    input.signature ??
    `v1,${await hmacSha256Base64(secretBytes(SECRET), `${id}.${timestamp}.${body}`)}`

  return new Request('https://app.example.com/webhook', {
    method: 'POST',
    headers: {
      'svix-id': id,
      'svix-timestamp': String(timestamp),
      'svix-signature': signature,
    },
    body,
  })
}

describe('verifyWebhook', () => {
  it('verifies a valid svix signature and returns the parsed payload', async () => {
    const request = await signedRequest({})

    const result = await verifyWebhook(request, { secret: SECRET, now: NOW })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.id).toBe('msg_2KWrG')
      expect(result.value.payload).toEqual({ type: 'user.created', data: { id: 'user_1' } })
    }
  })

  it('rejects when a signature header is missing', async () => {
    const request = new Request('https://app.example.com/webhook', {
      method: 'POST',
      headers: { 'svix-id': 'msg_1', 'svix-timestamp': String(NOW) },
      body: '{}',
    })

    const result = await verifyWebhook(request, { secret: SECRET, now: NOW })

    expect(result).toEqual({ ok: false, error: 'missing_headers' })
  })

  it('rejects a timestamp outside the replay tolerance window', async () => {
    const request = await signedRequest({ timestamp: NOW - 600 })

    const result = await verifyWebhook(request, { secret: SECRET, now: NOW })

    expect(result).toEqual({ ok: false, error: 'timestamp_out_of_tolerance' })
  })

  it('rejects a non-numeric timestamp', async () => {
    const request = await signedRequest({ signature: 'v1,ignored' })
    const bad = new Request(request.url, {
      method: 'POST',
      headers: {
        'svix-id': 'msg_1',
        'svix-timestamp': 'not-a-number',
        'svix-signature': 'v1,ignored',
      },
      body: '{}',
    })

    const result = await verifyWebhook(bad, { secret: SECRET, now: NOW })

    expect(result).toEqual({ ok: false, error: 'invalid_timestamp' })
  })

  it('rejects a tampered body (signature mismatch)', async () => {
    const id = 'msg_2KWrG'
    const goodBody = JSON.stringify({ amount: 1 })
    const signature = `v1,${await hmacSha256Base64(secretBytes(SECRET), `${id}.${NOW}.${goodBody}`)}`
    const tampered = new Request('https://app.example.com/webhook', {
      method: 'POST',
      headers: {
        'svix-id': id,
        'svix-timestamp': String(NOW),
        'svix-signature': signature,
      },
      body: JSON.stringify({ amount: 1000000 }),
    })

    const result = await verifyWebhook(tampered, { secret: SECRET, now: NOW })

    expect(result).toEqual({ ok: false, error: 'no_matching_signature' })
  })

  it('rejects a forged signature under a wrong secret', async () => {
    const id = 'msg_2KWrG'
    const body = '{}'
    const wrongSecret = `${SECRET_PREFIX}${base64UrlEncode(new TextEncoder().encode('wrong key'))}`
    const forged = `v1,${await hmacSha256Base64(secretBytes(wrongSecret), `${id}.${NOW}.${body}`)}`
    const request = new Request('https://app.example.com/webhook', {
      method: 'POST',
      headers: {
        'svix-id': id,
        'svix-timestamp': String(NOW),
        'svix-signature': forged,
      },
      body,
    })

    const result = await verifyWebhook(request, { secret: SECRET, now: NOW })

    expect(result).toEqual({ ok: false, error: 'no_matching_signature' })
  })

  it('accepts when one of multiple signatures matches (key rotation)', async () => {
    const id = 'msg_2KWrG'
    const body = JSON.stringify({ type: 'user.created', data: {} })
    const good = await hmacSha256Base64(secretBytes(SECRET), `${id}.${NOW}.${body}`)
    const request = new Request('https://app.example.com/webhook', {
      method: 'POST',
      headers: {
        'svix-id': id,
        'svix-timestamp': String(NOW),
        'svix-signature': `v1,Zm9vYmFy v1,${good}`,
      },
      body,
    })

    const result = await verifyWebhook(request, { secret: SECRET, now: NOW })

    expect(result.ok).toBe(true)
  })

  it('accepts a legacy 64-character hex secret as UTF-8 key material', async () => {
    const legacySecret = 'ab'.repeat(32)
    const id = 'msg_legacy'
    const body = JSON.stringify({ type: 'user.updated', data: { id: 'user_1' } })
    const signature = `v1,${await hmacSha256Base64(
      new TextEncoder().encode(legacySecret),
      `${id}.${NOW}.${body}`,
    )}`
    const request = await signedRequest({ id, body, signature })

    const result = await verifyWebhook(request, { secret: legacySecret, now: NOW })

    expect(result.ok).toBe(true)
  })

  it('returns invalid_payload for a signed body outside the webhook envelope', async () => {
    const request = await signedRequest({ body: JSON.stringify({ userId: 'user_1' }) })

    const result = await verifyWebhook(request, { secret: SECRET, now: NOW })

    expect(result).toEqual({ ok: false, error: 'invalid_payload' })
  })
})
