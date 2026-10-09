import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createBillingDatabase,
  makeBillingEnv,
  type SqliteD1,
} from '../../billing/__tests__/sqlite-d1'
import { AppError } from '../../lib/errors'
import type { XidHonoEnv } from '../../lib/types'
import { registerStripeBillingRoutes } from '../stripe-billing'

const mocks = vi.hoisted(() => ({ requireInstanceManager: vi.fn() }))

vi.mock('../shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared')>()),
  requireInstanceManager: mocks.requireInstanceManager,
}))

const base = 'https://xid.test/v1/platform/billing/meter-reports'

function makeApp(): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ code: err.code }, err.httpStatus as 401 | 403 | 404 | 409 | 422 | 503)
    }
    throw err
  })
  registerStripeBillingRoutes(app)
  return app
}

function seedReconciliation(d1: SqliteD1): void {
  d1.database
    .prepare(
      `INSERT INTO billing_meter_reports (
         tenant_id, meter_key, period, reported_value,
         pending_identifier, pending_value, pending_target, pending_customer_id,
         pending_event_name, pending_timestamp, pending_reserved_at, pending_sent_at,
         provider_accepted_at, reconciliation_required_at, created_at, updated_at
       ) VALUES ('org_1', 'mau', '2026-07', 0, 'xid_mau_pending', 7, 7, 'cus_1', 'xid_mau', ?,
         1000, 1000, NULL, 2000, 1000, 2000)`,
    )
    .run(Math.floor(Date.now() / 1000) - 3600)
}

function resolve(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

let d1: SqliteD1

beforeEach(() => {
  d1 = createBillingDatabase()
  seedReconciliation(d1)
  mocks.requireInstanceManager.mockResolvedValue({ userId: 'manager_1' })
})

afterEach(() => {
  d1.close()
  vi.clearAllMocks()
})

describe('platform MAU reconciliation routes', () => {
  it('lists reports awaiting reconciliation for an Instance Manager', async () => {
    const response = await makeApp().request(base, {}, makeBillingEnv(d1))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: [{ tenantId: 'org_1', period: '2026-07', identifier: 'xid_mau_pending', value: 7 }],
      nextCursor: null,
      total: 1,
    })
  })

  it.each([
    ['unauthorized', 401],
    ['forbidden', 403],
  ] as const)(
    'rejects a caller that fails the Instance Manager guard with %s',
    async (code, status) => {
      mocks.requireInstanceManager.mockRejectedValue(new AppError(code, { httpStatus: status }))

      const listed = await makeApp().request(base, {}, makeBillingEnv(d1))
      const resolved = await makeApp().request(
        `${base}/resolve`,
        resolve({
          tenantId: 'org_1',
          period: '2026-07',
          identifier: 'xid_mau_pending',
          action: 'mark_reported',
        }),
        makeBillingEnv(d1),
      )

      expect([listed.status, resolved.status]).toEqual([status, status])
      expect(d1.database.prepare(`SELECT reported_value FROM billing_meter_reports`).get()).toEqual(
        { reported_value: 0 },
      )
    },
  )

  it('marks a report as reported and records the acting manager', async () => {
    const response = await makeApp().request(
      `${base}/resolve`,
      resolve({
        tenantId: 'org_1',
        period: '2026-07',
        identifier: 'xid_mau_pending',
        action: 'mark_reported',
      }),
      makeBillingEnv(d1),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ resolved: true, identifier: null })
    expect(d1.database.prepare(`SELECT actor_id FROM platform_audit_outbox`).get()).toEqual({
      actor_id: 'manager_1',
    })
  })

  it('rejects an unknown action before touching the report', async () => {
    const response = await makeApp().request(
      `${base}/resolve`,
      resolve({
        tenantId: 'org_1',
        period: '2026-07',
        identifier: 'xid_mau_pending',
        action: 'delete',
      }),
      makeBillingEnv(d1),
    )

    expect(response.status).toBe(422)
    expect(
      d1.database.prepare(`SELECT COUNT(*) AS value FROM platform_audit_outbox`).get(),
    ).toEqual({ value: 0 })
  })

  it('refuses to report again when usage billing is switched off', async () => {
    const env = {
      ...makeBillingEnv(d1),
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
      STRIPE_METER_EVENT_NAME: undefined,
    } as Env

    const response = await makeApp().request(
      `${base}/resolve`,
      resolve({
        tenantId: 'org_1',
        period: '2026-07',
        identifier: 'xid_mau_pending',
        action: 'report_again',
      }),
      env,
    )

    expect(response.status).toBe(503)
    expect(env.METERING_QUEUE.send).not.toHaveBeenCalled()
  })
})
