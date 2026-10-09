// 认证设置页的只读统计:登录方式使用人数、社交登录近 30 天使用、SSO 与出站 SAML 的证书、
// 最近登录和活动、消息渠道近 24 小时失败。人数统计只算该组织的 active 成员。

import { createTenantDb, schema } from '@xid-kit/db'
import { loadIdpVerifyKey, setSamlEngine } from '@xid-kit/saml'
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { drizzle } from 'drizzle-orm/d1'
import type { Context, Hono } from 'hono'
import * as v from 'valibot'
import { auditActorDisplay } from '../lib/audit-actor'
import { AppError } from '../lib/errors'
import { LOGIN_STATS_WINDOW_MS } from '../lib/login-audit'
import type { XidHonoEnv } from '../lib/types'
import { paginationQuerySchema, validateQuery } from '../lib/validate'
import { toIso } from './org-shared'
import { MAX_PAGE_SIZE, decodeCursor, encodeCursor, requireApiKeyOrOrgManager } from './shared'

type TenantDb = ReturnType<typeof createTenantDb>

const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000
const OUTBOUND_IDP_CERT_USAGE = 'saml_idp_signing'
export const DELIVERY_FAILURE_CHANNELS = ['email', 'sms', 'whatsapp'] as const
type DeliveryFailureChannel = (typeof DELIVERY_FAILURE_CHANNELS)[number]

export type RoutedDomain = {
  domain: string
  verified: boolean
  verificationStatus: string
  verifiedAt: string | null
  memberCount: number
}

export type AuthPolicyInsights = {
  passkeySignIns30d: number
  passwordUserCount: number
  usersWithoutSecondFactor: number
  routedDomains: RoutedDomain[]
}

export type CertificateSummary = {
  fingerprintSha256: string
  notBefore: string
  notAfter: string
}

export type SigningCertificateSummary = {
  id: string
  status: 'active' | 'retiring'
  notBefore: string | null
  notAfter: string | null
  fingerprint: string
  algorithm: { key: string; size: number | null; hash: string | null }
}

export type DeliveryFailures24h = Record<
  DeliveryFailureChannel,
  { count: number; topReason: string | null }
>

// memberships 不在被统计表上,用子查询限定成员;tenant_id 显式绑定。
function isActiveMember(column: SQLiteColumn, tenantId: string, orgId: string): SQL {
  return sql`${column} IN (SELECT user_id FROM memberships WHERE tenant_id = ${tenantId} AND org_id = ${orgId} AND status = 'active')`
}

function windowStart(now: number, windowMs: number): Date {
  return new Date(now - windowMs)
}

async function listRoutedDomains(db: TenantDb, orgId: string): Promise<RoutedDomain[]> {
  const orgDb = db.forOrg(orgId)
  const rows = await orgDb.organizationDomains.findMany(
    and(
      eq(schema.organizationDomains.status, 'active'),
      isNull(schema.organizationDomains.deletedAt),
    ),
    { orderBy: schema.organizationDomains.domain, limit: MAX_PAGE_SIZE },
  )
  return Promise.all(
    rows.map(async (row) => {
      const suffix = `@${row.domain.toLowerCase()}`
      const memberCount = await orgDb.memberships.countDistinct(
        schema.memberships.userId,
        and(
          eq(schema.memberships.status, 'active'),
          sql`EXISTS (SELECT 1 FROM user_emails e WHERE e.tenant_id = ${db.tenantId} AND e.user_id = ${schema.memberships.userId} AND substr(lower(e.email), ${-suffix.length}) = ${suffix})`,
        ),
      )
      return {
        domain: row.domain,
        verified: row.verificationStatus === 'verified',
        verificationStatus: row.verificationStatus,
        verifiedAt: toIso(row.verifiedAt),
        memberCount,
      }
    }),
  )
}

export async function buildAuthPolicyInsights(
  c: Context<XidHonoEnv>,
  orgId: string,
  now = Date.now(),
): Promise<AuthPolicyInsights> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const tenantId = db.tenantId
  const since = windowStart(now, LOGIN_STATS_WINDOW_MS)
  const [passkeySignIns30d, passwordUserCount, usersWithoutSecondFactor, routedDomains] =
    await Promise.all([
      db.passkeyCredentials.countDistinct(
        schema.passkeyCredentials.userId,
        and(
          isActiveMember(schema.passkeyCredentials.userId, tenantId, orgId),
          isNull(schema.passkeyCredentials.revokedAt),
          gte(schema.passkeyCredentials.lastUsedAt, since),
        ),
      ),
      db.passwords.countDistinct(
        schema.passwords.userId,
        isActiveMember(schema.passwords.userId, tenantId, orgId),
      ),
      db
        .forOrg(orgId)
        .memberships.countDistinct(
          schema.memberships.userId,
          and(
            eq(schema.memberships.status, 'active'),
            sql`NOT EXISTS (SELECT 1 FROM mfa_factors f WHERE f.tenant_id = ${tenantId} AND f.user_id = ${schema.memberships.userId} AND f.status = 'active')`,
            sql`NOT EXISTS (SELECT 1 FROM passkey_credentials p WHERE p.tenant_id = ${tenantId} AND p.user_id = ${schema.memberships.userId} AND p.revoked_at IS NULL)`,
          ),
        ),
      listRoutedDomains(db, orgId),
    ])
  return { passkeySignIns30d, passwordUserCount, usersWithoutSecondFactor, routedDomains }
}

async function lastDisabledAt(
  db: TenantDb,
  orgId: string,
  provider: string,
): Promise<string | null> {
  const latest = await db.auditEvents.findMany(
    and(
      eq(schema.auditEvents.orgId, orgId),
      eq(schema.auditEvents.eventType, 'organization.social_providers.updated'),
      sql`EXISTS (SELECT 1 FROM json_each(${schema.auditEvents.meta}, '$.disabledProviders') WHERE value = ${provider})`,
    ),
    { orderBy: desc(schema.auditEvents.seq), limit: 1 },
  )
  return latest[0]?.occurredAt ?? null
}

export async function socialProviderActivity(
  c: Context<XidHonoEnv>,
  orgId: string,
  providers: Readonly<Record<string, { enabled: boolean }>>,
  now = Date.now(),
): Promise<Record<string, { signIns30d: number; disabledAt: string | null }>> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const since = windowStart(now, LOGIN_STATS_WINDOW_MS)
  const entries = await Promise.all(
    Object.entries(providers).map(async ([provider, policy]) => {
      const [signIns30d, disabledAt] = await Promise.all([
        db.userIdentities.countDistinct(
          schema.userIdentities.userId,
          and(
            eq(schema.userIdentities.provider, provider),
            isNull(schema.userIdentities.revokedAt),
            gte(schema.userIdentities.lastUsedAt, since),
            isActiveMember(schema.userIdentities.userId, db.tenantId, orgId),
          ),
        ),
        policy.enabled ? Promise.resolve(null) : lastDisabledAt(db, orgId, provider),
      ])
      return [provider, { signIns30d, disabledAt }] as const
    }),
  )
  return Object.fromEntries(entries)
}

export async function parseCertificates(
  certificates: readonly string[],
): Promise<CertificateSummary[]> {
  setSamlEngine(globalThis.crypto)
  const parsed = await Promise.all(certificates.map((cert) => loadIdpVerifyKey(cert)))
  return parsed.flatMap((result) =>
    result.ok
      ? [
          {
            fingerprintSha256: result.value.fingerprint,
            notBefore: new Date(result.value.notBefore).toISOString(),
            notAfter: new Date(result.value.notAfter).toISOString(),
          },
        ]
      : [],
  )
}

export async function ssoConnectionInsights(
  c: Context<XidHonoEnv>,
  orgId: string,
  connectionIds: readonly string[],
): Promise<{ routedDomains: RoutedDomain[]; lastSignInAt: Map<string, string | null> }> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const [routedDomains, lastSignIns] = await Promise.all([
    connectionIds.length === 0 ? Promise.resolve([]) : listRoutedDomains(db, orgId),
    Promise.all(
      connectionIds.map(async (id) => {
        const rows = await db.userIdentities.findMany(
          and(
            eq(schema.userIdentities.provider, id),
            sql`${schema.userIdentities.lastUsedAt} IS NOT NULL`,
          ),
          { orderBy: desc(schema.userIdentities.lastUsedAt), limit: 1 },
        )
        return [id, toIso(rows[0]?.lastUsedAt)] as const
      }),
    ),
  ])
  return { routedDomains, lastSignInAt: new Map(lastSignIns) }
}

function describeKeyAlgorithm(key: CryptoKey): SigningCertificateSummary['algorithm'] {
  const algorithm = key.algorithm as KeyAlgorithm & {
    modulusLength?: number
    namedCurve?: string
    hash?: { name?: string }
  }
  if (algorithm.name.startsWith('RSA')) {
    return { key: 'RSA', size: algorithm.modulusLength ?? null, hash: algorithm.hash?.name ?? null }
  }
  if (algorithm.name === 'ECDSA') {
    return { key: algorithm.namedCurve ?? 'ECDSA', size: null, hash: null }
  }
  return { key: algorithm.name, size: null, hash: null }
}

export async function outboundSigningCertificates(
  c: Context<XidHonoEnv>,
): Promise<SigningCertificateSummary[]> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const rows = await db.certStore.findMany(
    and(
      eq(schema.certStore.usage, OUTBOUND_IDP_CERT_USAGE),
      inArray(schema.certStore.status, ['active', 'retiring']),
    ),
    { orderBy: desc(schema.certStore.createdAt), limit: 10 },
  )
  setSamlEngine(globalThis.crypto)
  return Promise.all(
    rows.map(async (row) => {
      const loaded = await loadIdpVerifyKey(row.certificate)
      return {
        id: row.id,
        status: row.status === 'retiring' ? 'retiring' : 'active',
        notBefore: toIso(row.notBefore),
        notAfter: toIso(row.notAfter),
        fingerprint: row.fingerprint,
        algorithm: loaded.ok
          ? describeKeyAlgorithm(loaded.value.publicKey)
          : { key: 'unknown', size: null, hash: null },
      }
    }),
  )
}

export async function outboundLastSignIns(
  c: Context<XidHonoEnv>,
  appIds: readonly string[],
): Promise<Map<string, string | null>> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const entries = await Promise.all(
    appIds.map(async (appId) => {
      const rows = await db.samlSessionBindings.findMany(
        and(
          eq(schema.samlSessionBindings.direction, 'outbound'),
          eq(schema.samlSessionBindings.scopeId, appId),
        ),
        { orderBy: desc(schema.samlSessionBindings.updatedAt), limit: 1 },
      )
      return [appId, toIso(rows[0]?.updatedAt)] as const
    }),
  )
  return new Map(entries)
}

// notification_failures 的 tenant_id 可空(平台级通知),不在 createTenantDb 表集中;此处显式绑定租户谓词,
// 只读 channel 与 reason,不读 recipient / payload。
export async function deliveryFailures24h(
  c: Context<XidHonoEnv>,
  now = Date.now(),
): Promise<DeliveryFailures24h> {
  const tenantId = c.get('tenant').tenantId
  const table = schema.notificationFailures
  const rows = await drizzle(c.env.DB, { schema })
    .select({ channel: table.channel, reason: table.reason, count: sql<number>`count(*)` })
    .from(table)
    .where(
      and(
        eq(table.tenantId, tenantId),
        gte(table.failedAt, windowStart(now, FAILURE_WINDOW_MS).toISOString()),
      ),
    )
    .groupBy(table.channel, table.reason)
  const result: DeliveryFailures24h = {
    email: { count: 0, topReason: null },
    sms: { count: 0, topReason: null },
    whatsapp: { count: 0, topReason: null },
  }
  const topCount: Record<DeliveryFailureChannel, number> = { email: 0, sms: 0, whatsapp: 0 }
  for (const row of rows) {
    const channel = DELIVERY_FAILURE_CHANNELS.find((name) => name === row.channel)
    if (!channel) continue
    const count = Number(row.count)
    result[channel].count += count
    if (count > topCount[channel]) {
      topCount[channel] = count
      result[channel].topReason = row.reason
    }
  }
  return result
}

const activityQuerySchema = v.object({ ...paginationQuerySchema.entries })

function seqBefore(cursor: string | undefined): SQL | undefined {
  if (cursor === undefined) return undefined
  const raw = decodeCursor(cursor)
  if (!/^\d{1,15}$/.test(raw)) throw new AppError('validation_failed', { httpStatus: 422 })
  return lt(schema.auditEvents.seq, Number(raw))
}

async function readTargetActivity(c: Context<XidHonoEnv>, input: { orgId: string; target: SQL }) {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const query = validateQuery(activityQuerySchema, c.req.query())
  const limit = query.limit ?? MAX_PAGE_SIZE
  const rows = await db.auditEvents.findMany(
    and(eq(schema.auditEvents.orgId, input.orgId), input.target, seqBefore(query.cursor)),
    { orderBy: desc(schema.auditEvents.seq), limit: limit + 1 },
  )
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const actorIds = [
    ...new Set(
      page.flatMap((row) => (row.actorId && row.actorId !== 'system' ? [row.actorId] : [])),
    ),
  ]
  const actors =
    actorIds.length === 0
      ? new Map<string, Date | null>()
      : new Map(
          (
            await db.users.findMany(inArray(schema.users.id, actorIds), { limit: actorIds.length })
          ).map((user) => [user.id, user.erasedAt] as const),
        )
  const last = page[page.length - 1]
  return {
    data: page.map((row) => ({
      id: row.id,
      seq: row.seq,
      eventType: row.eventType,
      actorId: row.actorId ?? null,
      actorDisplay: auditActorDisplay(row.actorId ?? null, {
        found: row.actorId === 'system' || actors.has(row.actorId ?? ''),
        erasedAt: actors.get(row.actorId ?? '') ?? null,
      }),
      occurredAt: row.occurredAt,
    })),
    next_cursor: hasMore && last ? encodeCursor(String(last.seq)) : null,
    has_more: hasMore,
  }
}

export function registerOrgAuthInsightRoutes(app: Hono<XidHonoEnv>): void {
  app.get('/:id/auth-policy/insights', async (c) => {
    const id = c.req.param('id')
    await requireApiKeyOrOrgManager(c, id, 'organizations:read')
    return c.json(await buildAuthPolicyInsights(c, id))
  })

  app.get('/:id/sso-connections/:connectionId/activity', async (c) => {
    const id = c.req.param('id')
    const connectionId = c.req.param('connectionId')
    await requireApiKeyOrOrgManager(c, id, 'connections:read')
    const db = createTenantDb(c.env.DB, c.get('tenant'))
    const connection = await db
      .forOrg(id)
      .ssoConnections.findOne(
        and(eq(schema.ssoConnections.id, connectionId), eq(schema.ssoConnections.status, 'active')),
      )
    if (!connection) throw new AppError('not_found', { httpStatus: 404 })
    const target = or(
      eq(schema.auditEvents.targetId, connectionId),
      sql`json_extract(${schema.auditEvents.meta}, '$.connectionId') = ${connectionId}`,
    ) as SQL
    return c.json(await readTargetActivity(c, { orgId: id, target }))
  })

  app.get('/:id/outbound-saml-apps/:appId/activity', async (c) => {
    const id = c.req.param('id')
    const appId = c.req.param('appId')
    await requireApiKeyOrOrgManager(c, id, 'connections:read')
    const db = createTenantDb(c.env.DB, c.get('tenant'))
    const row = await db.samlServiceProviders.findOne(
      and(eq(schema.samlServiceProviders.id, appId), eq(schema.samlServiceProviders.orgId, id)),
    )
    if (!row) throw new AppError('not_found', { httpStatus: 404 })
    return c.json(
      await readTargetActivity(c, { orgId: id, target: eq(schema.auditEvents.targetId, appId) }),
    )
  })
}
