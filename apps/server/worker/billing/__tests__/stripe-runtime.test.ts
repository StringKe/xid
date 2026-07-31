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
import {
  createOrReuseStripeCheckout,
  reserveCheckout,
  stripeConfiguration,
} from '../../platform/stripe-billing'

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
        metadata: {
          xid_tenant_id: 'org_1',
          xid_plan: 'pro',
        },
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
    STRIPE_STARTER_PRICE_ID: 'price_starter',
    STRIPE_PRO_PRICE_ID: 'price_pro',
    STRIPE_ENTERPRISE_PRICE_ID: 'price_enterprise',
    STRIPE_METER_EVENT_NAME: 'xid_mau',
  } as unknown as Env
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Stripe webhook persistence', () => {
  it('applies one event once and keeps the newest authoritative state', async () => {
    const d1 = new SqliteD1()
    applyMigrations(d1.database)
    seedTenant(d1.database)
    const env = makeEnv(d1)
    d1.database
      .prepare(
        `INSERT INTO stripe_checkout_reservations (
           tenant_id, request_id, plan, customer_id, provider_idempotency_key,
           status, created_at, updated_at
         ) VALUES (
           'org_1', 'request_00000001', 'pro', NULL, 'xid_checkout_test',
           'reserved', 1000, 1000
         )`,
      )
      .run()

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
      plan: 'pro',
      status: 'active',
      source: 'stripe',
      external_customer_id: 'cus_1',
    })
    expect(
      d1.database.prepare(`SELECT COUNT(*) AS value FROM platform_audit_outbox`).get(),
    ).toEqual({ value: 1 })
    expect(
      d1.database
        .prepare(
          `SELECT status, customer_id
           FROM stripe_checkout_reservations WHERE tenant_id = 'org_1'`,
        )
        .get(),
    ).toEqual({ status: 'completed', customer_id: 'cus_1' })

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

describe('Stripe Checkout reservation', () => {
  it('reuses one unexpired hosted session across distinct caller retries', async () => {
    const d1 = new SqliteD1()
    applyMigrations(d1.database)
    seedTenant(d1.database)
    const now = new Date('2026-07-28T12:00:00.000Z').getTime()
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'cs_test_1',
          url: 'https://checkout.stripe.com/c/pay/cs_test_1',
          expires_at: Math.floor((now + 60 * 60 * 1000) / 1000),
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const env = makeEnv(d1)
    const base = {
      tenantId: 'org_1',
      plan: 'pro' as const,
      customerId: null,
      currentStatus: null,
      successUrl: 'https://xid.test/console/platform/plans?checkout=success',
      cancelUrl: 'https://xid.test/console/platform/plans?checkout=canceled',
      now,
    }

    const first = await createOrReuseStripeCheckout(env, {
      ...base,
      requestId: 'request_00000001',
    })
    const retried = await createOrReuseStripeCheckout(env, {
      ...base,
      requestId: 'request_00000002',
    })

    expect(retried).toEqual(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(
      d1.database
        .prepare(
          `SELECT request_id, status, session_id
           FROM stripe_checkout_reservations WHERE tenant_id = 'org_1'`,
        )
        .get(),
    ).toEqual({
      request_id: 'request_00000001',
      status: 'ready',
      session_id: 'cs_test_1',
    })
    expect(
      stripeConfiguration(env, { customerId: 'cus_1', status: 'active', source: 'stripe' })
        .checkout,
    ).toEqual({
      starter: false,
      pro: false,
      enterprise: false,
    })
    expect(
      stripeConfiguration(env, { customerId: null, status: 'active', source: 'stripe' }).checkout,
    ).toEqual({
      starter: false,
      pro: false,
      enterprise: false,
    })
    d1.close()
  })

  it('fails closed when an unresolved reservation outlives Stripe idempotency retention', async () => {
    const d1 = new SqliteD1()
    applyMigrations(d1.database)
    seedTenant(d1.database)
    const env = makeEnv(d1)
    const now = new Date('2026-07-28T12:00:00.000Z').getTime()
    const input = {
      tenantId: 'org_1',
      requestId: 'request_00000001',
      plan: 'pro' as const,
      customerId: null,
      currentStatus: null,
      now,
    }
    await reserveCheckout(env, input)

    await expect(
      reserveCheckout(env, {
        ...input,
        requestId: 'request_00000002',
        now: now + 24 * 60 * 60 * 1000,
      }),
    ).rejects.toMatchObject({ code: 'service_unavailable', httpStatus: 503 })
    expect(
      d1.database
        .prepare(`SELECT status FROM stripe_checkout_reservations WHERE tenant_id = 'org_1'`)
        .get(),
    ).toEqual({ status: 'reconciliation_required' })
    d1.close()
  })

  it('does not replace an elapsed hosted session that Stripe reports as complete', async () => {
    const d1 = new SqliteD1()
    applyMigrations(d1.database)
    seedTenant(d1.database)
    const now = new Date('2026-07-28T12:00:00.000Z').getTime()
    const elapsedAt = now + 2 * 60 * 60 * 1000
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'cs_test_complete',
            url: 'https://checkout.stripe.com/c/pay/cs_test_complete',
            expires_at: Math.floor((now + 60 * 60 * 1000) / 1000),
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'cs_test_complete',
            status: 'complete',
            expires_at: Math.floor((now + 60 * 60 * 1000) / 1000),
          }),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    const env = makeEnv(d1)
    const input = {
      tenantId: 'org_1',
      plan: 'pro' as const,
      customerId: null,
      currentStatus: null,
      successUrl: 'https://xid.test/console/platform/plans?checkout=success',
      cancelUrl: 'https://xid.test/console/platform/plans?checkout=canceled',
    }

    await createOrReuseStripeCheckout(env, {
      ...input,
      requestId: 'request_00000001',
      now,
    })
    await expect(
      createOrReuseStripeCheckout(env, {
        ...input,
        requestId: 'request_00000002',
        now: elapsedAt,
      }),
    ).rejects.toMatchObject({ code: 'conflict', httpStatus: 409 })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(
      d1.database
        .prepare(`SELECT status FROM stripe_checkout_reservations WHERE tenant_id = 'org_1'`)
        .get(),
    ).toEqual({ status: 'completed' })
    d1.close()
  })

  it('replaces an elapsed hosted session only after Stripe reports it as expired', async () => {
    const d1 = new SqliteD1()
    applyMigrations(d1.database)
    seedTenant(d1.database)
    const now = new Date('2026-07-28T12:00:00.000Z').getTime()
    const elapsedAt = now + 2 * 60 * 60 * 1000
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'cs_test_expired',
            url: 'https://checkout.stripe.com/c/pay/cs_test_expired',
            expires_at: Math.floor((now + 60 * 60 * 1000) / 1000),
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'cs_test_expired',
            status: 'expired',
            expires_at: Math.floor((now + 60 * 60 * 1000) / 1000),
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'cs_test_replacement',
            url: 'https://checkout.stripe.com/c/pay/cs_test_replacement',
            expires_at: Math.floor((elapsedAt + 60 * 60 * 1000) / 1000),
          }),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    const env = makeEnv(d1)
    const input = {
      tenantId: 'org_1',
      plan: 'pro' as const,
      customerId: null,
      currentStatus: null,
      successUrl: 'https://xid.test/console/platform/plans?checkout=success',
      cancelUrl: 'https://xid.test/console/platform/plans?checkout=canceled',
    }

    await createOrReuseStripeCheckout(env, {
      ...input,
      requestId: 'request_00000001',
      now,
    })
    await expect(
      createOrReuseStripeCheckout(env, {
        ...input,
        requestId: 'request_00000002',
        now: elapsedAt,
      }),
    ).resolves.toMatchObject({ id: 'cs_test_replacement' })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(
      d1.database
        .prepare(
          `SELECT request_id, session_id, status
           FROM stripe_checkout_reservations WHERE tenant_id = 'org_1'`,
        )
        .get(),
    ).toEqual({
      request_id: 'request_00000002',
      session_id: 'cs_test_replacement',
      status: 'ready',
    })
    d1.close()
  })
})

describe('Stripe MAU meter cursor', () => {
  it('stays disabled when subscription billing is configured without a meter', async () => {
    const d1 = new SqliteD1()
    applyMigrations(d1.database)
    seedTenant(d1.database)
    const env = {
      ...makeEnv(d1),
      STRIPE_METER_EVENT_NAME: undefined,
    } as Env
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      reportStripeMauUsage(env, new Date('2026-07-28T12:00:00.000Z')),
    ).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
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
         tenant_id, plan, status, source, external_customer_id,
         effective_at, created_at, updated_at
       ) VALUES (?, 'pro', 'active', 'stripe', ?, 1000, 1000, 1000)`,
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
           tenant_id, plan, status, source, external_customer_id,
           effective_at, created_at, updated_at
         ) VALUES ('org_1', 'pro', 'active', 'stripe', 'cus_1', 1000, 1000, 1000)`,
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

  it('fails closed outside the provider dedup window when acceptance could not be persisted', async () => {
    const d1 = new SqliteD1()
    applyMigrations(d1.database)
    seedTenant(d1.database)
    d1.database
      .prepare(
        `INSERT INTO organization_plans (
           tenant_id, plan, status, source, external_customer_id,
           effective_at, created_at, updated_at
         ) VALUES ('org_1', 'pro', 'active', 'stripe', 'cus_1', 1000, 1000, 1000)`,
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
    ).rejects.toThrow('stripe_meter_reconciliation_required')

    expect(fetchMock).toHaveBeenCalledTimes(1)
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
})
