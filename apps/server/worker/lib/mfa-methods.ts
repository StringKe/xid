// 用户当前可完成的 MFA 方法:登录门控、/mfa 因子列表、step-up 守卫与账户页共用同一判定。
// SMS 只认用户显式登记的 sms 因子(mfa_factors.target = user_phones.id),已验证手机号本身不是因子。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import { smsDeliveryReady } from '../auth/delivery-channels'
import {
  excludedMfaMethods,
  listEligiblePasskeyCredentials,
  type MfaChallengeContext,
} from '../auth/passkey-mfa-eligibility'
import type { MfaMethod } from './auth-context'
import { AppError } from './errors'
import type { TenantVar, XidHonoEnv } from './types'

type TenantDb = ReturnType<typeof createTenantDb>

export const SMS_FACTOR_TYPE = 'sms'

export type ActiveSmsFactor = {
  factorId: string
  createdAt: Date
  phone: string
}

export async function findActiveSmsFactor(
  db: TenantDb,
  userId: string,
): Promise<ActiveSmsFactor | null> {
  const factor = await db.mfaFactors.findOne(
    and(
      eq(schema.mfaFactors.userId, userId),
      eq(schema.mfaFactors.factorType, SMS_FACTOR_TYPE),
      eq(schema.mfaFactors.status, 'active'),
    ),
  )
  if (!factor?.target) return null
  const phone = await db.userPhones.findOne(
    and(
      eq(schema.userPhones.id, factor.target),
      eq(schema.userPhones.userId, userId),
      eq(schema.userPhones.verified, true),
    ),
  )
  if (!phone) return null
  return { factorId: factor.id, createdAt: factor.createdAt, phone: phone.phone }
}

async function hasActiveTotp(db: TenantDb, userId: string): Promise<boolean> {
  const factor = await db.mfaFactors.findOne(
    and(
      eq(schema.mfaFactors.userId, userId),
      eq(schema.mfaFactors.factorType, 'totp'),
      eq(schema.mfaFactors.status, 'active'),
    ),
  )
  return factor !== undefined
}

async function hasUnusedBackupCode(db: TenantDb, userId: string): Promise<boolean> {
  const code = await db.backupCodes.findOne(
    and(eq(schema.backupCodes.userId, userId), eq(schema.backupCodes.used, false)),
  )
  return code !== undefined
}

// 强因子:TOTP 或未吊销 passkey。备份码与 SMS 只能作为强因子的补充。
export async function countStrongMfaFactors(db: TenantDb, userId: string): Promise<number> {
  const [totp, passkeys] = await Promise.all([
    db.mfaFactors.count(
      and(
        eq(schema.mfaFactors.userId, userId),
        eq(schema.mfaFactors.factorType, 'totp'),
        eq(schema.mfaFactors.status, 'active'),
      ),
    ),
    db.passkeyCredentials.count(
      and(
        eq(schema.passkeyCredentials.userId, userId),
        isNull(schema.passkeyCredentials.revokedAt),
      ),
    ),
  ])
  return totp + passkeys
}

export async function hasStrongMfaFactor(db: TenantDb, userId: string): Promise<boolean> {
  return (await countStrongMfaFactors(db, userId)) > 0
}

// 移除强因子前调用:强制 MFA 的租户里不能删掉最后一个强因子。
export async function assertStrongFactorRemovable(
  db: TenantDb,
  input: { tenant: TenantVar; userId: string },
): Promise<void> {
  if (input.tenant.policy.mfaEnforcement !== 'required') return
  if ((await countStrongMfaFactors(db, input.userId)) > 1) return
  throw new AppError('mfa_required', { httpStatus: 409 })
}

// 移除强因子后调用:没有强因子时停用 SMS 因子与剩余备份码,SMS 不能成为唯一因子。
export async function retireSupplementaryFactorsWithoutStrongFactor(
  db: TenantDb,
  userId: string,
): Promise<void> {
  if (await hasStrongMfaFactor(db, userId)) return
  await db.mfaFactors.update(
    { status: 'revoked' },
    and(
      eq(schema.mfaFactors.userId, userId),
      eq(schema.mfaFactors.factorType, SMS_FACTOR_TYPE),
      eq(schema.mfaFactors.status, 'active'),
    ),
  )
  await db.backupCodes.update(
    { used: true, usedAt: new Date() },
    and(eq(schema.backupCodes.userId, userId), eq(schema.backupCodes.used, false)),
  )
}

export async function listMfaMethods(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  context: MfaChallengeContext,
): Promise<MfaMethod[]> {
  const db = createTenantDb(c.env.DB, tenant)
  const [totp, backup, passkeys, sms] = await Promise.all([
    hasActiveTotp(db, context.userId),
    hasUnusedBackupCode(db, context.userId),
    listEligiblePasskeyCredentials(db, context),
    smsDeliveryReady(tenant, c.env) ? findActiveSmsFactor(db, context.userId) : null,
  ])
  const excluded = excludedMfaMethods(context)
  const methods: MfaMethod[] = []
  if (totp) methods.push('totp')
  if (backup) methods.push('backup')
  if (passkeys.length > 0) methods.push('passkey')
  if (sms && !excluded.includes('sms')) methods.push('sms')
  return methods
}
