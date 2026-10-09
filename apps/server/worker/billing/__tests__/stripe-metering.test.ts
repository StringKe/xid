import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleStripeMeteringQueueMessage, reportStripeMauUsage } from '../stripe-metering'
import {
  createBillingDatabase,
  makeBillingEnv,
  seedBillingAccount,
  seedMonthlyUsage,
  type SqliteD1,
} from './sqlite-d1'

function stubStripeAccepting(): string[] {
  const requests: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      requests.push(String(init?.body))
      return new Response(JSON.stringify({ object: 'billing.meter_event' }))
    }),
  )
  return requests
}

function reportMessage(period: string, requestedAt: number) {
  return { type: 'stripe_mau_report', tenantId: 'org_1', period, requestedAt } as const
}

function cursorRow(d1: SqliteD1, period: string): unknown {
  return d1.database
    .prepare(
      `SELECT reported_value, pending_identifier
       FROM billing_meter_reports WHERE tenant_id = 'org_1' AND period = ?`,
    )
    .get(period)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Stripe MAU meter dispatch', () => {
  it('does nothing when billing is switched off', async () => {
    const d1 = createBillingDatabase()
    const env = {
      ...makeBillingEnv(d1),
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
      STRIPE_METER_EVENT_NAME: undefined,
    } as Env
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      reportStripeMauUsage(env, new Date('2026-07-28T12:00:00.000Z')),
    ).resolves.toBeUndefined()

    expect(env.METERING_QUEUE.sendBatch).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    d1.close()
  })

  it('fails closed without enqueueing when billing is only partially configured', async () => {
    const d1 = createBillingDatabase()
    const env = { ...makeBillingEnv(d1), STRIPE_METER_EVENT_NAME: undefined } as Env

    await expect(
      reportStripeMauUsage(env, new Date('2026-07-28T12:00:00.000Z')),
    ).rejects.toMatchObject({ code: 'server_error' })

    expect(env.METERING_QUEUE.sendBatch).not.toHaveBeenCalled()
    d1.close()
  })

  it('keeps provider I/O out of Cron and enqueues the previous and current month', async () => {
    const d1 = createBillingDatabase()
    const env = makeBillingEnv(d1)
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const now = new Date('2026-01-01T02:00:00.000Z')

    await reportStripeMauUsage(env, now)

    expect(env.METERING_QUEUE.sendBatch).toHaveBeenCalledWith([
      { body: { type: 'stripe_mau_dispatch', period: '2025-12', requestedAt: now.getTime() } },
      { body: { type: 'stripe_mau_dispatch', period: '2026-01', requestedAt: now.getTime() } },
    ])
    expect(fetchMock).not.toHaveBeenCalled()
    d1.close()
  })

  it('dispatches at most one 100-tenant page and continues with a cursor', async () => {
    const d1 = createBillingDatabase()
    for (let index = 0; index < 101; index += 1) {
      const tenantId = `tenant_${String(index).padStart(3, '0')}`
      seedBillingAccount(d1, { tenantId, customerId: `cus_${String(index).padStart(3, '0')}` })
      seedMonthlyUsage(d1, { tenantId, period: '2026-07', mau: 1 })
    }
    const env = makeBillingEnv(d1)
    const requestedAt = new Date('2026-07-28T12:00:00.000Z').getTime()

    await handleStripeMeteringQueueMessage(env, {
      type: 'stripe_mau_dispatch',
      period: '2026-07',
      requestedAt,
    })

    const [page] = vi.mocked(env.METERING_QUEUE.sendBatch).mock.calls[0]!
    expect(page).toHaveLength(100)
    expect(page[0]?.body).toMatchObject({ tenantId: 'tenant_000' })
    expect(page[99]?.body).toMatchObject({ tenantId: 'tenant_099' })
    expect(env.METERING_QUEUE.send).toHaveBeenCalledWith({
      type: 'stripe_mau_dispatch',
      period: '2026-07',
      cursor: 'tenant_099',
      requestedAt,
    })
    d1.close()
  })

  it('skips tenants whose month is fully reported or awaiting reconciliation', async () => {
    const d1 = createBillingDatabase(['org_1', 'org_2', 'org_3'])
    seedBillingAccount(d1, { tenantId: 'org_1', customerId: 'cus_1' })
    seedBillingAccount(d1, { tenantId: 'org_2', customerId: 'cus_2' })
    seedBillingAccount(d1, { tenantId: 'org_3', customerId: 'cus_3' })
    for (const tenantId of ['org_1', 'org_2', 'org_3']) {
      seedMonthlyUsage(d1, { tenantId, period: '2026-07', mau: 5 })
    }
    d1.database
      .prepare(
        `INSERT INTO billing_meter_reports (
           tenant_id, meter_key, period, reported_value, reconciliation_required_at,
           pending_identifier, pending_value, pending_target, pending_customer_id,
           pending_event_name, pending_timestamp, pending_reserved_at, created_at, updated_at
         ) VALUES
           ('org_1', 'mau', '2026-07', 5, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, 1),
           ('org_2', 'mau', '2026-07', 0, 1, 'xid_mau_r', 5, 5, 'cus_2', 'xid_mau', 1, 1, 1, 1)`,
      )
      .run()
    const env = makeBillingEnv(d1)

    await handleStripeMeteringQueueMessage(env, {
      type: 'stripe_mau_dispatch',
      period: '2026-07',
      requestedAt: 1,
    })

    const [page] = vi.mocked(env.METERING_QUEUE.sendBatch).mock.calls[0]!
    expect(page.map((item) => (item.body as { tenantId: string }).tenantId)).toEqual(['org_3'])
    d1.close()
  })
})

describe('Stripe MAU cross-month report', () => {
  it('reports MAU added after the last daily run of a month into that month', async () => {
    const d1 = createBillingDatabase()
    seedBillingAccount(d1)
    seedMonthlyUsage(d1, { period: '2026-07', mau: 7 })
    const requests = stubStripeAccepting()
    const env = makeBillingEnv(d1)
    const lastDay = new Date('2026-07-31T02:00:00.000Z')
    await handleStripeMeteringQueueMessage(
      env,
      reportMessage('2026-07', lastDay.getTime()),
      lastDay,
    )
    seedMonthlyUsage(d1, { period: '2026-07', mau: 9 })
    const firstOfMonth = new Date('2026-08-01T02:00:00.000Z')

    await handleStripeMeteringQueueMessage(
      env,
      reportMessage('2026-07', firstOfMonth.getTime()),
      firstOfMonth,
    )

    expect(requests).toHaveLength(2)
    const catchUp = new URLSearchParams(requests[1])
    expect(catchUp.get('payload[value]')).toBe('2')
    expect(catchUp.get('timestamp')).toBe(String(Date.parse('2026-07-31T23:59:59.000Z') / 1000))
    expect(catchUp.get('identifier')).toMatch(/^xid_mau_202607_[0-9a-f]{24}_7_9$/u)
    expect(cursorRow(d1, '2026-07')).toEqual({ reported_value: 9, pending_identifier: null })
    d1.close()
  })

  it('keeps the request time for a report inside the current month', async () => {
    const d1 = createBillingDatabase()
    seedBillingAccount(d1)
    seedMonthlyUsage(d1, { period: '2026-08', mau: 3 })
    const requests = stubStripeAccepting()
    const now = new Date('2026-08-01T02:00:00.000Z')

    await handleStripeMeteringQueueMessage(
      makeBillingEnv(d1),
      reportMessage('2026-08', now.getTime()),
      now,
    )

    expect(new URLSearchParams(requests[0]).get('timestamp')).toBe(String(now.getTime() / 1000))
    d1.close()
  })
})

describe('Stripe MAU meter cursor', () => {
  it('finalizes without resending after provider acceptance was persisted', async () => {
    const d1 = createBillingDatabase()
    seedBillingAccount(d1)
    seedMonthlyUsage(d1, { period: '2026-07', mau: 7 })
    const requests = stubStripeAccepting()
    const env = makeBillingEnv(d1)
    const now = new Date('2026-07-28T12:00:00.000Z')
    const message = reportMessage('2026-07', now.getTime())

    d1.failNext(/SET reported_value =/u)
    await expect(handleStripeMeteringQueueMessage(env, message, now)).rejects.toThrow(
      'injected_d1_failure',
    )
    expect(
      d1.database
        .prepare(
          `SELECT reported_value, pending_value, pending_target, provider_accepted_at
           FROM billing_meter_reports WHERE tenant_id = 'org_1'`,
        )
        .get(),
    ).toMatchObject({
      reported_value: 0,
      pending_value: 7,
      pending_target: 7,
      provider_accepted_at: now.getTime(),
    })

    await handleStripeMeteringQueueMessage(env, message, new Date('2026-07-29T12:00:00.000Z'))

    expect(requests).toHaveLength(1)
    expect(cursorRow(d1, '2026-07')).toEqual({ reported_value: 7, pending_identifier: null })
    d1.close()
  })

  it('skips a cursor awaiting reconciliation on later daily runs without provider I/O', async () => {
    const d1 = createBillingDatabase()
    seedBillingAccount(d1)
    seedMonthlyUsage(d1, { period: '2026-07', mau: 9 })
    const reconciliationAt = new Date('2026-07-27T12:00:00.000Z').getTime()
    d1.database
      .prepare(
        `INSERT INTO billing_meter_reports (
           tenant_id, meter_key, period, reported_value,
           pending_identifier, pending_value, pending_target, pending_customer_id,
           pending_event_name, pending_timestamp, pending_reserved_at,
           provider_accepted_at, reconciliation_required_at, created_at, updated_at
         ) VALUES ('org_1', 'mau', '2026-07', 0, 'xid_mau_pending', 7, 7, 'cus_1',
           'xid_mau', 1000, 1000, NULL, ?, 1000, ?)`,
      )
      .run(reconciliationAt, reconciliationAt)
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const now = new Date('2026-07-29T12:00:00.000Z')

    await expect(
      handleStripeMeteringQueueMessage(
        makeBillingEnv(d1),
        reportMessage('2026-07', now.getTime()),
        now,
      ),
    ).resolves.toBeUndefined()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'billing.stripe_meter.reconciliation_pending' }),
    )
    expect(cursorRow(d1, '2026-07')).toEqual({
      reported_value: 0,
      pending_identifier: 'xid_mau_pending',
    })
    d1.close()
  })
})
