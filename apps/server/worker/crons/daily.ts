// 每天 02:00 UTC Cron(0 2 * * *):JWKS 密钥轮换检查 + SAML 签名证书维护 + 域名验证轮询 + MAU 归档。
// 见 docs/design/07-platform-operations.md 7.1.4、signing-keys rule(四步轮换)。

import { generateTenantSigningKey } from '@xid-kit/crypto'
import type { SigningAlg } from '@xid-kit/types'
import { decodeKek } from '../oidc/shared'
import { createPersistedId } from '../lib/persisted-id'
import { domainVerificationRecord } from '../lib/domain-verification'
import {
  cloudflareForSaasConfigFromEnv,
  type CloudflareForSaasEnv,
} from '../lib/cloudflare-custom-hostnames'
import { logWorkerError } from '../lib/safe-log'
import { maintainCustomHostnames } from './custom-hostnames'
import { gcInactiveGuests } from './guest-gc'
import { runMonthlyUsageMaintenance } from './monthly-usage'
import { enqueueDuePrivacyRequests, expirePrivacyExports } from './privacy'
import { enqueueScheduledScimTargetSyncs } from './scim-targets'
import { reportStripeMauUsage } from '../billing/stripe-metering'
import { pollSamlIdpMetadata } from './saml-idp-metadata'
import { maintainOutboundSamlSigningCertificates } from './saml-signing-certificates'

export { gcInactiveGuests } from './guest-gc'
export {
  cleanupOldMonthlyUsage,
  evictStaleMeteringMonth,
  getPrevYearMonth,
  hardDeleteOldMonthlyUsage,
  reportMonthlyMau,
  runMonthlyUsageMaintenance,
  shouldArchivePrevMonth,
  snapshotCurrentMonthMau,
} from './monthly-usage'
export { maintainOutboundSamlSigningCertificates, pollSamlIdpMetadata }

type DomainRow = {
  id: string
  tenant_id: string
  domain: string
  verification_token: string
}

type InstanceSigningKeyRow = {
  instance_id: string
  alg: SigningAlg | string
}

const RETIRING_KEY_GRACE_MS = 60 * 60 * 1000
const ACTIVE_KEY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
const SIGNING_KEY_PAGE_SIZE = 50
const DOMAIN_PAGE_SIZE = 50
const DNS_TXT_FETCH_TIMEOUT_MS = 5_000
const KEK_VERSION = 1

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes)
}

function normalizeDnsTxt(value: string): string {
  return value.replace(/^"|"$/g, '').replace(/\\"/g, '"').trim()
}

async function fetchDnsTxtRecords(name: string): Promise<string[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`
  const response = await fetch(url, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(DNS_TXT_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) return []
  const body = (await response.json()) as { Answer?: Array<{ data?: string }> }
  return (body.Answer ?? []).map((answer) => normalizeDnsTxt(answer.data ?? '')).filter(Boolean)
}

export async function verifyDomainDnsTxt(domain: string, token: string): Promise<boolean> {
  const record = domainVerificationRecord(domain, token)
  const records = await fetchDnsTxtRecords(record.name)
  return records.some((value) => value === record.value)
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
    .bind(cutoff, SIGNING_KEY_PAGE_SIZE)
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

// 域名验证轮询:pending 域名重新校验 DNS TXT(organization_domains)。
export async function pollDomainVerification(env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, tenant_id, domain, verification_token
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
    let verified: boolean
    try {
      verified = await verifyDomainDnsTxt(row.domain, row.verification_token)
    } catch (error) {
      logWorkerError('cron.daily.domain_dns_lookup_failed', error, {
        component: 'daily-cron',
        operation: 'domain_verification',
        outcome: 'skipped_domain',
      })
      continue
    }
    await env.DB.prepare(
      `UPDATE organization_domains
         SET last_checked_at = ?, last_check_result = ?, verification_status = ?,
             verified_at = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND verification_status = 'pending' AND status = 'active'`,
    )
      .bind(
        now,
        verified ? 'found' : 'not_found',
        verified ? 'verified' : 'pending',
        verified ? now : null,
        now,
        row.tenant_id,
        row.id,
      )
      .run()
  }
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
  await runDailyPhase(
    'saml_signing_certificates',
    () => maintainOutboundSamlSigningCertificates(env),
    failures,
  )
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
    'outbound_scim_sync',
    async () => {
      await enqueueScheduledScimTargetSyncs(env)
    },
    failures,
  )
  await runDailyPhase(
    'privacy_maintenance',
    async () => {
      await expirePrivacyExports(env)
      await enqueueDuePrivacyRequests(env)
    },
    failures,
  )
  // 计费关闭时直接返回;部分配置抛 server_error,由 runDailyPhase 记录后继续其余阶段。
  await runDailyPhase('stripe_metering', () => reportStripeMauUsage(env), failures)

  if (failures.length > 0) {
    throw new AggregateError(failures, 'daily_cron_phase_failed')
  }
}
