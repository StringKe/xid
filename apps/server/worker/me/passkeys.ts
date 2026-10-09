// GET /v1/me/passkeys:当前用户 passkey 列表 { data, limit }(account/types.ts PasskeyCredential 契约)。
// 认证:cookie session;租户隔离:createTenantDb。
// 安全:public_key/aaguid/sign_count/cose_alg 绝不外泄(私钥永不入库,公钥也不回前端,见 webauthn rule)。

import { base64UrlEncode } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { PASSKEY_DEVICE_NAME_MAX_LENGTH, PASSKEY_LIMIT } from '../auth/passkey-helpers'
import { isEarlierPasskey } from '../auth/passkey-rp-ids'
import { AppError } from '../lib/errors'
import {
  assertStrongFactorRemovable,
  retireSupplementaryFactorsWithoutStrongFactor,
} from '../lib/mfa-methods'
import { requireStepUp } from '../lib/step-up'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { loadUserCredentialLabel, requireSession, toIso } from './shared'
import { hasOtherSignInMethod } from './sign-in-methods'

// PATCH body:deviceName 可清空(null/空串);长度上限与注册时一致。
const renamePasskeyBodySchema = v.object({
  deviceName: v.optional(
    v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(PASSKEY_DEVICE_NAME_MAX_LENGTH))),
  ),
})

type PasskeyDeviceType = 'singleDevice' | 'multiDevice'

type PasskeyView = {
  id: string
  deviceName: string | null
  createdAt: string
  lastUsedAt: string | null
  transports: readonly string[]
  backedUp: boolean
  deviceType: PasskeyDeviceType
  // 早期在实例主域登记的凭证:仍可在组织地址登录,账户页提示在当前地址重新登记
  earlier: boolean
}

type PasskeyListResponse = { data: PasskeyView[]; limit: number }

// WebAuthn Signal API 的输入:userId 与注册时 user.id 同一编码,credential ID 是公开标识。
type PasskeySignalResponse = {
  rpId: string
  userId: string
  name: string
  displayName: string
  allAcceptedCredentialIds: string[]
}

function toPasskeyView(
  tenant: TenantVar,
  row: typeof schema.passkeyCredentials.$inferSelect,
): PasskeyView {
  return {
    earlier: isEarlierPasskey(tenant, row),
    id: row.id,
    deviceName: row.deviceName ?? null,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: toIso(row.lastUsedAt),
    transports: row.transports,
    backedUp: row.backedUp,
    deviceType: row.credentialDeviceType === 'multiDevice' ? 'multiDevice' : 'singleDevice',
  }
}

function listActivePasskeys(
  db: ReturnType<typeof createTenantDb>,
  userId: string,
): Promise<(typeof schema.passkeyCredentials.$inferSelect)[]> {
  return db.passkeyCredentials.findMany(
    and(eq(schema.passkeyCredentials.userId, userId), isNull(schema.passkeyCredentials.revokedAt)),
    { orderBy: asc(schema.passkeyCredentials.createdAt), limit: PASSKEY_LIMIT },
  )
}

const app = new Hono<XidHonoEnv>()

// GET /v1/me/passkeys:强制绑定(pending_mfa_setup)页面也渲染 passkey 注册区块。
app.get('/', async (c) => {
  const session = await requireSession(c, { pendingStatuses: ['pending_mfa_setup'] })
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const rows = await listActivePasskeys(db, session.userId)
  const tenant = c.get('tenant')
  const body: PasskeyListResponse = {
    data: rows.map((row) => toPasskeyView(tenant, row)),
    limit: PASSKEY_LIMIT,
  }
  return c.json(body)
})

// GET /v1/me/passkeys/signal:删除或重命名后 SPA 用它调用 PublicKeyCredential.signal*,
// 让凭据管理器同步隐藏已移除的 passkey 并更新显示名。
app.get('/signal', async (c) => {
  const session = await requireSession(c)
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const [rows, label] = await Promise.all([
    listActivePasskeys(db, session.userId),
    loadUserCredentialLabel(db, session.userId),
  ])
  const body: PasskeySignalResponse = {
    rpId: tenant.rpId,
    userId: base64UrlEncode(new TextEncoder().encode(session.userId)),
    name: label.name,
    displayName: label.displayName,
    allAcceptedCredentialIds: rows.map((row) => row.credentialId),
  }
  return c.json(body)
})

app.patch('/:id', async (c) => {
  const session = await requireSession(c)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const id = c.req.param('id')
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(renamePasskeyBodySchema, json.value)

  const where = and(
    eq(schema.passkeyCredentials.id, id),
    eq(schema.passkeyCredentials.userId, session.userId),
    isNull(schema.passkeyCredentials.revokedAt),
  )
  const existing = await db.passkeyCredentials.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })

  const deviceName = body.deviceName ?? null
  const [updated] = await db.passkeyCredentials.update({ deviceName: deviceName || null }, where)
  if (!updated) throw new AppError('not_found', { httpStatus: 404 })
  return c.json(toPasskeyView(c.get('tenant'), updated))
})

app.delete('/:id', async (c) => {
  const session = await requireSession(c)
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const id = c.req.param('id')
  const where = and(
    eq(schema.passkeyCredentials.id, id),
    eq(schema.passkeyCredentials.userId, session.userId),
    isNull(schema.passkeyCredentials.revokedAt),
  )
  const existing = await db.passkeyCredentials.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  await requireStepUp(c, tenant, session)
  const removed = { kind: 'passkey', id: existing.id } as const
  if (!(await hasOtherSignInMethod(c, { userId: session.userId, removed }))) {
    throw new AppError('sign_in_method_required')
  }
  await assertStrongFactorRemovable(db, { tenant, userId: session.userId })

  await db.passkeyCredentials.update({ revokedAt: new Date() }, where)
  await db.mfaFactors.update(
    { status: 'revoked' },
    and(
      eq(schema.mfaFactors.userId, session.userId),
      eq(schema.mfaFactors.factorType, 'passkey'),
      eq(schema.mfaFactors.passkeyCredentialId, existing.credentialId),
    ),
  )
  await retireSupplementaryFactorsWithoutStrongFactor(db, session.userId)
  return new Response(null, { status: 204 })
})

export function registerPasskeysRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/me/passkeys', app)
}
