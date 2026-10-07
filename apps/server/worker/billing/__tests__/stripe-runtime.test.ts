import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleStripeMeteringQueueMessage, reportStripeMauUsage } from '../stripe-metering'
import {
  applyStripeEvent,
  readStripeWebhookBody,
  STRIPE_WEBHOOK_MAX_BODY_BYTES,
} from '../stripe-webhook'
import type { StripeEvent } from '../stripe-client'

type SqliteRow = Record<string, unknown>

const migrationDir = fileURLToPath(new URL('../../../../../packages/db/drizzle/', import.meta.url))

class SqliteD1Statement {
  private bindings: unknown[] = []

  constructor(
    private readonly owner: SqliteD1,
    readonly sql: string,
  ) {}

  bind(...bindings: unknown[]): this {
    this.bindings = bindings
    return this
  }

  execute(): D1Result<unknown> {
    this.owner.maybeFail(this.sql)
    const statement = this.owner.database.prepare(this.sql)
    const result = statement.run(...this.bindings)
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as D1Result<unknown>
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return this.execute() as D1Result<T>
  }

  async all<T = SqliteRow>(): Promise<D1Result<T>> {
    this.owner.maybeFail(this.sql)
    const statement = this.owner.database.prepare(this.sql)
    return {
      success: true,
      results: statement.all(...this.bindings) as T[],
      meta: { changes: 0 },
    } as D1Result<T>
  }

  async first<T = SqliteRow>(): Promise<T | null> {
    this.owner.maybeFail(this.sql)
    const statement = this.owner.database.prepare(this.sql)
    return (statement.get(...this.bindings) as T | undefined) ?? null
  }
}

class SqliteD1 {
  readonly database = new DatabaseSync(':memory:')
  private failPattern: RegExp | null = null

  prepare(sql: string): D1PreparedStatement {
    return new SqliteD1Statement(this, sql) as unknown as D1PreparedStatement
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results = statements.map((statement) =>
        (statement as unknown as SqliteD1Statement).execute(),
      )
      this.database.exec('COMMIT')
      return results as D1Result<T>[]
    } catch (cause) {
      this.database.exec('ROLLBACK')
      throw cause
    }
  }

  failNext(pattern: RegExp): void {
    this.failPattern = pattern
  }

  maybeFail(sql: string): void {
    if (!this.failPattern?.test(sql)) return
    this.failPattern = null
    throw new Error('injected_d1_failure')
  }

  close(): void {
    this.database.close()
  }
}

function applyMigrations(db: DatabaseSync): void {
  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(migrationDir, file), 'utf8'))
    if (file === '0005_platform-privacy-operations.sql') return
  }
  throw new Error('migration_0005_missing')
}

function seedTenant(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO instances (
       id, name, primary_domain, mode, default_locale, data_residency, mfa_policy,
       password_policy, session_policy, status, created_at, updated_at
     ) VALUES (
       'inst_1', 'XID', 'xid.test', 'multi_tenant', 'en', 'us', 'optional',
       '{}', '{}', 'active', 1000, 1000
     )`,
  ).run()
  db.prepare(
    `INSERT INTO organizations (
       id, tenant_id, instance_id, parent_org_id, slug, name, public_metadata,
       private_metadata, seat_limit, seat_used, enrollment_mode, allow_org_self_service,
       status, created_at, updated_at
     ) VALUES (
       'org_1', 'org_1', 'inst_1', NULL, 'acme', 'Acme', '{}', '{}',
       NULL, 0, 'invite_required', 1, 'active', 1000, 1000
     )`,
  ).run()
}

function subscriptionEvent(
  id: string,
  type:
    | 'customer.subscription.created'
    | 'customer.subscription.updated'
    | 'customer.subscription.deleted',
  created: number,
  status?: string,
): StripeEvent {
  return {
    id,
    type,
    created,
    data: {
      object: {
        customer: 'cus_1',
        status,
        metadata: { xid_tenant_id: 'org_1' },
        items: { data: [{ price: { id: 'price_metered_mau' } }] },
      },
    },
  }
}

function makeEnv(d1: SqliteD1): Env {
  return {
    DB: d1 as unknown as D1Database,
    AUDIT_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    METERING_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
      sendBatch: vi.fn().mockResolvedValue(undefined),
    },
    STRIPE_SECRET_KEY: 'sk_test_local',
    STRIPE_WEBHOOK_SECRET: 'whsec_local',
    STRIPE_METER_EVENT_NAME: 'xid_mau',
  } as unknown as Env
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Stripe webhook persistence', () => {
  it('applies one event once and keeps the newest authoritative state', async () => {
    const d1 = new SqliteD1()
    applyMigrations(d1.database)
    seedTenant(d1.database)
    const env = makeEnv(d1)

    await applyStripeEvent(
      env,
      subscriptionEvent('evt_created', 'customer.subscription.created', 100, 'active'),
    )
    await applyStripeEvent(
      env,
      subscriptionEvent('evt_created', 'customer.subscription.created', 100, 'active'),
    )
    expect(
      d1.database
        .prepare(
          `SELECT plan, status, source, external_customer_id
           FROM organization_plans WHERE tenant_id = 'org_1'`,
        )
        .get(),
    ).toEqual({
      plan: 'free',
      status: 'active',
      source: 'stripe',
      external_customer_id: 'cus_1',
    })
    expect(
      d1.database.prepare(`SELECT COUNT(*) AS value FROM platform_audit_outbox`).get(),
    ).toEqual({ value: 1 })
    expect(d1.database.prepare(`SELECT COUNT(*) AS value FROM organization_quotas`).get()).toEqual({
      value: 0,
    })
    expect(
      d1.database.prepare(`SELECT seat_limit FROM organizations WHERE id = 'org_1'`).get(),
    ).toEqual({ seat_limit: null })

    await applyStripeEvent(
      env,
      subscriptionEvent('evt_newer', 'customer.subscription.updated', 300, 'active'),
    )
    await applyStripeEvent(
      env,
      subscriptionEvent('evt_older', 'customer.subscription.updated', 200, 'past_due'),
    )
    expect(
      d1.database.prepare(`SELECT status FROM organization_plans WHERE tenant_id = 'org_1'`).get(),
    ).toEqual({ status: 'active' })

    await applyStripeEvent(
      env,
      subscriptionEvent('evt_deleted', 'customer.subscription.deleted', 400),
    )
    await applyStripeEvent(
      env,
      subscriptionEvent('evt_same_second_update', 'customer.subscription.updated', 400, 'active'),
    )
    expect(
      d1.database.prepare(`SELECT status FROM organization_plans WHERE tenant_id = 'org_1'`).get(),
    ).toEqual({ status: 'canceled' })
    expect(
      d1.database
        .prepare(
          `SELECT COUNT(*) AS value
           FROM stripe_webhook_events WHERE status = 'processed'`,
        )
        .get(),
    ).toEqual({ value: 5 })
    d1.close()
  })

  it('bounds the public raw-body buffer before signature verification', async () => {
    await expect(
      readStripeWebhookBody(
        new Request('https://xid.test/v1/billing/stripe/webhook', {
          method: 'POST',
          body: new Uint8Array(STRIPE_WEBHOOK_MAX_BODY_BYTES + 1),
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request', httpStatus: 413 })
  })
})

describe('Stripe MAU meter cursor', () => {
  it('does nothing when billing is switched off', async () => {
    const d1 = new SqliteD1()
    applyMigrations(d1.database)
    seedTenant(d1.database)
    const env = {
      ...makeEnv(d1),
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
      STRIPE_METER_EVENT_NAME: undefined,
    } as Env
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      reportStripeMauUsage(env, new Date('2026-07-28T12:00:00.000Z')),
    ).resolves.toBeUndefined()
    expect(env.METERING_QUEUE.send).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    d1.close()
  })

  it('fails closed without enqueueing when billing is only partially configured', async () => {
    const d1 = new SqliteD1()
    applyMigrations(d1.database)
    seedTenant(d1.database)
    const env = { ...makeEnv(d1), STRIPE_METER_EVENT_NAME: undefined } as Env

    await expect(
      reportStripeMauUsage(env, new Date('2026-07-28T12:00:00.000Z')),
    ).rejects.toMatchObject({ code: 'server_error' })
    expect(env.METERING_QUEUE.send).not.toHaveBeenCalled()
    d1.close()
  })

  it('keeps provider I/O out of Cron and enqueues one bounded dispatch', async () => {
    const d1 = new SqliteD1()
    applyMigrations(d1.database)
    seedTenant(d1.database)
    const env = makeEnv(d1)
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const now = new Date('2026-07-28T12:00:00.000Z')

    await reportStripeMauUsage(env, now)

    expect(env.METERING_QUEUE.send).toHaveBeenCalledWith({
      type: 'stripe_mau_dispatch',
      period: '2026-07',
      requestedAt: now.getTime(),
    })
    expect(fetchMock).not.toHaveBeenCalled()
    d1.close()
  })

  it('dispatches at most one 100-tenant page and continues with a cursor', async () => {
    const d1 = new SqliteD1()
    applyMigrations(d1.database)
    seedTenant(d1.database)
    const insertPlan = d1.database.prepare(
      `INSERT INTO organization_plans (
         tenant_id, status, source, external_customer_id,
         effective_at, created_at, updated_at
       ) VALUES (?, 'active', 'stripe', ?, 1000, 1000, 1000)`,
    )
    const insertUsage = d1.database.prepare(
      `INSERT INTO usage_monthly (tenant_id, year_month, mau, archived_at)
       VALUES (?, '2026-07', 1, '2026-07-28T00:00:00.000Z')`,
    )
    for (let index = 0; index < 101; index += 1) {
      const tenantId = `tenant_${String(index).padStart(3, '0')}`
      insertPlan.run(tenantId, `cus_${String(index).padStart(3, '0')}`)
      insertUsage.run(tenantId)
    }
    const env = makeEnv(d1)
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
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
    expect(fetchMock).not.toHaveBeenCalled()
    d1.close()
  })

  it('finalizes without resending after provider acceptance was persisted', async () => {
    const d1 = new SqliteD1()
    applyMigrations(d1.database)
    seedTenant(d1.database)
    d1.database
      .prepare(
        `INSERT INTO organization_plans (
           tenant_id, status, source, external_customer_id,
           effective_at, created_at, updated_at
         ) VALUES ('org_1', 'active', 'stripe', 'cus_1', 1000, 1000, 1000)`,
      )
      .run()
    d1.database
      .prepare(
        `INSERT INTO usage_monthly (tenant_id, year_month, mau, archived_at)
         VALUES ('org_1', '2026-07', 7, '2026-07-28T00:00:00.000Z')`,
      )
      .run()
    const requests: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        requests.push(String(init?.body))
        return new Response(JSON.stringify({ object: 'billing.meter_event' }))
      }),
    )
    const env = makeEnv(d1)
    const now = new Date('2026-07-28T12:00:00.000Z')
    const message = {
      type: 'stripe_mau_report',
      tenantId: 'org_1',
      period: '2026-07',
      requestedAt: now.getTime(),
    } as const

    d1.failNext(/SET reported_value =/u)
    await expect(handleStripeMeteringQueueMessage(env, message, now)).rejects.toThrow(
      'injected_d1_failure',
    )
    expect(
      d1.database
        .prepare(
          `SELECT reported_value, pending_identifier, pending_value, pending_target,
                  provider_accepted_at
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
    expect(
      d1.database
        .prepare(
          `SELECT reported_value, pending_identifier
           FROM billing_meter_reports WHERE tenant_id = 'org_1'`,
        )
        .get(),
    ).toEqual({ reported_value: 7, pending_identifier: null })
    d1.close()
  })

  it('marks reconciliation outside the provider dedup window without resending or throwing', async () => {
    const d1 = new SqliteD1()
    applyMigrations(d1.database)
    seedTenant(d1.database)
    d1.database
      .prepare(
        `INSERT INTO organization_plans (
           tenant_id, status, source, external_customer_id,
           effective_at, created_at, updated_at
         ) VALUES ('org_1', 'active', 'stripe', 'cus_1', 1000, 1000, 1000)`,
      )
      .run()
    d1.database
      .prepare(
        `INSERT INTO usage_monthly (tenant_id, year_month, mau, archived_at)
         VALUES ('org_1', '2026-07', 7, '2026-07-28T00:00:00.000Z')`,
      )
      .run()
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ object: 'billing.meter_event' })))
    vi.stubGlobal('fetch', fetchMock)
    const env = makeEnv(d1)
    const firstAttempt = new Date('2026-07-28T12:00:00.000Z')
    const message = {
      type: 'stripe_mau_report',
      tenantId: 'org_1',
      period: '2026-07',
      requestedAt: firstAttempt.getTime(),
    } as const

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    d1.failNext(/SET provider_accepted_at/u)
    await expect(handleStripeMeteringQueueMessage(env, message, firstAttempt)).rejects.toThrow(
      'injected_d1_failure',
    )
    await expect(
      handleStripeMeteringQueueMessage(
        env,
        message,
        new Date(firstAttempt.getTime() + 24 * 60 * 60 * 1000),
      ),
    ).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'billing.stripe_meter.reconciliation_required' }),
    )
    expect(
      d1.database
        .prepare(
          `SELECT provider_accepted_at, reconciliation_required_at
           FROM billing_meter_reports WHERE tenant_id = 'org_1'`,
        )
        .get(),
    ).toMatchObject({
      provider_accepted_at: null,
      reconciliation_required_at: firstAttempt.getTime() + 24 * 60 * 60 * 1000,
    })
    d1.close()
  })

  it('skips a cursor awaiting reconciliation on later daily runs without provider I/O', async () => {
    const d1 = new SqliteD1()
    applyMigrations(d1.database)
    seedTenant(d1.database)
    d1.database
      .prepare(
        `INSERT INTO organization_plans (
           tenant_id, status, source, external_customer_id,
           effective_at, created_at, updated_at
         ) VALUES ('org_1', 'active', 'stripe', 'cus_1', 1000, 1000, 1000)`,
      )
      .run()
    d1.database
      .prepare(
        `INSERT INTO usage_monthly (tenant_id, year_month, mau, archived_at)
         VALUES ('org_1', '2026-07', 9, '2026-07-28T00:00:00.000Z')`,
      )
      .run()
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
    const env = makeEnv(d1)
    const now = new Date('2026-07-29T12:00:00.000Z')

    await expect(
      handleStripeMeteringQueueMessage(
        env,
        {
          type: 'stripe_mau_report',
          tenantId: 'org_1',
          period: '2026-07',
          requestedAt: now.getTime(),
        },
        now,
      ),
    ).resolves.toBeUndefined()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'billing.stripe_meter.reconciliation_pending' }),
    )
    expect(
      d1.database
        .prepare(
          `SELECT reported_value, pending_identifier, reconciliation_required_at
           FROM billing_meter_reports WHERE tenant_id = 'org_1'`,
        )
        .get(),
    ).toEqual({
      reported_value: 0,
      pending_identifier: 'xid_mau_pending',
      reconciliation_required_at: reconciliationAt,
    })
    d1.close()
  })
})
