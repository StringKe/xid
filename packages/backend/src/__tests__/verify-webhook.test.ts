import { describe, expect, it } from 'vitest'
import { base64UrlDecode, hmacSha256Base64 } from '@xid-kit/crypto'

import { verifyWebhook } from '../verify-webhook'

const NOW = 1_700_000_000
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'

function secretBytes(secret: string): Uint8Array {
  const raw = secret.replace(/^whsec_/, '').replace(/=+$/, '')
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
    const forged = `v1,${await hmacSha256Base64(secretBytes('whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), `${id}.${NOW}.${body}`)}`
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
    const body = '{}'
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
})
