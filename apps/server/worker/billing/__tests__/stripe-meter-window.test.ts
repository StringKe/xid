import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleStripeMeteringQueueMessage } from '../stripe-metering'
import {
  createBillingDatabase,
  makeBillingEnv,
  seedBillingAccount,
  seedMonthlyUsage,
  type SqliteD1,
} from './sqlite-d1'

const DAY_MS = 24 * 60 * 60 * 1000
const firstAttempt = new Date('2026-07-28T02:00:00.000Z')
const message = {
  type: 'stripe_mau_report',
  tenantId: 'org_1',
  period: '2026-07',
  requestedAt: firstAttempt.getTime(),
} as const

function seeded(): SqliteD1 {
  const d1 = createBillingDatabase()
  seedBillingAccount(d1)
  seedMonthlyUsage(d1, { period: '2026-07', mau: 7 })
  return d1
}

function stripeResponses(...responses: Array<Response | Error>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn<typeof fetch>()
  for (const response of responses) {
    if (response instanceof Error) fetchMock.mockRejectedValueOnce(response)
    else fetchMock.mockResolvedValueOnce(response)
  }
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function accepted(): Response {
  return new Response(JSON.stringify({ object: 'billing.meter_event' }))
}

function cursor(d1: SqliteD1): unknown {
  return d1.database
    .prepare(
      `SELECT reported_value, pending_sent_at, provider_accepted_at, reconciliation_required_at
       FROM billing_meter_reports WHERE tenant_id = 'org_1'`,
    )
    .get()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Stripe MAU dedup window', () => {
  it('resends after a definitive Stripe rejection even when the next run is a day later', async () => {
    const d1 = seeded()
    const env = makeBillingEnv(d1)
    const fetchMock = stripeResponses(new Response('{}', { status: 400 }), accepted())
    await expect(handleStripeMeteringQueueMessage(env, message, firstAttempt)).rejects.toThrow(
      'stripe_api_request_failed',
    )
    expect(cursor(d1)).toMatchObject({ pending_sent_at: null })

    await handleStripeMeteringQueueMessage(
      env,
      message,
      new Date(firstAttempt.getTime() + DAY_MS + 60_000),
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(cursor(d1)).toMatchObject({ reported_value: 7, reconciliation_required_at: null })
    d1.close()
  })

  it('retries an ambiguous Stripe failure with the same identifier inside the window', async () => {
    const d1 = seeded()
    const env = makeBillingEnv(d1)
    const fetchMock = stripeResponses(new TypeError('network'), accepted())
    await expect(handleStripeMeteringQueueMessage(env, message, firstAttempt)).rejects.toThrow(
      'network',
    )

    await handleStripeMeteringQueueMessage(
      env,
      message,
      new Date(firstAttempt.getTime() + 15 * 60 * 60 * 1000),
    )

    const identifiers = fetchMock.mock.calls.map(([, init]) =>
      new URLSearchParams(String(init?.body)).get('identifier'),
    )
    expect(identifiers[0]).toBe(identifiers[1])
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      'idempotency-key': identifiers[0],
    })
    expect(cursor(d1)).toMatchObject({ reported_value: 7 })
    d1.close()
  })

  it('requires reconciliation when an ambiguous send is still unconfirmed after the window', async () => {
    const d1 = seeded()
    const env = makeBillingEnv(d1)
    const fetchMock = stripeResponses(new Response('{}', { status: 503 }))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(handleStripeMeteringQueueMessage(env, message, firstAttempt)).rejects.toThrow(
      'stripe_api_request_failed',
    )
    const dayLater = new Date(firstAttempt.getTime() + DAY_MS)

    await expect(handleStripeMeteringQueueMessage(env, message, dayLater)).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'billing.stripe_meter.reconciliation_required' }),
    )
    expect(cursor(d1)).toEqual({
      reported_value: 0,
      pending_sent_at: firstAttempt.getTime(),
      provider_accepted_at: null,
      reconciliation_required_at: dayLater.getTime(),
    })
    d1.close()
  })

  it('requires reconciliation when Stripe accepted but the acceptance was not persisted', async () => {
    const d1 = seeded()
    const env = makeBillingEnv(d1)
    const fetchMock = stripeResponses(accepted())
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    d1.failNext(/SET provider_accepted_at/u)
    await expect(handleStripeMeteringQueueMessage(env, message, firstAttempt)).rejects.toThrow(
      'injected_d1_failure',
    )

    await handleStripeMeteringQueueMessage(env, message, new Date(firstAttempt.getTime() + DAY_MS))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(cursor(d1)).toMatchObject({
      reconciliation_required_at: firstAttempt.getTime() + DAY_MS,
    })
    d1.close()
  })
})
