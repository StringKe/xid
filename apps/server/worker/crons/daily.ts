// 每天 02:00 UTC Cron(0 2 * * *):JWKS 密钥轮换检查 + 证书状态轮询 + 域名验证轮询 + MAU 归档。
// 见 docs/design/07-platform-operations.md 7.1.4、signing-keys rule(四步轮换)。

import { generateTenantSigningKey } from '@xid-kit/crypto'
import { USER_PROVISIONED_BY_ANONYMOUS } from '@xid-kit/db'
import { parseIdpMetadataXml } from '@xid-kit/saml'
import type { SigningAlg } from '@xid-kit/types'
import { decodeKek } from '../oidc/shared'
import { createPersistedId } from '../lib/persisted-id'
import { sessionDoRevokeAll } from '../lib/session'
import { GUEST_GC_INACTIVE_DAYS } from '../lib/ttl'
import { isPublicHttpsUrl } from '../lib/validate'
import {
  cloudflareForSaasConfigFromEnv,
  type CloudflareForSaasEnv,
} from '../lib/cloudflare-custom-hostnames'
import { logWorkerError } from '../lib/safe-log'
import { maintainCustomHostnames } from './custom-hostnames'
import { enqueueDuePrivacyRequests, expirePrivacyExports } from './privacy'
import { reportStripeMauUsage } from '../billing/stripe-metering'

// MeteringDO RPC stub(取最终 MAU 数值)。
type MeteringCountStub = {
  getMau(tenantId: string, yearMonth: string): Promise<number>
  evictMonth(yearMonth: string): Promise<void>
}

type DomainRow = {
  id: string
  domain: string
  verification_token: string
}

type InstanceSigningKeyRow = {
  instance_id: string
  alg: SigningAlg | string
}

type IdpMetadataConnectionRow = {
  id: string
  tenant_id: string
  org_id: string
  idp_metadata_url: string
  idp_certificates: string | string[] | null
}

const RETIRING_KEY_GRACE_MS = 60 * 60 * 1000
const ACTIVE_KEY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
const TENANT_PAGE_SIZE = 50
const DOMAIN_PAGE_SIZE = 50
const SAML_METADATA_PAGE_SIZE = 50
const SAML_METADATA_MAX_BYTES = 1024 * 1024
const SAML_METADATA_FETCH_TIMEOUT_MS = 10_000
const VERIFY_TXT_PREFIX = 'xid-verify='
const KEK_VERSION = 1

// 上月 "YYYY-MM"(UTC)。
export function getPrevYearMonth(now: Date = new Date()): string {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() // 0-based,当前月
  // 上一个月:m===0 时跨年
  const prev = m === 0 ? new Date(Date.UTC(y - 1, 11, 1)) : new Date(Date.UTC(y, m - 1, 1))
  const py = prev.getUTCFullYear()
  const pm = String(prev.getUTCMonth() + 1).padStart(2, '0')
  return `${py}-${pm}`
}

// 当月第一天只归档上月,避免每天重复上报同一周期。
export function shouldArchivePrevMonth(now: Date = new Date()): boolean {
  return now.getUTCDate() === 1
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes)
}

function normalizeDnsTxt(value: string): string {
  return value.replace(/^"|"$/g, '').replace(/\\"/g, '"').trim()
}

function expectedTxt(token: string): string {
  return `${VERIFY_TXT_PREFIX}${token}`
}

function dnsTxtName(domain: string): string {
  return `_xid.${domain.replace(/^\*\./, '')}`
}

async function fetchDnsTxtRecords(domain: string): Promise<string[]> {
  const name = dnsTxtName(domain)
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`
  const response = await fetch(url, {
    headers: { accept: 'application/dns-json' },
  })
  if (!response.ok) return []
  const body = (await response.json()) as { Answer?: Array<{ data?: string }> }
  return (body.Answer ?? []).map((answer) => normalizeDnsTxt(answer.data ?? '')).filter(Boolean)
}

export async function verifyDomainDnsTxt(domain: string, token: string): Promise<boolean> {
  const records = await fetchDnsTxtRecords(domain)
  const expected = expectedTxt(token)
  return records.some((record) => record === expected)
}

// JWKS 密钥轮换检查:到达 retire_after 的旧公钥下线;active 密钥临近过期则发布 next key。
// 四步轮换(signing-keys rule):此 Cron 负责第 1 步(发布 next)和第 4 步(下线 retiring)。
// 第 3 步切 active 仍必须由显式管理流程触发,避免后台在 RP 缓存窗口外擅自切签名 kid。
export async function rotateSigningKeysCheck(env: Env): Promise<void> {
  const now = Date.now()
  await env.DB.prepare(
    `UPDATE instance_signing_keys SET status = 'retired', updated_at = ?
       WHERE status = 'retiring' AND retire_after IS NOT NULL AND retire_after < ?`,
  )
    .bind(now, now)
    .run()

  const cutoff = now - ACTIVE_KEY_MAX_AGE_MS
  const staleActive = await env.DB.prepare(
    `SELECT active.instance_id AS instance_id, active.alg AS alg
       FROM instance_signing_keys active
       WHERE active.status = 'active'
         AND active.activated_at IS NOT NULL
         AND active.activated_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM instance_signing_keys next_key
           WHERE next_key.instance_id = active.instance_id AND next_key.status = 'next'
         )
       ORDER BY active.activated_at ASC, active.instance_id ASC
       LIMIT ?`,
  )
    .bind(cutoff, TENANT_PAGE_SIZE)
    .all<InstanceSigningKeyRow>()

  if (staleActive.results.length === 0) return

  const kekRaw = decodeKek(env.KEK)
  try {
    for (const row of staleActive.results) {
      const kid = `key_${crypto.randomUUID()}`
      const alg: SigningAlg = row.alg === 'RS256' || row.alg === 'PS256' ? row.alg : 'ES256'
      const { material } = await generateTenantSigningKey({
        kid,
        kekRaw,
        kekVersion: KEK_VERSION,
        alg,
        status: 'next',
      })
      const enc = material.encryptedPrivateKey
      await env.DB.prepare(
        `INSERT INTO instance_signing_keys (
           id, instance_id, kid, alg, public_key_jwk, private_key_iv, private_key_ciphertext,
           private_key_tag, kek_version, status, activated_at, retire_after, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'next', NULL, NULL, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
        .bind(
          createPersistedId('signingKey'),
          row.instance_id,
          material.kid,
          material.alg,
          JSON.stringify(material.publicKeyJwk),
          toBuffer(enc.iv),
          toBuffer(enc.ciphertext),
          toBuffer(enc.tag),
          enc.kekVersion,
          now,
          now,
        )
        .run()
    }
  } finally {
    kekRaw.fill(0)
  }
}

// 旧 retiring key 没有 retire_after 的历史行,按 1h JWKS TTL 兜底下线。
export async function backfillRetiringKeyRetireAfter(env: Env): Promise<void> {
  const now = Date.now()
  const fallback = now + RETIRING_KEY_GRACE_MS
  await env.DB.prepare(
    `UPDATE instance_signing_keys
       SET retire_after = ?, updated_at = ?
       WHERE status = 'retiring' AND retire_after IS NULL`,
  )
    .bind(fallback, now)
    .run()
}

// 证书状态轮询:临近 not_after 的证书继续为现有 SP 签名,但不再分配给新 SP。
export async function pollCertificateStatus(env: Env): Promise<void> {
  const soon = Date.now() + 1000 * 60 * 60 * 24 * 30 // 30 天内到期
  await env.DB.prepare(
    `UPDATE cert_store SET status = 'retiring', updated_at = ?
       WHERE tenant_id IS NOT NULL
         AND usage = 'saml_idp_signing'
         AND status = 'active'
         AND not_after IS NOT NULL
         AND not_after < ?`,
  )
    .bind(Date.now(), soon)
    .run()
}

// 域名验证轮询:pending 域名重新校验 DNS TXT(organization_domains)。
export async function pollDomainVerification(env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, domain, verification_token
       FROM organization_domains
       WHERE status = 'active'
         AND verification_method = 'dns_txt'
         AND verification_status = 'pending'
       ORDER BY id
       LIMIT ?`,
  )
    .bind(DOMAIN_PAGE_SIZE)
    .all<DomainRow>()
  const now = Date.now()
  for (const row of rows.results) {
    if (await verifyDomainDnsTxt(row.domain, row.verification_token)) {
      await env.DB.prepare(
        `UPDATE organization_domains
           SET verification_status = 'verified', verified_at = ?, updated_at = ?
           WHERE id = ? AND verification_status = 'pending' AND status = 'active'`,
      )
        .bind(now, now, row.id)
        .run()
    }
  }
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
    if (total > maxBytes) throw new Error('metadata_too_large')
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

async function refreshIdpMetadata(env: Env, row: IdpMetadataConnectionRow): Promise<void> {
  if (!isPublicHttpsUrl(row.idp_metadata_url)) return
  const response = await fetch(row.idp_metadata_url, {
    headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' },
    redirect: 'manual',
    signal: AbortSignal.timeout(SAML_METADATA_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) return
  const xml = await readBoundedText(response, SAML_METADATA_MAX_BYTES)
  const parsed = parseIdpMetadataXml(xml)
  if (
    !parsed.ok ||
    !isPublicHttpsUrl(parsed.value.ssoUrl) ||
    (parsed.value.sloUrl !== null && !isPublicHttpsUrl(parsed.value.sloUrl))
  ) {
    return
  }

  const oldCerts = parseStoredCertificates(row.idp_certificates)
  const newCerts = parsed.value.certificates
  const now = Date.now()
  await env.DB.prepare(
    `UPDATE sso_connections
       SET idp_entity_id = ?, idp_sso_url = ?, idp_slo_url = ?,
           idp_certificates = ?, updated_at = ?
       WHERE id = ? AND status = 'active' AND protocol = 'saml'`,
  )
    .bind(
      parsed.value.entityId,
      parsed.value.ssoUrl,
      parsed.value.sloUrl,
      JSON.stringify(newCerts),
      now,
      row.id,
    )
    .run()

  if (certificateSetChanged(oldCerts, newCerts)) {
    await env.WEBHOOK_QUEUE.send({
      tenantId: row.tenant_id,
      event: 'connection.saml_certificate_renewed',
      payload: {
        connection_id: row.id,
        org_id: row.org_id,
        certificate_count: newCerts.length,
      },
    })
  }
}

// IdP metadata URL 每日刷新:拉取 active SAML connection 的 metadata,更新 entityID/SSO URL/证书。
export async function pollSamlIdpMetadata(env: Env): Promise<void> {
  let cursor: string | null = null
  while (true) {
    const where: string = cursor === null ? '' : 'AND id > ?'
    const params: unknown[] =
      cursor === null ? [SAML_METADATA_PAGE_SIZE] : [cursor, SAML_METADATA_PAGE_SIZE]
    const rows: D1Result<IdpMetadataConnectionRow> = await env.DB.prepare(
      `SELECT id, tenant_id, org_id, idp_metadata_url, idp_certificates
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
        await refreshIdpMetadata(env, row)
      } catch {
        // 单个 IdP metadata 拉取失败不阻断整轮 daily Cron。
      }
    }
    cursor = rows.results[rows.results.length - 1]?.id ?? null
    if (rows.results.length < SAML_METADATA_PAGE_SIZE) break
  }
}

type UsageMonthlyInput = {
  tenantId: string
  yearMonth: string
  mau: number
  archivedAt: string
}

async function upsertUsageMonthly(env: Env, input: UsageMonthlyInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage_monthly (tenant_id, year_month, mau, archived_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (tenant_id, year_month) DO UPDATE SET mau = excluded.mau, archived_at = excluded.archived_at`,
  )
    .bind(input.tenantId, input.yearMonth, input.mau, input.archivedAt)
    .run()
}

async function eachActiveTenant(
  env: Env,
  visit: (tenantId: string) => Promise<void>,
): Promise<void> {
  let cursor: string | null = null
  while (true) {
    const where: string = cursor === null ? '' : 'AND id > ?'
    const params: unknown[] = cursor === null ? [TENANT_PAGE_SIZE] : [cursor, TENANT_PAGE_SIZE]
    const tenants: D1Result<{ tenant_id: string }> = await env.DB.prepare(
      `SELECT id AS tenant_id FROM organizations
         WHERE status = 'active' AND parent_org_id IS NULL ${where}
         ORDER BY id
         LIMIT ?`,
    )
      .bind(...params)
      .all<{ tenant_id: string }>()
    if (tenants.results.length === 0) break
    for (const { tenant_id } of tenants.results) {
      await visit(tenant_id)
    }
    cursor = tenants.results[tenants.results.length - 1]?.tenant_id ?? null
    if (tenants.results.length < TENANT_PAGE_SIZE) break
  }
}

// MAU 归档:从 MeteringDO 取上月最终 MAU,写 usage_monthly。
export async function reportMonthlyMau(env: Env, now: Date = new Date()): Promise<void> {
  if (!shouldArchivePrevMonth(now)) return
  const yearMonth = getPrevYearMonth(now)
  const archivedAt = now.toISOString()
  await eachActiveTenant(env, async (tenantId) => {
    const stub = env.METERING.get(
      env.METERING.idFromName(`metering:${tenantId}`),
    ) as unknown as DurableObjectStub & MeteringCountStub
    const mau = await stub.getMau(tenantId, yearMonth)
    await upsertUsageMonthly(env, { tenantId, yearMonth, mau, archivedAt })
    await stub.evictMonth(yearMonth)
  })
}

// 当月快照:platform billing/stats 读取 usage_monthly 当月行,每日补齐 active tenant 当前 MAU。
export async function snapshotCurrentMonthMau(env: Env, now: Date = new Date()): Promise<void> {
  const yearMonth = now.toISOString().slice(0, 7)
  const archivedAt = now.toISOString()
  await eachActiveTenant(env, async (tenantId) => {
    const stub = env.METERING.get(
      env.METERING.idFromName(`metering:${tenantId}`),
    ) as unknown as DurableObjectStub & MeteringCountStub
    const mau = await stub.getMau(tenantId, yearMonth)
    await upsertUsageMonthly(env, { tenantId, yearMonth, mau, archivedAt })
  })
}

export async function cleanupOldMonthlyUsage(env: Env, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 1))
  const cutoffYearMonth = cutoff.toISOString().slice(0, 7)
  await hardDeleteOldMonthlyUsage(env, cutoffYearMonth)
}

// 物理删除只用于按保留期滚动清理聚合计量事实。审计事件和身份资源不走此路径。
export async function hardDeleteOldMonthlyUsage(env: Env, cutoffYearMonth: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM usage_monthly WHERE year_month < ?`).bind(cutoffYearMonth).run()
}

export async function runMonthlyUsageMaintenance(env: Env, now: Date = new Date()): Promise<void> {
  await snapshotCurrentMonthMau(env, now)
  await reportMonthlyMau(env, now)
  if (shouldArchivePrevMonth(now)) {
    await cleanupOldMonthlyUsage(env, now)
  }
}

// ---- guest GC:不活跃满 GUEST_GC_INACTIVE_DAYS 天的 anonymous 用户软删(01 章 guest 模式)----

const GUEST_GC_PAGE_SIZE = 100
const DAY_MS = 24 * 60 * 60 * 1000

type GuestGcRow = { id: string; delete_tenant: number }

const GUEST_GC_TENANT_BLOCKING_TABLES = [
  'projects',
  'applications',
  'project_grants',
  'org_policies',
  'roles',
  'permissions',
  'role_permissions',
  'user_grants',
  'manager_assignments',
  'invitations',
  'organization_domains',
  'sso_connections',
  'cert_store',
  'saml_service_providers',
  'saml_session_bindings',
  'directories',
  'directory_users',
  'directory_groups',
  'directory_group_members',
  'directory_pending_members',
  'scim_targets',
  'api_keys',
  'webhooks',
  'authorization_codes',
  'refresh_tokens',
  'access_token_revocations',
  'access_token_issuances',
  'oauth_consents',
  'resource_servers',
] as const

function ownedOnboardingTenantExists(userRef: string): string {
  return `EXISTS (
    SELECT 1
      FROM organizations owned
      JOIN memberships owner_membership
        ON owner_membership.tenant_id = owned.tenant_id
       AND owner_membership.org_id = owned.id
       AND owner_membership.user_id = ${userRef}.id
       AND owner_membership.role = 'owner'
       AND owner_membership.status = 'active'
     WHERE owned.id = ${userRef}.tenant_id
       AND owned.tenant_id = ${userRef}.tenant_id
       AND owned.parent_org_id IS NULL
       AND owned.slug <> 'default'
       AND owned.status = 'active'
       AND owned.deleted_at IS NULL
  )`
}

function tenantHasNoBlockingResources(userRef: string): string {
  return GUEST_GC_TENANT_BLOCKING_TABLES.map(
    (table) =>
      `NOT EXISTS (
        SELECT 1 FROM ${table}
         WHERE tenant_id = ${userRef}.tenant_id
      )`,
  ).join('\n          AND ')
}

function userHasNoBlockingBusinessRows(userRef: string): string {
  return `NOT EXISTS (
      SELECT 1 FROM manager_assignments
       WHERE tenant_id = ${userRef}.tenant_id
         AND user_id = ${userRef}.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM user_grants
       WHERE tenant_id = ${userRef}.tenant_id
         AND user_id = ${userRef}.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM invitations
       WHERE tenant_id = ${userRef}.tenant_id
         AND (
           invited_by_user_id = ${userRef}.id
           OR accepted_by_user_id = ${userRef}.id
         )
    )
    AND NOT EXISTS (
      SELECT 1 FROM authorization_codes
       WHERE tenant_id = ${userRef}.tenant_id
         AND user_id = ${userRef}.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM refresh_tokens
       WHERE tenant_id = ${userRef}.tenant_id
         AND user_id = ${userRef}.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM oauth_consents
       WHERE tenant_id = ${userRef}.tenant_id
         AND user_id = ${userRef}.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM saml_session_bindings
       WHERE tenant_id = ${userRef}.tenant_id
         AND user_id = ${userRef}.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM directory_users
       WHERE tenant_id = ${userRef}.tenant_id
         AND user_id = ${userRef}.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM access_token_issuances
       WHERE tenant_id = ${userRef}.tenant_id
         AND subject = ${userRef}.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM access_token_revocations
       WHERE tenant_id = ${userRef}.tenant_id
         AND subject = ${userRef}.id
    )`
}

function safeOwnedOnboardingTenant(userRef: string): string {
  return `${ownedOnboardingTenantExists(userRef)}
    AND NOT EXISTS (
      SELECT 1 FROM users other_user
       WHERE other_user.tenant_id = ${userRef}.tenant_id
         AND other_user.id <> ${userRef}.id
         AND other_user.deleted_at IS NULL
         AND other_user.status <> 'deleted'
    )
    AND NOT EXISTS (
      SELECT 1 FROM memberships other_membership
       WHERE other_membership.tenant_id = ${userRef}.tenant_id
         AND other_membership.status = 'active'
         AND NOT (
           other_membership.org_id = ${userRef}.tenant_id
           AND other_membership.user_id = ${userRef}.id
           AND other_membership.role = 'owner'
         )
    )
    AND NOT EXISTS (
      SELECT 1 FROM organizations child
       WHERE child.tenant_id = ${userRef}.tenant_id
         AND child.id <> ${userRef}.tenant_id
         AND child.deleted_at IS NULL
         AND child.status <> 'deleted'
    )
    AND ${tenantHasNoBlockingResources(userRef)}`
}

function safeGuestGcTarget(userRef: string, deleteTenant: boolean): string {
  const membershipGuard = deleteTenant
    ? safeOwnedOnboardingTenant(userRef)
    : `NOT ${ownedOnboardingTenantExists(userRef)}
       AND NOT EXISTS (
         SELECT 1 FROM memberships active_membership
          WHERE active_membership.tenant_id = ${userRef}.tenant_id
            AND active_membership.user_id = ${userRef}.id
            AND active_membership.status = 'active'
       )`
  return `${userRef}.provisioned_by = ?
    AND ${userRef}.deleted_at IS NULL
    AND ${userRef}.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM user_emails verified_email
       WHERE verified_email.tenant_id = ${userRef}.tenant_id
         AND verified_email.user_id = ${userRef}.id
         AND verified_email.verified = 1
    )
    AND COALESCE(
      (
        SELECT MAX(active_session.last_active_at)
          FROM sessions active_session
         WHERE active_session.tenant_id = ${userRef}.tenant_id
           AND active_session.user_id = ${userRef}.id
      ),
      ${userRef}.created_at
    ) < ?
    AND ${userHasNoBlockingBusinessRows(userRef)}
    AND ${membershipGuard}`
}

function claimedGuestExists(): string {
  return `EXISTS (
    SELECT 1 FROM users claimed_guest
     WHERE claimed_guest.tenant_id = ?
       AND claimed_guest.id = ?
       AND claimed_guest.provisioned_by = ?
       AND claimed_guest.status = 'deleted'
       AND claimed_guest.deleted_at = ?
  )`
}

function guestGcClosureStatements(opts: {
  env: Env
  tenantId: string
  userId: string
  deleteTenant: boolean
  nowMs: number
}): D1PreparedStatement[] {
  const { env, tenantId, userId, deleteTenant, nowMs } = opts
  const claimed = claimedGuestExists()
  const claimParams = [tenantId, userId, USER_PROVISIONED_BY_ANONYMOUS, nowMs] as const
  return [
    env.DB.prepare(
      `UPDATE sessions
          SET status = 'revoked'
        WHERE tenant_id = ? AND user_id = ? AND ${claimed}`,
    ).bind(tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE memberships
          SET status = 'inactive', updated_at = ?
        WHERE tenant_id = ? AND user_id = ? AND status = 'active' AND ${claimed}`,
    ).bind(nowMs, tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE user_emails
          SET verification_status = 'expired', updated_at = ?
        WHERE tenant_id = ? AND user_id = ? AND verified = 0 AND ${claimed}`,
    ).bind(nowMs, tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE user_phones
          SET verification_status = 'expired', updated_at = ?
        WHERE tenant_id = ? AND user_id = ? AND verified = 0 AND ${claimed}`,
    ).bind(nowMs, tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE user_identities
          SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
        WHERE tenant_id = ? AND user_id = ? AND ${claimed}`,
    ).bind(nowMs, nowMs, tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE password_reset_tokens
          SET consumed_at = COALESCE(consumed_at, ?)
        WHERE tenant_id = ? AND user_id = ? AND ${claimed}`,
    ).bind(nowMs, tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE verification_tokens
          SET consumed_at = COALESCE(consumed_at, ?)
        WHERE tenant_id = ? AND user_id = ? AND ${claimed}`,
    ).bind(nowMs, tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE passkey_credentials
          SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
        WHERE tenant_id = ? AND user_id = ? AND ${claimed}`,
    ).bind(nowMs, nowMs, tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE mfa_factors
          SET status = 'disabled', updated_at = ?
        WHERE tenant_id = ? AND user_id = ? AND status <> 'disabled' AND ${claimed}`,
    ).bind(nowMs, tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE backup_codes
          SET used = 1, used_at = COALESCE(used_at, ?)
        WHERE tenant_id = ? AND user_id = ? AND used = 0 AND ${claimed}`,
    ).bind(nowMs, tenantId, userId, ...claimParams),
    env.DB.prepare(
      `UPDATE trusted_devices
          SET revoked_at = COALESCE(revoked_at, ?)
        WHERE tenant_id = ? AND user_id = ? AND ${claimed}`,
    ).bind(nowMs, tenantId, userId, ...claimParams),
    ...(deleteTenant
      ? [
          env.DB.prepare(
            `UPDATE organizations
                SET deleted_at = ?, status = 'deleted', updated_at = ?
              WHERE tenant_id = ?
                AND id = ?
                AND parent_org_id IS NULL
                AND slug <> 'default'
                AND status = 'active'
                AND deleted_at IS NULL
                AND ${claimed}`,
          ).bind(nowMs, nowMs, tenantId, tenantId, ...claimParams),
        ]
      : []),
  ]
}

// 单租户一轮:按"最后活跃"窗口软删 guest。
// 活跃基准:无 session 按 users.created_at;有 session 按该 user 最新 session.last_active_at。
// cron 无 TenantContext,raw SQL 显式绑 tenant_id(tenant-isolation rule 允许场景)。
async function gcInactiveGuestsForTenant(
  env: Env,
  tenantId: string,
  cutoffMs: number,
  nowMs: number,
): Promise<void> {
  // 软删后行被 deleted_at IS NULL 条件排除,同一 SELECT 循环翻页直到无命中。
  while (true) {
    const rows = await env.DB.prepare(
      `SELECT u.id AS id,
              CASE WHEN ${ownedOnboardingTenantExists('u')} THEN 1 ELSE 0 END AS delete_tenant
         FROM users u
        WHERE u.tenant_id = ?
          AND (
            (${safeGuestGcTarget('u', false)})
            OR (${safeGuestGcTarget('u', true)})
          )
        ORDER BY u.id
        LIMIT ?`,
    )
      .bind(
        tenantId,
        USER_PROVISIONED_BY_ANONYMOUS,
        cutoffMs,
        USER_PROVISIONED_BY_ANONYMOUS,
        cutoffMs,
        GUEST_GC_PAGE_SIZE,
      )
      .all<GuestGcRow>()
    if (rows.results.length === 0) return

    for (const row of rows.results) {
      const deleteTenant = row.delete_tenant === 1
      const statements = [
        env.DB.prepare(
          `UPDATE users
              SET deleted_at = ?, status = 'deleted', updated_at = ?
            WHERE tenant_id = ?
              AND id = ?
              AND ${safeGuestGcTarget('users', deleteTenant)}`,
        ).bind(nowMs, nowMs, tenantId, row.id, USER_PROVISIONED_BY_ANONYMOUS, cutoffMs),
        ...guestGcClosureStatements({
          env,
          tenantId,
          userId: row.id,
          deleteTenant,
          nowMs,
        }),
      ]
      const results = await env.DB.batch(statements)
      if ((results[0]?.meta.changes ?? 0) !== 1) continue
      await sessionDoRevokeAll(env, row.id)
      // 审计链 INSERT only:GC 也是身份资源变更,必须留痕(actor 为系统,不填 actorId)。
      await env.AUDIT_QUEUE.send({
        tenantId,
        action: 'guest.gc_deleted',
        ts: nowMs,
        payload: { targetType: 'user', targetId: row.id },
      })
    }
    if (rows.results.length < GUEST_GC_PAGE_SIZE) return
  }
}

// 每日扫全量 active tenant 的不活跃 guest 并软删(复用 eachActiveTenant 的租户分页)。
export async function gcInactiveGuests(env: Env, now: Date = new Date()): Promise<void> {
  const nowMs = now.getTime()
  const cutoffMs = nowMs - GUEST_GC_INACTIVE_DAYS * DAY_MS
  await eachActiveTenant(env, (tenantId) =>
    gcInactiveGuestsForTenant(env, tenantId, cutoffMs, nowMs),
  )
}

async function runDailyPhase(
  name: string,
  run: () => Promise<void>,
  failures: unknown[],
): Promise<void> {
  try {
    await run()
  } catch (error) {
    failures.push(error)
    logWorkerError('cron.daily.phase_failed', error, {
      component: 'daily-cron',
      operation: name,
      outcome: 'continued_remaining_phases',
    })
  }
}

export async function runDaily(env: Env): Promise<void> {
  const failures: unknown[] = []

  await runDailyPhase(
    'signing_key_maintenance',
    async () => {
      await backfillRetiringKeyRetireAfter(env)
      await rotateSigningKeysCheck(env)
    },
    failures,
  )
  await runDailyPhase('certificate_status', () => pollCertificateStatus(env), failures)
  await runDailyPhase('domain_verification', () => pollDomainVerification(env), failures)
  await runDailyPhase(
    'custom_hostname_maintenance',
    async () => {
      if (cloudflareForSaasConfigFromEnv(env as CloudflareForSaasEnv)) {
        await maintainCustomHostnames(env)
      }
    },
    failures,
  )
  await runDailyPhase('saml_metadata', () => pollSamlIdpMetadata(env), failures)
  await runDailyPhase('usage_maintenance', () => runMonthlyUsageMaintenance(env), failures)
  await runDailyPhase('guest_gc', () => gcInactiveGuests(env), failures)
  await runDailyPhase(
    'privacy_maintenance',
    async () => {
      await expirePrivacyExports(env)
      await enqueueDuePrivacyRequests(env)
    },
    failures,
  )
  // Optional managed-service adapter. Self-hosted deployments with no Stripe config return here.
  await runDailyPhase('stripe_metering', () => reportStripeMauUsage(env), failures)

  if (failures.length > 0) {
    throw new AggregateError(failures, 'daily_cron_phase_failed')
  }
}
