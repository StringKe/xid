// SAML SLO session bindings:D1 持久化 SessionIndex/NameID -> session 映射(TTL 对齐 session 寿命)。
// 与 ChallengeStore(10min)分离,供入站/出站 SLO 在 session 全寿命内解析映射。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { readAllById } from '../lib/db-pagination'

export type SamlSessionBinding = {
  userId: string
  sessionId: string
}

export type OutboundSamlSessionBinding = SamlSessionBinding & {
  nameId: string
  nameIdFormat: string
}

export type TrackedOutboundSamlSession = OutboundSamlSessionBinding & {
  appId: string
  sessionIndex: string
}

function inboundLookupWhere(connectionId: string, extra?: ReturnType<typeof eq>) {
  const base = and(
    eq(schema.samlSessionBindings.direction, 'inbound'),
    eq(schema.samlSessionBindings.scopeId, connectionId),
    isNull(schema.samlSessionBindings.consumedAt),
    gt(schema.samlSessionBindings.expiresAt, new Date()),
  )
  return extra ? and(base, extra) : base
}

async function consumeBinding(
  c: Context<XidHonoEnv>,
  id: string,
): Promise<SamlSessionBinding | null> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const row = await db.samlSessionBindings.findOne(eq(schema.samlSessionBindings.id, id))
  if (!row || row.consumedAt || row.expiresAt <= new Date()) return null
  const consumed = await db.samlSessionBindings.update(
    { consumedAt: new Date() },
    and(
      eq(schema.samlSessionBindings.id, id),
      isNull(schema.samlSessionBindings.consumedAt),
      gt(schema.samlSessionBindings.expiresAt, new Date()),
    ),
  )
  if (consumed && consumed.length === 0 && row.id) return null
  return { userId: row.userId, sessionId: row.sessionId }
}

async function upsertSessionBinding(input: {
  c: Context<XidHonoEnv>
  direction: 'inbound' | 'outbound'
  scopeId: string
  sessionIndex: string
  binding: SamlSessionBinding
  nameId: string | null
  nameIdFormat: string | null
  expiresAt: Date
}): Promise<void> {
  const tenantId = input.c.get('tenant').tenantId
  if (typeof input.c.env.DB.prepare !== 'function') {
    const db = createTenantDb(input.c.env.DB, input.c.get('tenant'))
    await db.samlSessionBindings.insert({
      id: crypto.randomUUID(),
      tenantId,
      direction: input.direction,
      scopeId: input.scopeId,
      sessionIndex: input.sessionIndex,
      userId: input.binding.userId,
      sessionId: input.binding.sessionId,
      nameId: input.nameId,
      nameIdFormat: input.nameIdFormat,
      expiresAt: input.expiresAt,
    })
    return
  }
  const now = Date.now()
  await input.c.env.DB.prepare(
    `INSERT INTO saml_session_bindings (
       id, tenant_id, direction, scope_id, session_index, user_id, session_id,
       name_id, name_id_format, expires_at, consumed_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(tenant_id, direction, scope_id, session_index) DO UPDATE SET
       user_id = excluded.user_id,
       session_id = excluded.session_id,
       name_id = COALESCE(excluded.name_id, saml_session_bindings.name_id),
       name_id_format = COALESCE(excluded.name_id_format, saml_session_bindings.name_id_format),
       expires_at = excluded.expires_at,
       consumed_at = NULL,
       updated_at = excluded.updated_at`,
  )
    .bind(
      crypto.randomUUID(),
      tenantId,
      input.direction,
      input.scopeId,
      input.sessionIndex,
      input.binding.userId,
      input.binding.sessionId,
      input.nameId,
      input.nameIdFormat,
      input.expiresAt.getTime(),
      now,
      now,
    )
    .run()
}

// 入站 SP:ACS 后写入 SessionIndex(+ NameID) -> session 映射。
export async function storeInboundSamlSessionIndex(input: {
  c: Context<XidHonoEnv>
  connectionId: string
  sessionIndex: string
  nameId?: string
  nameIdFormat?: string
  binding: SamlSessionBinding
  ttlMs: number
}): Promise<void> {
  const expiresAt = new Date(Date.now() + input.ttlMs)
  await upsertSessionBinding({
    c: input.c,
    direction: 'inbound',
    scopeId: input.connectionId,
    sessionIndex: input.sessionIndex,
    binding: input.binding,
    nameId: input.nameId ?? null,
    nameIdFormat: input.nameIdFormat ?? null,
    expiresAt,
  })
}

export async function resolveInboundSamlSessionIndex(
  c: Context<XidHonoEnv>,
  connectionId: string,
  sessionIndex: string,
): Promise<SamlSessionBinding | null> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const row = await db.samlSessionBindings.findOne(
    inboundLookupWhere(connectionId, eq(schema.samlSessionBindings.sessionIndex, sessionIndex)),
  )
  if (!row) return null
  return consumeBinding(c, row.id)
}

export async function resolveInboundSamlSessionByNameId(
  c: Context<XidHonoEnv>,
  connectionId: string,
  nameId: string,
): Promise<SamlSessionBinding | null> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const row = await db.samlSessionBindings.findOne(
    inboundLookupWhere(connectionId, eq(schema.samlSessionBindings.nameId, nameId)),
  )
  if (!row) return null
  return consumeBinding(c, row.id)
}

// 出站 IdP:SessionIndex -> user/session/NameID 映射(供 SLO 发 LogoutRequest)。
export async function storeOutboundSamlSessionIndex(input: {
  c: Context<XidHonoEnv>
  appId: string
  sessionIndex: string
  binding: OutboundSamlSessionBinding
  ttlMs: number
}): Promise<void> {
  const expiresAt = new Date(Date.now() + input.ttlMs)
  await upsertSessionBinding({
    c: input.c,
    direction: 'outbound',
    scopeId: input.appId,
    sessionIndex: input.sessionIndex,
    binding: input.binding,
    nameId: input.binding.nameId,
    nameIdFormat: input.binding.nameIdFormat,
    expiresAt,
  })
}

export async function peekOutboundSamlSessionsForUser(
  c: Context<XidHonoEnv>,
  userId: string,
  sessionId: string,
): Promise<TrackedOutboundSamlSession[]> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const filter = and(
    eq(schema.samlSessionBindings.direction, 'outbound'),
    eq(schema.samlSessionBindings.userId, userId),
    eq(schema.samlSessionBindings.sessionId, sessionId),
    isNull(schema.samlSessionBindings.consumedAt),
    gt(schema.samlSessionBindings.expiresAt, new Date()),
  )
  const rows = await readAllById((cursor, limit) =>
    db.samlSessionBindings.findMany(
      cursor ? and(filter, gt(schema.samlSessionBindings.id, cursor)) : filter,
      { orderBy: asc(schema.samlSessionBindings.id), limit },
    ),
  )
  return rows.map((row) => ({
    appId: row.scopeId,
    sessionIndex: row.sessionIndex,
    userId: row.userId,
    sessionId: row.sessionId,
    nameId: row.nameId ?? '',
    nameIdFormat: row.nameIdFormat ?? '',
  }))
}

export async function trackOutboundSamlSession(
  c: Context<XidHonoEnv>,
  binding: TrackedOutboundSamlSession,
  ttlMs: number,
): Promise<void> {
  const { appId, sessionIndex, userId, sessionId, nameId, nameIdFormat } = binding
  await storeOutboundSamlSessionIndex({
    c,
    appId,
    sessionIndex,
    binding: { userId, sessionId, nameId, nameIdFormat },
    ttlMs,
  })
}

export async function resolveOutboundSamlSessionIndex(
  c: Context<XidHonoEnv>,
  appId: string,
  sessionIndex: string,
): Promise<SamlSessionBinding | null> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const row = await db.samlSessionBindings.findOne(
    and(
      eq(schema.samlSessionBindings.direction, 'outbound'),
      eq(schema.samlSessionBindings.scopeId, appId),
      eq(schema.samlSessionBindings.sessionIndex, sessionIndex),
      isNull(schema.samlSessionBindings.consumedAt),
      gt(schema.samlSessionBindings.expiresAt, new Date()),
    ),
  )
  if (!row) return null
  return consumeBinding(c, row.id)
}
