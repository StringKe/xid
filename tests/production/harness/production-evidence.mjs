import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  assertRequiredCiConclusions,
  readConfiguredDeploymentTarget,
  readMigrationDigest,
  verifiedWranglerConfigArgs,
} from '../../../apps/server/scripts/production-target.mjs'
import { baseUrl, parseJson, run } from './production-auth.mjs'

const DEFAULT_EVIDENCE_PATH = '.xid/production-evidence.json'
const DEFAULT_REPO = 'StringKe/xid'
const WORKER_FILTER = '@xid-kit/server'

export const EVIDENCE_KEYS = {
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

async function readWorkersBuild(head) {
  const raw = await run('gh', ['api', `repos/${repo()}/commits/${head}/check-runs?per_page=100`])
  const body = parseJson(raw, 'GitHub check-runs')
  const check = body.check_runs?.find((item) => item.name === 'Workers Builds: xid')
  if (!check) throw new Error(`Workers Builds: xid check-run missing for ${head}`)
  if (check.status !== 'completed' || check.conclusion !== 'success') {
    throw new Error(
      `Workers Builds: xid not successful status=${check.status} conclusion=${check.conclusion}`,
    )
  }
  const summary = String(check.output?.summary ?? '')
  const versionId = summary.match(/Version ID:\s*([a-f0-9-]+)/u)?.[1]
  if (!versionId) throw new Error(`Workers Builds: xid missing Version ID for ${head}`)
  return {
    buildId: check.external_id ?? 'unknown',
    checkRunId: check.id,
    workerVersionId: versionId,
    ciConclusions: assertRequiredCiConclusions(raw, head),
  }
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
    ...verifiedWranglerConfigArgs(),
  ])
  const deployment = parseJson(raw, 'wrangler deployments status')
  const active = deployment.versions?.find((version) => Number(version.percentage) === 100)
  if (!active) throw new Error('Worker has no 100 percent active deployment')
  if (active.version_id !== expectedVersionId) {
    throw new Error(
      `active Worker version ${active.version_id} does not match Workers Builds version ${expectedVersionId}`,
    )
  }
  return {
    deploymentId: deployment.id,
    workerVersionId: active.version_id,
    percentage: Number(active.percentage),
  }
}

export async function readProductionEvidenceContext() {
  const target = readConfiguredDeploymentTarget()
  const head = await readGitHead()
  const workersBuild = await readWorkersBuild(head)
  const activeDeployment = await readActiveDeployment(workersBuild.workerVersionId, target)
  return {
    baseUrl,
    head,
    buildId: workersBuild.buildId,
    checkRunId: workersBuild.checkRunId,
    deploymentId: activeDeployment.deploymentId,
    workerVersionId: activeDeployment.workerVersionId,
    activePercentage: activeDeployment.percentage,
    accountId: target.accountId,
    databaseId: target.databaseId,
    migrationDigest: readMigrationDigest(),
    wranglerConfigDigest: target.configDigest,
    qualityConclusion: workersBuild.ciConclusions.quality,
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
    if (parsed?.schemaVersion !== 1 || typeof parsed.entries !== 'object') {
      throw new Error('production evidence schema is invalid')
    }
    return parsed
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { schemaVersion: 1, entries: {} }
    }
    throw new Error(`production evidence file is invalid: ${path}`, { cause: error })
  }
}

function evidenceContextMatches(left, right) {
  return (
    left?.baseUrl === right?.baseUrl &&
    left?.head === right?.head &&
    left?.buildId === right?.buildId &&
    left?.checkRunId === right?.checkRunId &&
    left?.deploymentId === right?.deploymentId &&
    left?.workerVersionId === right?.workerVersionId &&
    left?.activePercentage === right?.activePercentage &&
    left?.accountId === right?.accountId &&
    left?.databaseId === right?.databaseId &&
    left?.migrationDigest === right?.migrationDigest &&
    left?.wranglerConfigDigest === right?.wranglerConfigDigest &&
    left?.qualityConclusion === right?.qualityConclusion &&
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
