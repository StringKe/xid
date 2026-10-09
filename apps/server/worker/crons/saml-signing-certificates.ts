// 出站 SAML IdP 签名证书的每日维护,对应 OIDC 签名密钥四步轮换中的后台步骤:
// active 临近到期时发布 next(metadata 同时发布两张);retiring 过了重叠期下线;临近到期仍未切换时写审计告警。
// next -> active 只能由管理员显式切换,这里从不改变签名证书。

import { logWorkerError } from '../lib/safe-log'
import { certificateCommonName, insertOutboundSamlCertificate } from '../sso/signing-certificate'

const DAY_MS = 24 * 60 * 60 * 1000
export const NEXT_CERTIFICATE_LEAD_MS = 60 * DAY_MS
export const EXPIRY_ALERT_WINDOW_MS = 30 * DAY_MS
const PAGE_SIZE = 50
const USAGE = 'saml_idp_signing'

type CertificateRow = { id: string; tenant_id: string }
type ActiveRow = CertificateRow & {
  primary_domain: string | null
  not_after: number | null
  next_id: string | null
}

async function eachPage<T extends { id: string }>(
  query: (cursor: string) => Promise<T[]>,
  visit: (row: T) => Promise<void>,
): Promise<void> {
  let cursor = ''
  while (true) {
    const rows = await query(cursor)
    for (const row of rows) await visit(row)
    if (rows.length < PAGE_SIZE) return
    cursor = rows[rows.length - 1]!.id
  }
}

async function retireExpiredRetiringCertificates(env: Env, now: number): Promise<void> {
  await eachPage(
    async (cursor) =>
      (
        await env.DB.prepare(
          `SELECT id, tenant_id FROM cert_store
             WHERE usage = ? AND status = 'retiring' AND id > ?
               AND ((retire_after IS NOT NULL AND retire_after <= ?)
                 OR (not_after IS NOT NULL AND not_after <= ?))
             ORDER BY id LIMIT ?`,
        )
          .bind(USAGE, cursor, now, now, PAGE_SIZE)
          .all<CertificateRow>()
      ).results,
    async (row) => {
      await env.DB.prepare(
        `UPDATE cert_store SET status = 'retired', updated_at = ?
           WHERE tenant_id = ? AND id = ? AND usage = ? AND status = 'retiring'`,
      )
        .bind(now, row.tenant_id, row.id, USAGE)
        .run()
    },
  )
}

function activeCertificatesQuery(env: Env, input: { notAfterBefore: number; cursor: string }) {
  return env.DB.prepare(
    `SELECT active.id AS id, active.tenant_id AS tenant_id, active.not_after AS not_after,
            instances.primary_domain AS primary_domain,
            (SELECT next_cert.id FROM cert_store next_cert
               WHERE next_cert.tenant_id = active.tenant_id AND next_cert.usage = active.usage
                 AND next_cert.status = 'next' LIMIT 1) AS next_id
       FROM cert_store active
       LEFT JOIN organizations ON organizations.id = active.tenant_id
       LEFT JOIN instances ON instances.id = organizations.instance_id
       WHERE active.usage = ? AND active.status = 'active' AND active.id > ?
         AND active.not_after IS NOT NULL AND active.not_after < ?
       ORDER BY active.id LIMIT ?`,
  )
    .bind(USAGE, input.cursor, input.notAfterBefore, PAGE_SIZE)
    .all<ActiveRow>()
}

async function audit(
  env: Env,
  input: { tenantId: string; action: string; now: number; payload: Record<string, unknown> },
): Promise<void> {
  try {
    await env.AUDIT_QUEUE.send({
      tenantId: input.tenantId,
      action: input.action,
      ts: input.now,
      payload: input.payload,
    })
  } catch (error) {
    logWorkerError('cron.daily.saml_certificate_audit_failed', error, {
      component: 'daily-cron',
      operation: 'saml_signing_certificates',
      outcome: 'audit_not_queued',
    })
  }
}

async function publishNextCertificate(
  env: Env,
  row: ActiveRow,
  now: number,
): Promise<string | null> {
  if (row.next_id !== null) return row.next_id
  if (!row.primary_domain) {
    logWorkerError('cron.daily.saml_certificate_instance_missing', undefined, {
      component: 'daily-cron',
      operation: 'saml_signing_certificates',
      outcome: 'skipped_tenant',
    })
    return null
  }
  const inserted = await insertOutboundSamlCertificate(env, {
    tenantId: row.tenant_id,
    commonName: certificateCommonName(`https://${row.primary_domain}`),
    status: 'next',
    now,
  })
  if (!inserted) return null
  await audit(env, {
    tenantId: row.tenant_id,
    action: 'outbound_saml_signing_certificate.next_published',
    now,
    payload: { certificateId: inserted.id, activeCertificateId: row.id },
  })
  return inserted.id
}

async function alertExpiringActiveCertificate(
  env: Env,
  row: ActiveRow & { next_id: string | null },
  now: number,
): Promise<void> {
  if (row.not_after === null || row.not_after >= now + EXPIRY_ALERT_WINDOW_MS) return
  await audit(env, {
    tenantId: row.tenant_id,
    action: 'outbound_saml_signing_certificate.expiring',
    now,
    payload: {
      certificateId: row.id,
      notAfter: new Date(row.not_after).toISOString(),
      expired: row.not_after <= now,
      nextCertificateId: row.next_id,
    },
  })
}

export async function maintainOutboundSamlSigningCertificates(
  env: Env,
  now: number = Date.now(),
): Promise<void> {
  await retireExpiredRetiringCertificates(env, now)
  await eachPage(
    async (cursor) =>
      (
        await activeCertificatesQuery(env, {
          notAfterBefore: now + NEXT_CERTIFICATE_LEAD_MS,
          cursor,
        })
      ).results,
    async (row) => {
      let nextId = row.next_id
      try {
        nextId = await publishNextCertificate(env, row, now)
      } catch (error) {
        logWorkerError('cron.daily.saml_certificate_next_failed', error, {
          component: 'daily-cron',
          operation: 'saml_signing_certificates',
          outcome: 'skipped_tenant',
        })
      }
      await alertExpiringActiveCertificate(env, { ...row, next_id: nextId }, now)
    },
  )
}
