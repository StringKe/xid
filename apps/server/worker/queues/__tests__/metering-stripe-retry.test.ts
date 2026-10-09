import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MeteringQueueEnvelope } from '@xid-kit/types'
import { handleMeteringBatch, stripeRetryDelaySeconds } from '../metering'

function stripeReportMessage(attempts: number) {
  return {
    id: 'msg_1',
    timestamp: new Date(0),
    attempts,
    body: {
      type: 'stripe_mau_report',
      tenantId: 'org_1',
      period: '2026-07',
      requestedAt: Date.parse('2026-07-28T02:00:00.000Z'),
    } as MeteringQueueEnvelope,
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Stripe metering queue retry', () => {
  it('backs off from 30 minutes so five retries stay inside the Stripe dedup window', () => {
    const delays = [1, 2, 3, 4, 5].map(stripeRetryDelaySeconds)

    expect(delays).toEqual([1800, 3600, 7200, 14_400, 28_800])
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBeLessThan(24 * 60 * 60)
  })

  it('caps the delay at the 12-hour Queue limit and treats a missing count as the first attempt', () => {
    expect(stripeRetryDelaySeconds(20)).toBe(12 * 60 * 60)
    expect(stripeRetryDelaySeconds(Number.NaN)).toBe(1800)
  })

  it('retries a failed Stripe report with the backoff for its attempt number', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const message = stripeReportMessage(3)
    const env = {
      STRIPE_SECRET_KEY: 'sk_test_local',
      STRIPE_WEBHOOK_SECRET: undefined,
      STRIPE_METER_EVENT_NAME: 'xid_mau',
    } as unknown as Env

    await handleMeteringBatch(
      {
        queue: 'xid-metering',
        messages: [message],
      } as unknown as MessageBatch<MeteringQueueEnvelope>,
      env,
    )

    expect(message.ack).not.toHaveBeenCalled()
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 7200 })
  })
})
