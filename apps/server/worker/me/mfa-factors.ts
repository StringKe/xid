// GET /v1/me/mfa-factors:当前用户 MFA 因子(account/types.ts MfaFactor 判别 union,camelCase)。
// totp -> { type:'totp' };backup_codes 批次 -> { type:'backup_codes', remaining };
// sms -> 显式登记的 SMS 因子;passkey -> 可用于第二因子或 step-up 的凭证。仅列当前真实可用因子。
// 登录挑战(pending_mfa)不列一次认证已用过的方法类别,与门控、挑战端点同一判定。
// 认证:cookie session;租户隔离:createTenantDb。secretCiphertext 绝不外泄(信封加密只在 isolate 内)。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { countRemainingBackupCodes, generateBackupCodes } from '../auth/backup-codes'
import { excludedMfaMethods, listEligiblePasskeyCredentials } from '../auth/passkey-mfa-eligibility'
import { activateTotp, createTotpFactor } from '../auth/mfa'
import { smsDeliveryReady } from '../auth/delivery-channels'
import { AppError } from '../lib/errors'
import {
  assertStrongFactorRemovable,
  findActiveSmsFactor,
  hasStrongMfaFactor,
  retireSupplementaryFactorsWithoutStrongFactor,
} from '../lib/mfa-methods'
import { activateSessionAfterMfaSetup } from '../lib/mfa-session'
import { createPersistedId } from '../lib/persisted-id'
import { requireStepUp } from '../lib/step-up'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { otpCodeSchema, readJsonBody, validateBody } from '../lib/validate'
import { registerSmsFactorRoutes } from './mfa-sms-factor'
import {
  loadUserCredentialLabel,
  readAllById,
  requireSession,
  type SessionRequirement,
} from './shared'

// 强制绑定(pending_mfa_setup)必须能完成 TOTP 绑定;/mfa 挑战页(pending_mfa)需要读取因子列表。
const MFA_ENROLLMENT_SESSION: SessionRequirement = { pendingStatuses: ['pending_mfa_setup'] }
const MFA_FACTOR_LIST_SESSION: SessionRequirement = {
  pendingStatuses: ['pending_mfa', 'pending_mfa_setup'],
}

// totp/verify body:code 是 TOTP 6 位数字,先 trim 再按 otpCodeSchema 校验(沿用原手写守卫语义)。
const totpVerifyBodySchema = v.object({
  factorId: v.pipe(v.string(), v.minLength(1)),
  code: v.pipe(v.string(), v.trim(), otpCodeSchema),
})

type TotpFactor = { id: string; type: 'totp'; createdAt: string }
type BackupCodeFactor = { id: string; type: 'backup_codes'; remaining: number; createdAt: string }
type SmsFactor = { id: string; type: 'sms'; createdAt: string }
type PasskeyFactor = {
  id: string
  type: 'passkey'
  deviceName: string | null
  createdAt: string
}
type MfaFactor = TotpFactor | BackupCodeFactor | SmsFactor | PasskeyFactor
type TotpSetupResponse = { factorId: string; secret: string; otpauthUri: string }
type BackupCodesResponse = { batchId: string; codes: string[] }
type TenantDb = ReturnType<typeof createTenantDb>

const app = new Hono<XidHonoEnv>()

// Key URI 格式:label 的 issuer 前缀必须与 issuer 参数一致,认证器按第一个冒号拆分,所以前缀里不能带端口。
function totpUri(issuer: string, label: string, secret: string): string {
  const issuerName = `XID (${new URL(issuer).hostname})`
  const accountName = `${issuerName}:${label}`
  const params = new URLSearchParams({
    secret,
    issuer: issuerName,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  })
  return `otpauth://totp/${encodeURIComponent(accountName)}?${params.toString()}`
}

async function listTotpFactors(db: TenantDb, userId: string): Promise<MfaFactor[]> {
  const rows = await readAllById((cursor, limit) => {
    const activeTotp = and(
      eq(schema.mfaFactors.userId, userId),
      eq(schema.mfaFactors.status, 'active'),
      eq(schema.mfaFactors.factorType, 'totp'),
    )
    return db.mfaFactors.findMany(
      cursor ? and(activeTotp, gt(schema.mfaFactors.id, cursor)) : activeTotp,
      { orderBy: asc(schema.mfaFactors.id), limit },
    )
  })
  return rows.map((row) => ({ id: row.id, type: 'totp', createdAt: row.createdAt.toISOString() }))
}

// backup_codes:聚合为单条因子;id/createdAt 取最早一条(因子本身按批次管理)。
async function backupCodeFactor(
  db: TenantDb,
  input: { remaining: number; userId: string },
): Promise<MfaFactor[]> {
  if (input.remaining === 0) return []
  const [earliest] = await db.backupCodes.findMany(eq(schema.backupCodes.userId, input.userId), {
    orderBy: [asc(schema.backupCodes.createdAt), asc(schema.backupCodes.id)],
    limit: 1,
  })
  if (!earliest) return []
  return [
    {
      id: earliest.batchId,
      type: 'backup_codes',
      remaining: input.remaining,
      createdAt: earliest.createdAt.toISOString(),
    },
  ]
}

async function smsFactor(
  db: TenantDb,
  input: { session: SessionData; smsReady: boolean },
): Promise<MfaFactor[]> {
  if (!input.smsReady || excludedMfaMethods(input.session).includes('sms')) return []
  const factor = await findActiveSmsFactor(db, input.session.userId)
  if (!factor) return []
  return [{ id: factor.factorId, type: 'sms', createdAt: factor.createdAt.toISOString() }]
}

// GET /v1/me/mfa-factors
app.get('/', async (c) => {
  const session = await requireSession(c, MFA_FACTOR_LIST_SESSION)
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)

  const remaining = await countRemainingBackupCodes({
    ctx: tenant,
    d1: c.env.DB,
    userId: session.userId,
  })
  const [totp, backup, passkeys, sms] = await Promise.all([
    listTotpFactors(db, session.userId),
    backupCodeFactor(db, { remaining, userId: session.userId }),
    listEligiblePasskeyCredentials(db, session),
    smsFactor(db, { session, smsReady: smsDeliveryReady(tenant, c.env) }),
  ])
  const passkeyFactors: MfaFactor[] = passkeys.map((cred) => ({
    id: cred.id,
    type: 'passkey',
    deviceName: cred.deviceName,
    createdAt: cred.createdAt.toISOString(),
  }))
  return c.json([...totp, ...backup, ...passkeyFactors, ...sms])
})

registerSmsFactorRoutes(app)

app.post('/totp/setup', async (c) => {
  const session = await requireSession(c, MFA_ENROLLMENT_SESSION)
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)

  const active = await db.mfaFactors.findOne(
    and(
      eq(schema.mfaFactors.userId, session.userId),
      eq(schema.mfaFactors.factorType, 'totp'),
      eq(schema.mfaFactors.status, 'active'),
    ),
  )
  if (active) throw new AppError('already_exists', { httpStatus: 409 })
  await requireStepUp(c, tenant, session)

  await db.mfaFactors.update(
    { status: 'revoked' },
    and(
      eq(schema.mfaFactors.userId, session.userId),
      eq(schema.mfaFactors.factorType, 'totp'),
      eq(schema.mfaFactors.status, 'pending'),
    ),
  )

  const result = await createTotpFactor({
    ctx: tenant,
    d1: c.env.DB,
    kekRaw: c.env.KEK,
    userId: session.userId,
    factorId: createPersistedId('mfaFactor'),
  })
  const label = await loadUserCredentialLabel(db, session.userId)
  const body: TotpSetupResponse = {
    factorId: result.factorId,
    secret: result.secretB32,
    otpauthUri: totpUri(tenant.issuer, label.name, result.secretB32),
  }
  return c.json(body)
})

app.post('/totp/verify', async (c) => {
  const session = await requireSession(c, MFA_ENROLLMENT_SESSION)
  const tenant = c.get('tenant')
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(totpVerifyBodySchema, json.value)

  const result = await activateTotp({
    ctx: tenant,
    d1: c.env.DB,
    replayStore: c.env.WEBAUTHN_CHALLENGE,
    kekRaw: c.env.KEK,
    userId: session.userId,
    factorId: body.factorId,
    code: body.code,
  })
  if (!result.ok) {
    throw new AppError(result.error.reason === 'already_active' ? 'already_exists' : 'mfa_invalid')
  }

  await activateSessionAfterMfaSetup(c, tenant, { session, method: 'totp' })

  return c.json({ activated: true })
})

app.post('/backup-codes', async (c) => {
  const session = await requireSession(c)
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  if (!(await hasStrongMfaFactor(db, session.userId))) {
    throw new AppError('mfa_required', { httpStatus: 409 })
  }
  await requireStepUp(c, tenant, session)

  const result = await generateBackupCodes({
    ctx: tenant,
    d1: c.env.DB,
    userId: session.userId,
    baseIdPrefix: 'bc_',
    pepper: c.env.PEPPER,
  })
  const body: BackupCodesResponse = { batchId: result.batchId, codes: result.codes }
  return c.json(body)
})

app.delete('/:id', async (c) => {
  const session = await requireSession(c)
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const id = c.req.param('id')

  const factor = await db.mfaFactors.findOne(
    and(
      eq(schema.mfaFactors.id, id),
      eq(schema.mfaFactors.userId, session.userId),
      eq(schema.mfaFactors.status, 'active'),
    ),
  )
  if (factor) {
    await requireStepUp(c, tenant, session)
    if (factor.factorType === 'totp') {
      await assertStrongFactorRemovable(db, { tenant, userId: session.userId })
    }
    await db.mfaFactors.update({ status: 'revoked' }, eq(schema.mfaFactors.id, factor.id))
    await retireSupplementaryFactorsWithoutStrongFactor(db, session.userId)
    return new Response(null, { status: 204 })
  }

  const code = await db.backupCodes.findOne(
    and(eq(schema.backupCodes.batchId, id), eq(schema.backupCodes.userId, session.userId)),
  )
  if (!code) throw new AppError('not_found', { httpStatus: 404 })
  await requireStepUp(c, tenant, session)
  await db.backupCodes.update(
    { used: true, usedAt: new Date() },
    and(eq(schema.backupCodes.batchId, id), eq(schema.backupCodes.userId, session.userId)),
  )
  return new Response(null, { status: 204 })
})

export function registerMfaFactorsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/me/mfa-factors', app)
}
