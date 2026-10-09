// 出站 SAML IdP 签名证书的显式切换:next -> active,旧 active -> retiring 并保留一段重叠期,
// 租户内所有出站 SAML 应用改用新证书。三步在一个 D1 batch 里完成;后台任务从不调用这里。

import { createTenantDb, schema } from '@xid-kit/db'
import type { Result } from '@xid-kit/types'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import {
  OUTBOUND_IDP_CERT_USAGE,
  PUBLISHED_CERTIFICATE_STATUSES,
  isCertificateTimeValid,
} from './signing-certificate'
import type { CertRow } from './signing-certificate'

// 切换后旧证书继续出现在 metadata 的时长,覆盖按天刷新 metadata 的 SP。
export const RETIRING_CERTIFICATE_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000
const LIST_LIMIT = 10

export type ActivationError = 'certificate_not_found' | 'certificate_expired' | 'conflict'
export type ActivationOutcome = { activatedId: string; retiringId: string | null }

async function findTenantCertificate(
  c: Context<XidHonoEnv>,
  input: { id?: string; status: string },
): Promise<CertRow | null> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const row = await db.certStore.findOne(
    and(
      ...(input.id ? [eq(schema.certStore.id, input.id)] : []),
      eq(schema.certStore.usage, OUTBOUND_IDP_CERT_USAGE),
      eq(schema.certStore.status, input.status),
    ),
  )
  return row ?? null
}

export async function listOutboundSamlSigningCertificates(
  c: Context<XidHonoEnv>,
): Promise<CertRow[]> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  return db.certStore.findMany(
    and(
      eq(schema.certStore.usage, OUTBOUND_IDP_CERT_USAGE),
      inArray(schema.certStore.status, [...PUBLISHED_CERTIFICATE_STATUSES]),
    ),
    { orderBy: desc(schema.certStore.createdAt), limit: LIST_LIMIT },
  )
}

function retireAfterFor(active: CertRow, now: number): number {
  const overlapEnd = now + RETIRING_CERTIFICATE_OVERLAP_MS
  const notAfter = active.notAfter?.getTime()
  return notAfter === undefined ? overlapEnd : Math.min(overlapEnd, notAfter)
}

function activationStatements(
  db: D1Database,
  input: { tenantId: string; next: CertRow; active: CertRow | null; now: number },
): D1PreparedStatement[] {
  const { tenantId, next, active, now } = input
  const nextStillPending = `EXISTS (SELECT 1 FROM cert_store WHERE tenant_id = ? AND id = ? AND usage = ? AND status = 'next')`
  const statements: D1PreparedStatement[] = []
  if (active) {
    statements.push(
      db
        .prepare(
          `UPDATE cert_store SET status = 'retiring', retire_after = ?, updated_at = ?
             WHERE tenant_id = ? AND id = ? AND usage = ? AND status = 'active' AND ${nextStillPending}`,
        )
        .bind(
          retireAfterFor(active, now),
          now,
          tenantId,
          active.id,
          OUTBOUND_IDP_CERT_USAGE,
          tenantId,
          next.id,
          OUTBOUND_IDP_CERT_USAGE,
        ),
    )
  }
  statements.push(
    db
      .prepare(
        `UPDATE cert_store SET status = 'active', updated_at = ?
           WHERE tenant_id = ? AND id = ? AND usage = ? AND status = 'next'`,
      )
      .bind(now, tenantId, next.id, OUTBOUND_IDP_CERT_USAGE),
    db
      .prepare(
        `UPDATE saml_service_providers SET idp_signing_cert_id = ?, updated_at = ?
           WHERE tenant_id = ?
             AND EXISTS (SELECT 1 FROM cert_store WHERE tenant_id = ? AND id = ? AND usage = ? AND status = 'active')`,
      )
      .bind(next.id, now, tenantId, tenantId, next.id, OUTBOUND_IDP_CERT_USAGE),
  )
  return statements
}

export async function activateNextOutboundSamlSigningCertificate(
  c: Context<XidHonoEnv>,
  certificateId: string,
  now: number = Date.now(),
): Promise<Result<ActivationOutcome, ActivationError>> {
  const next = await findTenantCertificate(c, { id: certificateId, status: 'next' })
  if (!next) return { ok: false, error: 'certificate_not_found' }
  if (!(await isCertificateTimeValid(next, now))) return { ok: false, error: 'certificate_expired' }
  const active = await findTenantCertificate(c, { status: 'active' })
  const statements = activationStatements(c.env.DB, {
    tenantId: c.get('tenant').tenantId,
    next,
    active,
    now,
  })
  let results: D1Result[]
  try {
    results = await c.env.DB.batch(statements)
  } catch (cause) {
    // 部分唯一索引拒绝第二张 active:另一个切换已先完成,整个 batch 回滚。
    if (cause instanceof Error && cause.message.includes('UNIQUE constraint failed')) {
      return { ok: false, error: 'conflict' }
    }
    throw new AppError('server_error', { cause })
  }
  const activated = results[active ? 1 : 0]?.meta?.changes ?? 0
  if (activated !== 1) return { ok: false, error: 'conflict' }
  return { ok: true, value: { activatedId: next.id, retiringId: active?.id ?? null } }
}
