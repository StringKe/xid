// GET /v1/me/passkeys:当前用户 passkey 列表(account/hooks.ts PasskeyCredential 契约,camelCase)。
// 认证:cookie session;租户隔离:createTenantDb。
// 安全:public_key/aaguid/sign_count/cose_alg 绝不外泄(私钥永不入库,公钥也不回前端,见 webauthn rule)。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { PASSKEY_DEVICE_NAME_MAX_LENGTH, PASSKEY_LIMIT } from '../auth/passkey-helpers'
import { AppError } from '../lib/errors'
import {
  assertStrongFactorRemovable,
  retireSupplementaryFactorsWithoutStrongFactor,
} from '../lib/mfa-methods'
import { requireStepUp } from '../lib/step-up'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { requireSession, toIso } from './shared'

type TenantDb = ReturnType<typeof createTenantDb>

// PATCH body:deviceName 可清空(null/空串);长度上限与注册时一致。
const renamePasskeyBodySchema = v.object({
  deviceName: v.optional(
    v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(PASSKEY_DEVICE_NAME_MAX_LENGTH))),
  ),
})

type PasskeyView = {
  id: string
  deviceName: string | null
  createdAt: string
  lastUsedAt: string | null
  transports: readonly string[]
}

function toPasskeyView(row: typeof schema.passkeyCredentials.$inferSelect): PasskeyView {
  return {
    id: row.id,
    deviceName: row.deviceName ?? null,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: toIso(row.lastUsedAt),
    transports: row.transports,
  }
}

// 删除后必须还剩一种登录方式:其他 passkey、密码、已验证邮箱或手机、已关联的社交/企业身份。
async function hasOtherSignInMethod(
  db: TenantDb,
  input: { userId: string; passkeyRowId: string },
): Promise<boolean> {
  const { userId, passkeyRowId } = input
  const [passkeys, passwords, emails, phones, identities] = await Promise.all([
    db.passkeyCredentials
      .findMany(
        and(
          eq(schema.passkeyCredentials.userId, userId),
          isNull(schema.passkeyCredentials.revokedAt),
        ),
        { limit: PASSKEY_LIMIT },
      )
      .then((rows) => rows.filter((row) => row.id !== passkeyRowId).length),
    db.passwords.count(eq(schema.passwords.userId, userId)),
    db.userEmails.count(
      and(eq(schema.userEmails.userId, userId), eq(schema.userEmails.verified, true)),
    ),
    db.userPhones.count(
      and(eq(schema.userPhones.userId, userId), eq(schema.userPhones.verified, true)),
    ),
    db.userIdentities.count(eq(schema.userIdentities.userId, userId)),
  ])
  return passkeys + passwords + emails + phones + identities > 0
}

const app = new Hono<XidHonoEnv>()

// GET /v1/me/passkeys:强制绑定(pending_mfa_setup)页面也渲染 passkey 注册区块。
app.get('/', async (c) => {
  const session = await requireSession(c, { pendingStatuses: ['pending_mfa_setup'] })
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const rows = await db.passkeyCredentials.findMany(
    and(
      eq(schema.passkeyCredentials.userId, session.userId),
      isNull(schema.passkeyCredentials.revokedAt),
    ),
    { limit: PASSKEY_LIMIT },
  )
  return c.json(rows.map(toPasskeyView))
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
  return c.json(toPasskeyView(updated))
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
  if (!(await hasOtherSignInMethod(db, { userId: session.userId, passkeyRowId: existing.id }))) {
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
