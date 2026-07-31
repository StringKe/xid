// GET /v1/me/mfa-factors:当前用户 MFA 因子(account/hooks.ts MfaFactor 判别 union,camelCase)。
// totp -> { type:'totp' };backup_codes 批次 -> { type:'backup_codes', remaining };
// sms -> 当前用户有 verified phone 且 SMS provider 已配置。仅列当前真实可用因子。
// 认证:cookie session;租户隔离:createTenantDb。secretCiphertext 绝不外泄(信封加密只在 isolate 内)。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { countRemainingBackupCodes, generateBackupCodes } from '../auth/backup-codes'
import { listEligiblePasskeyCredentials } from '../auth/passkey-mfa-eligibility'
import { PASSKEY_LIMIT } from '../auth/passkey-helpers'
import { activateTotp, createTotpFactor } from '../auth/mfa'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { otpCodeSchema, readJsonBody, validateBody } from '../lib/validate'
import { smsDeliveryReady } from '../auth/delivery-channels'
import { readAllById, requireSession } from './shared'
import { readSession } from '../lib/session'

// 强制 MFA 绑定流程中 session 处于 pending_mfa_setup,绑定端点必须同时接受 active 与 pending_mfa_setup;
// 用 active-only requireSession 会让强制绑定用户永远 401,无法完成 setup。
async function requireSetupCapableSession(c: Context<XidHonoEnv>): Promise<SessionData> {
  const current = c.get('session')
  if (current?.status === 'active' || current?.status === 'pending_mfa_setup') return current
  const session = await readSession(c, ['active', 'pending_mfa_setup'])
  if (!session) throw new AppError('unauthorized', { httpStatus: 401 })
  return session
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

const app = new Hono<XidHonoEnv>()

function encodeOtpAuthLabel(label: string): string {
  return encodeURIComponent(label).replace(/%20/g, '+')
}

async function currentUserLabel(
  db: ReturnType<typeof createTenantDb>,
  userId: string,
): Promise<string> {
  const user = await db.users.findOne(eq(schema.users.id, userId))
  if (!user?.primaryEmailId) return user?.username ?? userId
  const email = await db.userEmails.findOne(eq(schema.userEmails.id, user.primaryEmailId))
  return email?.email ?? user.username ?? userId
}

function totpUri(issuer: string, label: string, secret: string): string {
  const issuerName = 'XID'
  const accountName = `${issuer}:${label}`
  const params = new URLSearchParams({
    secret,
    issuer: issuerName,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  })
  return `otpauth://totp/${encodeOtpAuthLabel(accountName)}?${params.toString()}`
}

async function hasStrongMfaFactor(
  db: ReturnType<typeof createTenantDb>,
  userId: string,
): Promise<boolean> {
  const activeTotp = await db.mfaFactors.findOne(
    and(
      eq(schema.mfaFactors.userId, userId),
      eq(schema.mfaFactors.factorType, 'totp'),
      eq(schema.mfaFactors.status, 'active'),
    ),
  )
  return activeTotp !== undefined
}

async function requireMfaListSession(c: Context<XidHonoEnv>) {
  const current = c.get('session')
  if (current) return current
  const session = await readSession(c, ['active', 'pending_mfa', 'pending_mfa_setup'])
  if (!session) throw new AppError('unauthorized', { httpStatus: 401 })
  c.set('session', session)
  return session
}

// GET /v1/me/mfa-factors
app.get('/', async (c) => {
  const session = await requireMfaListSession(c)
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)

  // totp 因子:status='active' 的 mfa_factors(factor_type='totp')。
  const totpRows = await readAllById((cursor, limit) => {
    const activeTotp = and(
      eq(schema.mfaFactors.userId, session.userId),
      eq(schema.mfaFactors.status, 'active'),
      eq(schema.mfaFactors.factorType, 'totp'),
    )
    return db.mfaFactors.findMany(
      cursor ? and(activeTotp, gt(schema.mfaFactors.id, cursor)) : activeTotp,
      { orderBy: asc(schema.mfaFactors.id), limit },
    )
  })
  const totp: MfaFactor[] = totpRows.map((row) => ({
    id: row.id,
    type: 'totp',
    createdAt: row.createdAt.toISOString(),
  }))

  // backup_codes:聚合为单条因子;remaining 走 backup-codes.ts countRemainingBackupCodes。
  const remaining = await countRemainingBackupCodes({
    ctx: tenant,
    d1: c.env.DB,
    userId: session.userId,
  })
  const factors: MfaFactor[] = [...totp]
  if (remaining > 0) {
    // 取该用户最早一条 backup code 行作 id/createdAt(展示用,因子本身按批次管理)。
    const [earliest] = await db.backupCodes.findMany(
      eq(schema.backupCodes.userId, session.userId),
      {
        orderBy: [asc(schema.backupCodes.createdAt), asc(schema.backupCodes.id)],
        limit: 1,
      },
    )
    if (earliest) {
      factors.push({
        id: earliest.batchId,
        type: 'backup_codes',
        remaining,
        createdAt: earliest.createdAt.toISOString(),
      })
    }
  }

  const eligiblePasskeys = await listEligiblePasskeyCredentials(db, session)
  if (eligiblePasskeys.length > 0) {
    const passkeyRows = await db.passkeyCredentials.findMany(
      and(
        eq(schema.passkeyCredentials.userId, session.userId),
        isNull(schema.passkeyCredentials.revokedAt),
      ),
      { limit: PASSKEY_LIMIT },
    )
    const eligibleIds = new Set(eligiblePasskeys.map((cred) => cred.credentialId))
    for (const row of passkeyRows) {
      if (!eligibleIds.has(row.credentialId)) continue
      factors.push({
        id: row.id,
        type: 'passkey',
        deviceName: row.deviceName,
        createdAt: row.createdAt.toISOString(),
      })
    }
  }

  if (smsDeliveryReady(tenant, c.env)) {
    const phoneRow = await db.userPhones.findOne(
      and(eq(schema.userPhones.userId, session.userId), eq(schema.userPhones.verified, true)),
    )
    if (phoneRow) {
      factors.push({
        id: phoneRow.id,
        type: 'sms',
        createdAt: phoneRow.createdAt.toISOString(),
      })
    }
  }

  return c.json(factors)
})

app.post('/totp/setup', async (c) => {
  const session = await requireSetupCapableSession(c)
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
  const label = await currentUserLabel(db, session.userId)
  const body: TotpSetupResponse = {
    factorId: result.factorId,
    secret: result.secretB32,
    otpauthUri: totpUri(tenant.issuer, label, result.secretB32),
  }
  return c.json(body)
})

app.post('/totp/verify', async (c) => {
  const session = await requireSetupCapableSession(c)
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

  if (session.status === 'pending_mfa_setup') {
    const db = createTenantDb(c.env.DB, tenant)
    await db.sessions.update({ status: 'active' }, eq(schema.sessions.id, session.sessionId))
  }

  return c.json({ activated: true })
})

app.post('/backup-codes', async (c) => {
  const session = await requireSession(c)
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  if (!(await hasStrongMfaFactor(db, session.userId))) {
    throw new AppError('mfa_required', { httpStatus: 409 })
  }

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
    await db.mfaFactors.update({ status: 'revoked' }, eq(schema.mfaFactors.id, factor.id))
    return new Response(null, { status: 204 })
  }

  const code = await db.backupCodes.findOne(
    and(eq(schema.backupCodes.batchId, id), eq(schema.backupCodes.userId, session.userId)),
  )
  if (!code) throw new AppError('not_found', { httpStatus: 404 })
  await db.backupCodes.update(
    { used: true, usedAt: new Date() },
    and(eq(schema.backupCodes.batchId, id), eq(schema.backupCodes.userId, session.userId)),
  )
  return new Response(null, { status: 204 })
})

export function registerMfaFactorsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/me/mfa-factors', app)
}
