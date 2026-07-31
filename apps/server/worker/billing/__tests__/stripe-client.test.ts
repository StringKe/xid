import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../lib/errors'
import {
  createStripeCheckoutSession,
  createStripeMeterEvent,
  parseStripeEvent,
  retrieveStripeCheckoutSession,
  verifyStripeWebhookSignature,
} from '../stripe-client'

function env(overrides: Partial<Env> = {}): Env {
  return {
    STRIPE_SECRET_KEY: 'sk_test_local',
    STRIPE_WEBHOOK_SECRET: 'whsec_local',
    STRIPE_STARTER_PRICE_ID: 'price_starter',
    STRIPE_PRO_PRICE_ID: 'price_pro',
    STRIPE_ENTERPRISE_PRICE_ID: 'price_enterprise',
    STRIPE_METER_EVENT_NAME: 'xid_mau',
    ...overrides,
  } as Env
}

async function signature(secret: string, timestamp: number, body: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`)),
  )
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Stripe Worker boundary', () => {
  it('verifies a raw-body v1 signature and rejects stale or wrong signatures', async () => {
    const body = JSON.stringify({ id: 'evt_1' })
    const now = new Date('2026-07-28T12:00:00.000Z')
    const timestamp = Math.floor(now.getTime() / 1000)
    const digest = await signature('whsec_local', timestamp, body)

    await expect(
      verifyStripeWebhookSignature(
        body,
        `t=${timestamp},v0=${'0'.repeat(64)},v1=${digest}`,
        'whsec_local',
        now,
      ),
    ).resolves.toBe(true)
    await expect(
      verifyStripeWebhookSignature(
        body,
        `t=${timestamp - 301},v1=${await signature('whsec_local', timestamp - 301, body)}`,
        'whsec_local',
        now,
      ),
    ).resolves.toBe(false)
    await expect(
      verifyStripeWebhookSignature(body, `t=${timestamp},v1=${'0'.repeat(64)}`, 'whsec_local', now),
    ).resolves.toBe(false)
  })

  it('validates the external event envelope before business processing', () => {
    expect(
      parseStripeEvent(
        JSON.stringify({
          id: 'evt_1',
          type: 'checkout.session.completed',
          created: 1_785_240_000,
          data: { object: { customer: 'cus_1' } },
        }),
      ),
    ).toMatchObject({ id: 'evt_1', type: 'checkout.session.completed' })
    expect(() => parseStripeEvent('{"type":"missing-id"}')).toThrow(AppError)
    expect(() => parseStripeEvent('{')).toThrow(AppError)
  })

  it('creates a subscription Checkout Session with internal reconciliation metadata', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'cs_test_1',
          url: 'https://checkout.stripe.com/c/pay/cs_test_1',
          expires_at: 1_785_326_400,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      createStripeCheckoutSession(env(), {
        tenantId: 'org_1',
        plan: 'starter',
        customerId: null,
        successUrl: 'https://xid.example/console/platform/plans?tenantId=org_1&checkout=success',
        cancelUrl: 'https://xid.example/console/platform/plans?tenantId=org_1&checkout=canceled',
        idempotencyKey: 'checkout_1',
      }),
    ).resolves.toEqual({
      id: 'cs_test_1',
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
      expiresAt: 1_785_326_400_000,
    })

    const [, request] = fetchMock.mock.calls[0]!
    const body = new URLSearchParams(String(request?.body))
    expect(body.get('mode')).toBe('subscription')
    expect(body.get('line_items[0][price]')).toBe('price_starter')
    expect(body.get('metadata[xid_tenant_id]')).toBe('org_1')
    expect(body.get('subscription_data[metadata][xid_plan]')).toBe('starter')
    expect(new Headers(request?.headers).get('idempotency-key')).toBe('checkout_1')
  })

  it('retrieves authoritative Checkout status before replacing an elapsed hosted session', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'cs_test_1',
          status: 'complete',
          expires_at: 1_785_326_400,
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(retrieveStripeCheckoutSession(env(), 'cs_test_1')).resolves.toEqual({
      id: 'cs_test_1',
      status: 'complete',
      expiresAt: 1_785_326_400_000,
    })
    const [url, request] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_test_1')
    expect(request?.method).toBeUndefined()
  })

  it('reports an idempotent Billing meter event with the accepted form contract', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ object: 'billing.meter_event' })))
    vi.stubGlobal('fetch', fetchMock)

    await createStripeMeterEvent(env(), {
      eventName: 'xid_mau',
      identifier: 'xid_mau_org_1_2026_07_42',
      customerId: 'cus_1',
      value: 7,
      timestampSeconds: 1_785_240_000,
    })

    const [url, request] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.stripe.com/v1/billing/meter_events')
    const body = new URLSearchParams(String(request?.body))
    expect(body.get('event_name')).toBe('xid_mau')
    expect(body.get('identifier')).toBe('xid_mau_org_1_2026_07_42')
    expect(body.get('payload[stripe_customer_id]')).toBe('cus_1')
    expect(body.get('payload[value]')).toBe('7')
  })

  it('fails closed when the optional adapter is only partially configured', async () => {
    await expect(
      createStripeCheckoutSession(env({ STRIPE_SECRET_KEY: undefined }), {
        tenantId: 'org_1',
        plan: 'starter',
        customerId: null,
        successUrl: 'https://xid.example/success',
        cancelUrl: 'https://xid.example/cancel',
        idempotencyKey: 'checkout_1',
      }),
    ).rejects.toMatchObject({ code: 'service_unavailable', httpStatus: 503 })
  })
})
