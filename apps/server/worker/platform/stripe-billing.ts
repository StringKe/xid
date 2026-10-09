// 按用量计费的平台端点:计费配置与 Stripe Customer Portal。XID 没有套餐,也不提供 Checkout;
// 运营方在 Stripe 后台建 customer 与 metered subscription(metadata xid_tenant_id),webhook 完成绑定。
import { schema } from '@xid-kit/db'
import type { BillingConfig } from '@xid-kit/types'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import {
  createStripePortalSession,
  requireUsageBilling,
  StripeApiError,
} from '../billing/stripe-client'
import { AppError } from '../lib/errors'
import { logWorkerError } from '../lib/safe-log'
import type { XidHonoEnv } from '../lib/types'
import { billingEnabled } from '../lib/usage-billing'
import { readJsonBody, validateBody } from '../lib/validate'
import { billingMeterReportRoutes } from './billing-meter-reports'
import { managementDb, requireInstanceManager } from './shared'

const app = new Hono<XidHonoEnv>()

const portalBodySchema = v.object({
  tenantId: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
})

export function billingConfiguration(env: Env, customerId: string | null): BillingConfig {
  const enabled = billingEnabled(env)
  return {
    enabled,
    portal: enabled && customerId !== null,
    metering: enabled,
  }
}

async function loadBillingCustomerId(env: Env, tenantId: string): Promise<string | null> {
  const db = managementDb(env)
  const [organization] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(
      and(
        eq(schema.organizations.id, tenantId),
        eq(schema.organizations.tenantId, tenantId),
        isNull(schema.organizations.parentOrgId),
      ),
    )
    .limit(1)
  if (!organization) throw new AppError('not_found', { httpStatus: 404 })
  const [account] = await db
    .select({ customerId: schema.organizationBillingAccounts.externalCustomerId })
    .from(schema.organizationBillingAccounts)
    .where(eq(schema.organizationBillingAccounts.tenantId, tenantId))
    .limit(1)
  return account?.customerId ?? null
}

function consoleReturnUrl(c: Parameters<typeof requireInstanceManager>[0]): string {
  return new URL('/console/platform/usage', c.get('tenant').issuer).toString()
}

app.get('/config', async (c) => {
  await requireInstanceManager(c)
  const tenantId = c.req.query('tenantId')?.trim()
  const customerId = tenantId ? await loadBillingCustomerId(c.env, tenantId) : null
  return c.json(billingConfiguration(c.env, customerId))
})

app.post('/portal', async (c) => {
  await requireInstanceManager(c)
  requireUsageBilling(c.env)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(portalBodySchema, json.value)
  const customerId = await loadBillingCustomerId(c.env, body.tenantId)
  if (!customerId) throw new AppError('not_found', { httpStatus: 404 })
  try {
    const session = await createStripePortalSession(c.env, {
      customerId,
      returnUrl: consoleReturnUrl(c),
    })
    return c.json(session, 201)
  } catch (cause) {
    if (cause instanceof AppError) throw cause
    logWorkerError('platform.stripe_request_failed', cause, {
      component: 'stripe-billing',
      operation: 'portal.create',
      ...(cause instanceof StripeApiError ? { status: cause.status } : {}),
    })
    throw new AppError('service_unavailable', { httpStatus: 503, cause })
  }
})

app.route('/meter-reports', billingMeterReportRoutes)

export function registerStripeBillingRoutes(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/platform/billing', app)
}
