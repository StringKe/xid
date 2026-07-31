import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  assertActiveDeployment,
  assertSuccessfulWorkersBuilds,
  parsePendingD1Migrations,
  PRODUCTION_WORKER_KEYS,
  readCloudflareSecurityRulesState,
  readConfiguredDeploymentTargets,
  readMigrationDigest,
  verifiedRemoteD1MigrationArgs,
  verifiedWranglerConfigArgs,
} from '../../../apps/server/scripts/production-target.mjs'
import { baseUrl, run } from './production-auth.mjs'

const DEFAULT_EVIDENCE_PATH = '.xid/production-evidence.json'
const DEFAULT_REPO = 'StringKe/xid'
const WORKER_FILTER = '@xid-kit/server'
const PRODUCTION_EVIDENCE_SCHEMA_VERSION = 3

export const EVIDENCE_KEYS = {
  deadLetterOperations: 'dead-letter-operations-l4',
  observabilityOperations: 'observability-operations-l4',
  outboundScimSaas: 'outbound-scim-saas-l4',
  magicLinkFull: 'magic-link-full-l4',
  passwordResetFull: 'password-reset-full-l4',
  productionBrowserP0: 'production-browser-p0-l4',
  publicDocsBrowser: 'public-docs-browser-l4',
  phoneOtpWhatsappFull: 'phone-otp-whatsapp-full-l4',
  phoneOtpSmsFull: 'phone-otp-sms-full-l4',
  socialOauthFull: 'social-oauth-full-l4',
  enterpriseSsoFull: 'enterprise-sso-full-l4',
  mfaSmsFull: 'mfa-sms-full-l4',
}

export const EVIDENCE_MARKERS = {
  deadLetterOperations: [
    'source_dlq_delivery',
    'encrypted_persistence',
    'console_list_detail',
    'manual_replay',
    'replay_completed',
    'alert_delivery',
    'cleanup',
  ],
  observabilityOperations: [
    'worker_logs_access_reviewed',
    'retention_policy_verified',
    'alert_delivery_drill',
    'sensitive_data_redaction_verified',
  ],
  outboundScimSaas: [
    'real_saas_target',
    'user_lifecycle',
    'group_lifecycle',
    'rate_limit_retry',
    'audit_recorded',
    'cleanup',
  ],
  magicLinkFull: [
    'browser_default_console',
    'session_me_200',
    'token_consumed',
    'second_click_invalid',
  ],
  passwordResetFull: [
    'browser_default_console',
    'session_me_active_org',
    'token_consumed',
    'replay_invalid',
    'cleanup',
  ],
  productionBrowserP0: [
    'email_otp_console',
    'docs_root',
    'public_docs',
    'console_routes',
    'sdk_browser',
    'mfa_provider_gate',
    'cleanup',
  ],
  publicDocsBrowser: ['docs_root_public', 'docs_scim_public', 'docs_localized_public'],
  phoneOtpFull: [
    'notification_sent',
    'verify_session',
    'me_active_org',
    'token_consumed',
    'replay_invalid',
    'cleanup',
  ],
  socialOauthFull: ['provider_callback', 'session_active', 'me_active_org', 'identity_linked'],
  enterpriseSsoFull: ['idp_callback', 'session_active', 'me_active_org', 'identity_linked'],
  mfaSmsFull: ['challenge_send', 'verify', 'active_session', 'replay_invalid'],
}

function evidencePath() {
  return process.env['XID_PRODUCTION_EVIDENCE_FILE']?.trim() || DEFAULT_EVIDENCE_PATH
}

function repo() {
  return process.env['XID_GITHUB_REPO']?.trim() || DEFAULT_REPO
}

function assertSafeMarker(value) {
  const text = String(value)
  const forbidden = [
    /@/u,
    /\beyJ[A-Za-z0-9_-]+\./u,
    /token=/iu,
    /code=/iu,
    /cookie/iu,
    /__Host-xid/iu,
    /https:\/\/xid\.dev\/auth\/magic-link\/verify/iu,
    /https:\/\/xid\.dev\/reset-password/iu,
    /\+[0-9]{8,}/u,
  ]
  if (forbidden.some((pattern) => pattern.test(text))) {
    throw new Error(`production evidence marker is not safe: ${text}`)
  }
}

async function readGitHead() {
  return (await run('git', ['rev-parse', 'HEAD'])).trim()
}

async function readWorkersBuild(head, targets) {
  const raw = await run('gh', ['api', `repos/${repo()}/commits/${head}/check-runs?per_page=100`])
  return assertSuccessfulWorkersBuilds(raw, head, targets)
}

async function readActiveDeployment(expectedVersionId, target) {
  const raw = await run('pnpm', [
    '--filter',
    WORKER_FILTER,
    'exec',
    'wrangler',
    'deployments',
    'status',
    '--name',
    target.workerName,
    '--json',
    ...verifiedWranglerConfigArgs(target.configPath),
  ])
  return assertActiveDeployment(raw, expectedVersionId, target.workerName)
}

async function readRemoteD1Migrations(target) {
  const raw = await run('pnpm', verifiedRemoteD1MigrationArgs(target.configPath), {
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: target.accountId,
    },
  })
  const pending = parsePendingD1Migrations(raw)
  return {
    state: pending.length === 0 ? 'APPLIED' : 'PENDING',
    pending,
  }
}

export async function readProductionEvidenceContext() {
  const targets = readConfiguredDeploymentTargets()
  const head = await readGitHead()
  const workersBuild = await readWorkersBuild(head, targets)
  const workers = {}
  for (const key of PRODUCTION_WORKER_KEYS) {
    const build = workersBuild.workers[key]
    const deployment = await readActiveDeployment(build.workerVersionId, targets[key])
    workers[key] = {
      ...build,
      deploymentId: deployment.deploymentId,
      workerVersionId: deployment.workerVersionId,
      activePercentage: deployment.activePercentage,
    }
  }
  return {
    baseUrl,
    head,
    workers,
    accountId: targets.core.accountId,
    databaseId: targets.core.databaseId,
    migrationDigest: readMigrationDigest(),
    remoteD1Migrations: await readRemoteD1Migrations(targets.core),
    cloudflareSecurityRules: readCloudflareSecurityRulesState(),
    wranglerConfigDigests: Object.fromEntries(
      PRODUCTION_WORKER_KEYS.map((key) => [key, targets[key].configDigest]),
    ),
    checkConclusion: workersBuild.ciConclusions.check,
    testConclusion: workersBuild.ciConclusions.test,
    buildConclusion: workersBuild.ciConclusions.build,
    smokeConclusion: workersBuild.ciConclusions.smoke,
    securityConclusion: workersBuild.ciConclusions.security,
  }
}

export async function beginProductionEvidence() {
  return await readProductionEvidenceContext()
}

export async function readProductionEvidenceFile({
  readFileFn = readFile,
  path = evidencePath(),
} = {}) {
  try {
    const parsed = JSON.parse(await readFileFn(path, 'utf8'))
    if (
      parsed?.schemaVersion !== PRODUCTION_EVIDENCE_SCHEMA_VERSION ||
      typeof parsed.entries !== 'object'
    ) {
      throw new Error('production evidence schema is invalid')
    }
    return parsed
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { schemaVersion: PRODUCTION_EVIDENCE_SCHEMA_VERSION, entries: {} }
    }
    throw new Error(`production evidence file is invalid: ${path}`, { cause: error })
  }
}

function workerContextsMatch(left, right) {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  return PRODUCTION_WORKER_KEYS.every((key) => {
    const leftWorker = left[key]
    const rightWorker = right[key]
    return (
      leftWorker &&
      rightWorker &&
      leftWorker.buildId === rightWorker.buildId &&
      leftWorker.checkRunId === rightWorker.checkRunId &&
      leftWorker.deploymentId === rightWorker.deploymentId &&
      leftWorker.workerVersionId === rightWorker.workerVersionId &&
      leftWorker.activePercentage === rightWorker.activePercentage
    )
  })
}

function configDigestsMatch(left, right) {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  return PRODUCTION_WORKER_KEYS.every(
    (key) => typeof left[key] === 'string' && left[key] === right[key],
  )
}

function remoteD1MigrationsMatch(left, right) {
  if (!left || !right || left.state !== right.state) return false
  if (!Array.isArray(left.pending) || !Array.isArray(right.pending)) return false
  return (
    left.pending.length === right.pending.length &&
    left.pending.every((migration, index) => migration === right.pending[index])
  )
}

function cloudflareSecurityRulesMatch(left, right) {
  return (
    typeof left?.manifestDigest === 'string' &&
    left.manifestDigest === right?.manifestDigest &&
    left.deploymentState === right?.deploymentState
  )
}

function evidenceContextMatches(left, right) {
  return (
    left?.baseUrl === right?.baseUrl &&
    left?.head === right?.head &&
    workerContextsMatch(left?.workers, right?.workers) &&
    left?.accountId === right?.accountId &&
    left?.databaseId === right?.databaseId &&
    left?.migrationDigest === right?.migrationDigest &&
    remoteD1MigrationsMatch(left?.remoteD1Migrations, right?.remoteD1Migrations) &&
    cloudflareSecurityRulesMatch(left?.cloudflareSecurityRules, right?.cloudflareSecurityRules) &&
    configDigestsMatch(left?.wranglerConfigDigests, right?.wranglerConfigDigests) &&
    left?.checkConclusion === right?.checkConclusion &&
    left?.testConclusion === right?.testConclusion &&
    left?.buildConclusion === right?.buildConclusion &&
    left?.smokeConclusion === right?.smokeConclusion &&
    left?.securityConclusion === right?.securityConclusion
  )
}

export async function recordProductionEvidence(key, markers, preSmokeContext) {
  if (!Array.isArray(markers) || markers.length === 0) {
    throw new Error('production evidence markers are required')
  }
  if (!preSmokeContext || typeof preSmokeContext !== 'object') {
    throw new Error('production evidence requires a pre-smoke context')
  }
  for (const marker of markers) assertSafeMarker(marker)
  const postSmokeContext = await readProductionEvidenceContext()
  if (!evidenceContextMatches(preSmokeContext, postSmokeContext)) {
    throw new Error('production evidence context changed during smoke')
  }
  const file = await readProductionEvidenceFile()
  file.entries[key] = {
    ...postSmokeContext,
    key,
    markers: [...new Set(markers)],
    preSmokeContext,
    postSmokeContext,
    recordedAt: new Date().toISOString(),
  }
  const path = evidencePath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  return file.entries[key]
}

export function productionEvidenceReady(evidence, key, context, requiredMarkers) {
  if (evidence?.schemaVersion !== PRODUCTION_EVIDENCE_SCHEMA_VERSION) return false
  if (context?.cloudflareSecurityRules?.deploymentState !== 'RECONCILED') return false
  if (
    context?.remoteD1Migrations?.state !== 'APPLIED' ||
    context.remoteD1Migrations.pending?.length !== 0
  ) {
    return false
  }
  const entry = evidence?.entries?.[key]
  if (!entry) return false
  const markers = Array.isArray(entry.markers) ? entry.markers : []
  if (!evidenceContextMatches(entry, entry.postSmokeContext)) return false
  if (!evidenceContextMatches(entry.preSmokeContext, entry.postSmokeContext)) return false
  return (
    evidenceContextMatches(entry.postSmokeContext, context) &&
    requiredMarkers.every((marker) => markers.includes(marker))
  )
}
