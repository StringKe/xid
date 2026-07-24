// GET /v1/me/trusted-devices:当前用户信任设备(account/hooks.ts TrustedDevice 契约,camelCase)。
// 映射 trusted_devices:id/deviceName/fingerprint(脱敏)/trustedAt/lastSeenAt。仅列 revoked_at IS NULL 且未过期。
// 认证:cookie session;租户隔离:createTenantDb。device_token_hash / fingerprint 明文绝不外泄(见 anti-abuse rule)。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { maskFingerprint, readAllById, requireSession, toIso } from './shared'

type TrustedDevice = {
  id: string
  deviceName: string | null
  fingerprint: string
  trustedAt: string
  lastSeenAt: string
}

// row -> TrustedDevice;fingerprint 只回脱敏前缀;lastSeenAt 缺失回退 createdAt。
function toTrustedDevice(row: typeof schema.trustedDevices.$inferSelect): TrustedDevice {
  return {
    id: row.id,
    deviceName: row.deviceName ?? null,
    fingerprint: maskFingerprint(row.fingerprintHash) ?? '',
    trustedAt: row.createdAt.toISOString(),
    lastSeenAt: toIso(row.lastSeenAt) ?? row.createdAt.toISOString(),
  }
}

const app = new Hono<XidHonoEnv>()

// GET /v1/me/trusted-devices
app.get('/', async (c) => {
  const session = await requireSession(c)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const rows = await readAllById((cursor, limit) => {
    const active = and(
      eq(schema.trustedDevices.userId, session.userId),
      isNull(schema.trustedDevices.revokedAt),
      gt(schema.trustedDevices.expiresAt, new Date()),
    )
    return db.trustedDevices.findMany(
      cursor ? and(active, gt(schema.trustedDevices.id, cursor)) : active,
      { orderBy: asc(schema.trustedDevices.id), limit },
    )
  })
  return c.json(rows.map(toTrustedDevice))
})

app.delete('/:id', async (c) => {
  const session = await requireSession(c)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const id = c.req.param('id')
  const where = and(
    eq(schema.trustedDevices.id, id),
    eq(schema.trustedDevices.userId, session.userId),
    isNull(schema.trustedDevices.revokedAt),
  )
  const existing = await db.trustedDevices.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  await db.trustedDevices.update({ revokedAt: new Date() }, where)
  return new Response(null, { status: 204 })
})

export function registerTrustedDevicesRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/me/trusted-devices', app)
}
