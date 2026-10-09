// MAU 上报对账:列出结果不明且超出 Stripe 去重窗口的上报,由 Instance Manager 标记为已上报或换新 identifier 重报。
import { Hono } from 'hono'
import * as v from 'valibot'
import {
  listMeterReconciliations,
  METER_RECONCILIATION_ACTIONS,
  resolveMeterReconciliation,
  type MeterReconciliationItem,
} from '../billing/stripe-meter-reconciliation'
import { requireUsageBilling } from '../billing/stripe-client'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import {
  decodeCursor,
  encodeCursor,
  parsePlatformPagination,
  requireInstanceManager,
  type PlatformPage,
} from './shared'

const app = new Hono<XidHonoEnv>()

const resolveBodySchema = v.object({
  tenantId: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  period: v.pipe(v.string(), v.regex(/^\d{4}-(0[1-9]|1[0-2])$/u)),
  identifier: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  action: v.picklist(METER_RECONCILIATION_ACTIONS),
})

function parseCursor(cursor: string | null): { tenantId: string; period: string } | null {
  if (cursor === null) return null
  const [tenantId, period, extra] = decodeCursor(cursor).split('\n')
  if (!tenantId || !period || extra !== undefined) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'cursor' } })
  }
  return { tenantId, period }
}

app.get('/', async (c) => {
  await requireInstanceManager(c)
  const { limit, cursor } = parsePlatformPagination(c, 20)
  const page = await listMeterReconciliations(c.env, { limit, after: parseCursor(cursor) })
  const last = page.items.at(-1)
  const body: PlatformPage<MeterReconciliationItem> = {
    data: page.items,
    nextCursor: page.hasMore && last ? encodeCursor(`${last.tenantId}\n${last.period}`) : null,
    total: page.total,
  }
  return c.json(body)
})

app.post('/resolve', async (c) => {
  const session = await requireInstanceManager(c)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(resolveBodySchema, json.value)
  if (body.action === 'report_again') requireUsageBilling(c.env)
  const result = await resolveMeterReconciliation(c.env, {
    ...body,
    actorId: session.userId,
    now: Date.now(),
  })
  return c.json({ resolved: true, identifier: result.identifier })
})

export const billingMeterReportRoutes = app
