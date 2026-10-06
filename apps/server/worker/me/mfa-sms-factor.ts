// SMS 第二因子的显式登记:已验证手机号本身不是 MFA 因子,用户在已有强因子(TOTP / passkey)后主动开启。
// NIST SP 800-63B:SMS 不能是唯一因子,所以登记要求强因子,移除最后一个强因子时同步停用。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, desc, eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { smsDeliveryReady } from '../auth/delivery-channels'
import { AppError } from '../lib/errors'
import { findActiveSmsFactor, hasStrongMfaFactor, SMS_FACTOR_TYPE } from '../lib/mfa-methods'
import { createPersistedId } from '../lib/persisted-id'
import { requireStepUp } from '../lib/step-up'
import type { XidHonoEnv } from '../lib/types'
import { requireSession } from './shared'

type TenantDb = ReturnType<typeof createTenantDb>

type SmsFactorOption = {
  enrollable: boolean
  phoneLast4: string | null
}

async function findVerifiedPhone(
  db: TenantDb,
  userId: string,
): Promise<typeof schema.userPhones.$inferSelect | undefined> {
  const [phone] = await db.userPhones.findMany(
    and(eq(schema.userPhones.userId, userId), eq(schema.userPhones.verified, true)),
    {
      orderBy: [desc(schema.userPhones.isPrimary), asc(schema.userPhones.createdAt)],
      limit: 1,
    },
  )
  return phone
}

export function registerSmsFactorRoutes(app: Hono<XidHonoEnv>): void {
  // GET /v1/me/mfa-factors/sms:账户页据此决定是否显示「用短信接收验证码」入口。
  app.get('/sms', async (c) => {
    const session = await requireSession(c)
    const tenant = c.get('tenant')
    const db = createTenantDb(c.env.DB, tenant)
    const phone = smsDeliveryReady(tenant, c.env)
      ? await findVerifiedPhone(db, session.userId)
      : undefined
    const enrollable =
      phone !== undefined &&
      (await hasStrongMfaFactor(db, session.userId)) &&
      (await findActiveSmsFactor(db, session.userId)) === null
    const body: SmsFactorOption = {
      enrollable,
      phoneLast4: phone ? phone.phone.slice(-4) : null,
    }
    return c.json(body)
  })

  // POST /v1/me/mfa-factors/sms:把已验证手机号登记为 SMS 第二因子。
  app.post('/sms', async (c) => {
    const session = await requireSession(c)
    const tenant = c.get('tenant')
    const db = createTenantDb(c.env.DB, tenant)
    await requireStepUp(c, tenant, session)
    if (!smsDeliveryReady(tenant, c.env)) throw new AppError('invalid_request')
    if (!(await hasStrongMfaFactor(db, session.userId))) {
      throw new AppError('mfa_required', { httpStatus: 409 })
    }
    if (await findActiveSmsFactor(db, session.userId)) {
      throw new AppError('already_exists', { httpStatus: 409 })
    }
    const phone = await findVerifiedPhone(db, session.userId)
    if (!phone) throw new AppError('invalid_request')

    const factorId = createPersistedId('mfaFactor')
    const now = new Date()
    await db.mfaFactors.insert({
      id: factorId,
      tenantId: tenant.tenantId,
      userId: session.userId,
      factorType: SMS_FACTOR_TYPE,
      status: 'active',
      target: phone.id,
      activatedAt: now,
    })
    return c.json({ id: factorId, type: 'sms', createdAt: now.toISOString() }, 201)
  })
}
