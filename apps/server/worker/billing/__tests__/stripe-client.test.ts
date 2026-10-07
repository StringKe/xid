import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../lib/errors'
import { billingEnabled } from '../../lib/usage-billing'
import {
  createStripeMeterEvent,
  createStripePortalSession,
  parseStripeEvent,
  verifyStripeWebhookSignature,
} from '../stripe-client'

function env(overrides: Partial<Env> = {}): Env {
  return {
    STRIPE_SECRET_KEY: 'sk_test_local',
    STRIPE_WEBHOOK_SECRET: 'whsec_local',
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

describe('billingEnabled', () => {
  it('is off when no Stripe value is configured', () => {
    expect(billingEnabled({} as Env)).toBe(false)
    expect(billingEnabled({ STRIPE_SECRET_KEY: '  ' } as Env)).toBe(false)
  })

  it('is on only when secret key, webhook secret and meter event name are all configured', () => {
    expect(billingEnabled(env())).toBe(true)
  })

  it.each([
    { STRIPE_SECRET_KEY: undefined },
    { STRIPE_WEBHOOK_SECRET: undefined },
    { STRIPE_METER_EVENT_NAME: undefined },
  ])('fails closed with server_error when partially configured: %o', (missing) => {
    expect(() => billingEnabled(env(missing))).toThrow(
      expect.objectContaining({ code: 'server_error' }),
    )
  })

  it('fails closed when the meter event name is longer than Stripe accepts', () => {
    expect(() => billingEnabled(env({ STRIPE_METER_EVENT_NAME: 'x'.repeat(101) }))).toThrow(
      expect.objectContaining({ code: 'server_error' }),
    )
  })
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
          type: 'customer.subscription.updated',
          created: 1_785_240_000,
          data: { object: { customer: 'cus_1' } },
        }),
      ),
    ).toMatchObject({ id: 'evt_1', type: 'customer.subscription.updated' })
    expect(() => parseStripeEvent('{"type":"missing-id"}')).toThrow(AppError)
    expect(() => parseStripeEvent('{')).toThrow(AppError)
  })

  it('opens a Customer Portal session on a Stripe-hosted URL', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ id: 'bps_1', url: 'https://billing.stripe.com/p/session/bps_1' }),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      createStripePortalSession(env(), {
        customerId: 'cus_1',
        returnUrl: 'https://xid.example/console/platform/usage',
      }),
    ).resolves.toEqual({
      id: 'bps_1',
      url: 'https://billing.stripe.com/p/session/bps_1',
      expiresAt: null,
    })
    const [url, request] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.stripe.com/v1/billing_portal/sessions')
    expect(new URLSearchParams(String(request?.body)).get('customer')).toBe('cus_1')
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

  it('refuses Stripe calls when billing is switched off', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      createStripePortalSession({} as Env, {
        customerId: 'cus_1',
        returnUrl: 'https://xid.example/console/platform/usage',
      }),
    ).rejects.toMatchObject({ code: 'service_unavailable', httpStatus: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails closed when the adapter is only partially configured', async () => {
    await expect(
      createStripeMeterEvent(env({ STRIPE_SECRET_KEY: undefined }), {
        eventName: 'xid_mau',
        identifier: 'xid_mau_org_1',
        customerId: 'cus_1',
        value: 1,
        timestampSeconds: 1_785_240_000,
      }),
    ).rejects.toMatchObject({ code: 'server_error' })
  })
})
