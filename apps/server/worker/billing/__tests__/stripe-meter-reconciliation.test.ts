import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  listMeterReconciliations,
  resolveMeterReconciliation,
  type MeterReconciliationAction,
} from '../stripe-meter-reconciliation'
import {
  createBillingDatabase,
  makeBillingEnv,
  seedBillingAccount,
  type SqliteD1,
} from './sqlite-d1'

const now = Date.parse('2026-07-30T12:00:00.000Z')
const eventSeconds = Date.parse('2026-07-27T02:00:00.000Z') / 1000

function seedReconciliation(d1: SqliteD1, tenantId = 'org_1', eventTimestamp = eventSeconds): void {
  d1.database
    .prepare(
      `INSERT INTO billing_meter_reports (
         tenant_id, meter_key, period, reported_value,
         pending_identifier, pending_value, pending_target, pending_customer_id,
         pending_event_name, pending_timestamp, pending_reserved_at, pending_sent_at,
         provider_accepted_at, reconciliation_required_at, created_at, updated_at
       ) VALUES (?, 'mau', '2026-07', 3, ?, 4, 7, 'cus_1', 'xid_mau', ?, 1000, 1000, NULL, 2000, 1000, 2000)`,
    )
    .run(tenantId, `xid_mau_${tenantId}`, eventTimestamp)
}

function request(action: MeterReconciliationAction, identifier = 'xid_mau_org_1') {
  return { tenantId: 'org_1', period: '2026-07', identifier, action, actorId: 'manager_1', now }
}

function auditActions(d1: SqliteD1): unknown {
  return d1.database.prepare(`SELECT action, actor_id FROM platform_audit_outbox`).all()
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Stripe MAU reconciliation', () => {
  it('lists only reports awaiting reconciliation with the organization name', async () => {
    const d1 = createBillingDatabase(['org_1', 'org_2'])
    seedReconciliation(d1)
    d1.database
      .prepare(
        `INSERT INTO billing_meter_reports (
           tenant_id, meter_key, period, reported_value, created_at, updated_at
         ) VALUES ('org_2', 'mau', '2026-07', 9, 1, 1)`,
      )
      .run()

    const page = await listMeterReconciliations(makeBillingEnv(d1), { limit: 20, after: null })

    expect(page).toMatchObject({ hasMore: false, total: 1 })
    expect(page.items).toEqual([
      {
        tenantId: 'org_1',
        organizationName: 'org_1',
        period: '2026-07',
        identifier: 'xid_mau_org_1',
        value: 4,
        reportedValue: 3,
        targetValue: 7,
        customerId: 'cus_1',
        eventTimestamp: '2026-07-27T02:00:00.000Z',
        sentAt: new Date(1000).toISOString(),
        reconciliationRequiredAt: new Date(2000).toISOString(),
      },
    ])
    d1.close()
  })

  it('pages with a tenant and period cursor', async () => {
    const d1 = createBillingDatabase(['org_1', 'org_2'])
    seedReconciliation(d1, 'org_1')
    seedReconciliation(d1, 'org_2')
    const env = makeBillingEnv(d1)

    const first = await listMeterReconciliations(env, { limit: 1, after: null })
    const second = await listMeterReconciliations(env, {
      limit: 1,
      after: { tenantId: 'org_1', period: '2026-07' },
    })

    expect(first).toMatchObject({ hasMore: true, total: 2, items: [{ tenantId: 'org_1' }] })
    expect(second).toMatchObject({ hasMore: false, items: [{ tenantId: 'org_2' }] })
    d1.close()
  })

  it('marks a report Stripe already received as reported and writes an audit record', async () => {
    const d1 = createBillingDatabase()
    seedReconciliation(d1)
    const env = makeBillingEnv(d1)

    await expect(resolveMeterReconciliation(env, request('mark_reported'))).resolves.toEqual({
      identifier: null,
    })

    expect(
      d1.database
        .prepare(
          `SELECT reported_value, pending_identifier, reconciliation_required_at
           FROM billing_meter_reports WHERE tenant_id = 'org_1'`,
        )
        .get(),
    ).toEqual({ reported_value: 7, pending_identifier: null, reconciliation_required_at: null })
    expect(auditActions(d1)).toEqual([
      { action: 'billing.meter_report.marked_reported', actor_id: 'manager_1' },
    ])
    expect(env.AUDIT_QUEUE.send).toHaveBeenCalledTimes(1)
    expect(env.METERING_QUEUE.send).not.toHaveBeenCalled()
    d1.close()
  })

  it('reports again under a new identifier and enqueues the report', async () => {
    const d1 = createBillingDatabase()
    seedBillingAccount(d1)
    seedReconciliation(d1)
    const env = makeBillingEnv(d1)

    const result = await resolveMeterReconciliation(env, request('report_again'))

    expect(result.identifier).toMatch(/^xid_mau_202607_[0-9a-f]{24}_3_7_r[0-9a-f]{8}$/u)
    expect(
      d1.database
        .prepare(
          `SELECT pending_identifier, pending_value, pending_timestamp, pending_sent_at,
                  pending_reserved_at, reconciliation_required_at
           FROM billing_meter_reports WHERE tenant_id = 'org_1'`,
        )
        .get(),
    ).toEqual({
      pending_identifier: result.identifier,
      pending_value: 4,
      pending_timestamp: eventSeconds,
      pending_sent_at: null,
      pending_reserved_at: now,
      reconciliation_required_at: null,
    })
    expect(env.METERING_QUEUE.send).toHaveBeenCalledWith({
      type: 'stripe_mau_report',
      tenantId: 'org_1',
      period: '2026-07',
      requestedAt: now,
    })
    expect(auditActions(d1)).toEqual([
      { action: 'billing.meter_report.reported_again', actor_id: 'manager_1' },
    ])
    d1.close()
  })

  it('rejects a stale identifier without changing the report or writing an audit', async () => {
    const d1 = createBillingDatabase()
    seedReconciliation(d1)

    await expect(
      resolveMeterReconciliation(makeBillingEnv(d1), request('mark_reported', 'xid_mau_old')),
    ).rejects.toMatchObject({ code: 'conflict', httpStatus: 409 })

    expect(auditActions(d1)).toEqual([])
    d1.close()
  })

  it('returns not found when the report is not awaiting reconciliation', async () => {
    const d1 = createBillingDatabase()

    await expect(
      resolveMeterReconciliation(makeBillingEnv(d1), request('mark_reported')),
    ).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 })
    d1.close()
  })

  it('refuses to report again once the event time is older than Stripe accepts', async () => {
    const d1 = createBillingDatabase()
    seedReconciliation(d1, 'org_1', Date.parse('2026-06-20T00:00:00.000Z') / 1000)

    await expect(
      resolveMeterReconciliation(makeBillingEnv(d1), request('report_again')),
    ).rejects.toMatchObject({ code: 'validation_failed', meta: { paramName: 'action' } })

    expect(auditActions(d1)).toEqual([])
    d1.close()
  })
})
