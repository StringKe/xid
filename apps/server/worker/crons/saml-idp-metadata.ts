// IdP metadata URL 每日刷新:拉取 active SAML connection 的 metadata,内容变化时更新 entityID/SSO URL/证书。
// 每次结果都落到连接的刷新状态列,失败写日志并保留上次成功的配置,管理员在连接详情里能看到失败原因。

import { parseIdpMetadataXml } from '@xid-kit/saml'
import { logWorkerError, logWorkerWarning } from '../lib/safe-log'
import { isPublicHttpsUrl } from '../lib/validate'

type IdpMetadataConnectionRow = {
  id: string
  tenant_id: string
  org_id: string
  idp_metadata_url: string
  idp_entity_id: string | null
  idp_sso_url: string | null
  idp_slo_url: string | null
  idp_certificates: string | string[] | null
}

export const IDP_METADATA_REFRESH_ERRORS = [
  'metadata_url_not_allowed',
  'metadata_http_status',
  'metadata_too_large',
  'metadata_invalid',
  'metadata_endpoint_not_allowed',
  'metadata_fetch_failed',
] as const
export type IdpMetadataRefreshError = (typeof IDP_METADATA_REFRESH_ERRORS)[number]

type RefreshOutcome =
  | { ok: true; changed: boolean }
  | { ok: false; error: IdpMetadataRefreshError; status?: number }

const SAML_METADATA_PAGE_SIZE = 50
const SAML_METADATA_MAX_BYTES = 1024 * 1024
const SAML_METADATA_FETCH_TIMEOUT_MS = 10_000

class MetadataTooLargeError extends Error {
  override readonly name = 'MetadataTooLargeError'
}

function parseStoredCertificates(value: string | string[] | null): string[] {
  if (Array.isArray(value)) return value.filter((cert) => cert.length > 0)
  if (typeof value !== 'string' || value.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((cert): cert is string => typeof cert === 'string')
      : []
  } catch {
    return []
  }
}

function certificateSetChanged(oldCerts: string[], newCerts: string[]): boolean {
  if (oldCerts.length !== newCerts.length) return true
  const oldSet = new Set(oldCerts)
  return newCerts.some((cert) => !oldSet.has(cert))
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    if (!chunk.value) continue
    total += chunk.value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new MetadataTooLargeError()
    }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function recordRefreshFailure(
  env: Env,
  row: IdpMetadataConnectionRow,
  error: IdpMetadataRefreshError,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE sso_connections
       SET idp_metadata_last_error = ?, idp_metadata_last_error_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'active' AND protocol = 'saml'`,
  )
    .bind(error, now, row.tenant_id, row.id)
    .run()
}

async function recordRefreshSuccess(
  env: Env,
  row: IdpMetadataConnectionRow,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE sso_connections
       SET idp_metadata_refreshed_at = ?, idp_metadata_last_error = NULL,
           idp_metadata_last_error_at = NULL
       WHERE tenant_id = ? AND id = ? AND status = 'active' AND protocol = 'saml'`,
  )
    .bind(now, row.tenant_id, row.id)
    .run()
}

async function fetchMetadata(
  row: IdpMetadataConnectionRow,
): Promise<{ ok: true; xml: string } | Extract<RefreshOutcome, { ok: false }>> {
  if (!isPublicHttpsUrl(row.idp_metadata_url))
    return { ok: false, error: 'metadata_url_not_allowed' }
  let response: Response
  try {
    response = await fetch(row.idp_metadata_url, {
      headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' },
      redirect: 'manual',
      signal: AbortSignal.timeout(SAML_METADATA_FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    logWorkerError('cron.daily.saml_metadata_fetch_failed', error, {
      component: 'daily-cron',
      operation: 'saml_metadata',
      outcome: 'kept_previous_configuration',
    })
    return { ok: false, error: 'metadata_fetch_failed' }
  }
  if (!response.ok) {
    await response.body?.cancel()
    return { ok: false, error: 'metadata_http_status', status: response.status }
  }
  try {
    return { ok: true, xml: await readBoundedText(response, SAML_METADATA_MAX_BYTES) }
  } catch (error) {
    if (error instanceof MetadataTooLargeError) return { ok: false, error: 'metadata_too_large' }
    logWorkerError('cron.daily.saml_metadata_read_failed', error, {
      component: 'daily-cron',
      operation: 'saml_metadata',
      outcome: 'kept_previous_configuration',
    })
    return { ok: false, error: 'metadata_fetch_failed' }
  }
}

async function refreshIdpMetadata(
  env: Env,
  row: IdpMetadataConnectionRow,
): Promise<RefreshOutcome> {
  const fetched = await fetchMetadata(row)
  if (!fetched.ok) return fetched
  const parsed = parseIdpMetadataXml(fetched.xml)
  if (!parsed.ok) return { ok: false, error: 'metadata_invalid' }
  const metadata = parsed.value
  if (
    !isPublicHttpsUrl(metadata.ssoUrl) ||
    (metadata.sloUrl !== null && !isPublicHttpsUrl(metadata.sloUrl))
  ) {
    return { ok: false, error: 'metadata_endpoint_not_allowed' }
  }

  const oldCerts = parseStoredCertificates(row.idp_certificates)
  const certificatesChanged = certificateSetChanged(oldCerts, metadata.certificates)
  const changed =
    certificatesChanged ||
    metadata.entityId !== row.idp_entity_id ||
    metadata.ssoUrl !== row.idp_sso_url ||
    metadata.sloUrl !== row.idp_slo_url
  if (!changed) return { ok: true, changed: false }

  await env.DB.prepare(
    `UPDATE sso_connections
       SET idp_entity_id = ?, idp_sso_url = ?, idp_slo_url = ?,
           idp_certificates = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'active' AND protocol = 'saml'`,
  )
    .bind(
      metadata.entityId,
      metadata.ssoUrl,
      metadata.sloUrl,
      JSON.stringify(metadata.certificates),
      Date.now(),
      row.tenant_id,
      row.id,
    )
    .run()

  if (certificatesChanged) {
    await env.WEBHOOK_QUEUE.send({
      tenantId: row.tenant_id,
      event: 'connection.saml_certificate_renewed',
      payload: {
        connection_id: row.id,
        org_id: row.org_id,
        certificate_count: metadata.certificates.length,
      },
    })
  }
  return { ok: true, changed: true }
}

async function refreshAndRecord(env: Env, row: IdpMetadataConnectionRow): Promise<void> {
  const outcome = await refreshIdpMetadata(env, row)
  const now = Date.now()
  if (outcome.ok) {
    await recordRefreshSuccess(env, row, now)
    return
  }
  logWorkerWarning('cron.daily.saml_metadata_refresh_failed', {
    component: 'daily-cron',
    operation: 'saml_metadata',
    outcome: 'kept_previous_configuration',
    reason: outcome.error,
    ...(outcome.status === undefined ? {} : { status: outcome.status }),
  })
  await recordRefreshFailure(env, row, outcome.error, now)
}

export async function pollSamlIdpMetadata(env: Env): Promise<void> {
  let cursor: string | null = null
  while (true) {
    const where: string = cursor === null ? '' : 'AND id > ?'
    const params: unknown[] =
      cursor === null ? [SAML_METADATA_PAGE_SIZE] : [cursor, SAML_METADATA_PAGE_SIZE]
    const rows: D1Result<IdpMetadataConnectionRow> = await env.DB.prepare(
      `SELECT id, tenant_id, org_id, idp_metadata_url, idp_entity_id, idp_sso_url, idp_slo_url,
              idp_certificates
         FROM sso_connections
         WHERE protocol = 'saml'
           AND status = 'active'
           AND idp_metadata_url IS NOT NULL
           ${where}
         ORDER BY id
         LIMIT ?`,
    )
      .bind(...params)
      .all<IdpMetadataConnectionRow>()

    if (rows.results.length === 0) break
    for (const row of rows.results) {
      try {
        await refreshAndRecord(env, row)
      } catch (error) {
        logWorkerError('cron.daily.saml_metadata_connection_failed', error, {
          component: 'daily-cron',
          operation: 'saml_metadata',
          outcome: 'skipped_connection',
        })
      }
    }
    cursor = rows.results[rows.results.length - 1]?.id ?? null
    if (rows.results.length < SAML_METADATA_PAGE_SIZE) break
  }
}
