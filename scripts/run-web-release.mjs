import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildArtifact, workerModuleGraphSha256 } from './build-core-compat-artifact.mjs'
import {
  validateWebReleaseManifest,
  WEB_RELEASE_PREFLIGHT_IDS,
  WEB_RELEASE_STAGE_IDS,
  WEB_ROUTE_CHANGE_IDS,
} from './web-release-manifest.mjs'
import { parseJsonc } from './verify-worker-routes.mjs'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..')
const RELEASE_ROOT = resolve(REPOSITORY_ROOT, '.xid', 'releases')
const GIT_SHA = /^[a-f0-9]{40}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const VERSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const RELEASE_ID = /^[a-z0-9][a-z0-9-]{2,63}$/u
const EXPECTED_CONFIRMATION = 'DEPLOY_XID_WEB'
export const ALLOWED_COMPAT_CORE_SHA = '995f65c6aae0bdc77e8a0fdbf0222f51143ce2d2'
const GITHUB_DEPLOYMENT_ENVIRONMENT = 'xid-web-production'
const CHECKPOINT_PHASE_STATES = new Map([
  ['PREPARED', 'in_progress'],
  ['COMPAT_INTENT', 'in_progress'],
  ['COMPAT_VERIFIED', 'in_progress'],
  ['CONSOLE_ROUTES_INTENT', 'in_progress'],
  ['SITE_ROUTES_INTENT', 'in_progress'],
  ['TIGHT_INTENT', 'in_progress'],
  ['SUCCESS', 'success'],
  ['ROLLBACK_INTENT', 'in_progress'],
  ['ROLLED_BACK', 'inactive'],
])
const CHECKPOINT_PHASES = new Set(CHECKPOINT_PHASE_STATES.keys())
const CHILD_ENVIRONMENT_NAMES = [
  'CI',
  'COLORTERM',
  'COREPACK_HOME',
  'FORCE_COLOR',
  'GITHUB_ACTIONS',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'NODE_OPTIONS',
  'NO_COLOR',
  'PATH',
  'PNPM_HOME',
  'RUNNER_TEMP',
  'SHELL',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
]

const STAGES = {
  'compat-core': {
    workerName: 'xid',
    config: resolve(REPOSITORY_ROOT, 'apps/server/wrangler.jsonc'),
    assets: null,
  },
  console: {
    workerName: 'xid-console',
    config: resolve(REPOSITORY_ROOT, 'apps/console/wrangler.jsonc'),
    assets: resolve(REPOSITORY_ROOT, 'apps/console/dist'),
  },
  site: {
    workerName: 'xid-site',
    config: resolve(REPOSITORY_ROOT, 'apps/site/wrangler.jsonc'),
    assets: resolve(REPOSITORY_ROOT, 'apps/site/dist'),
  },
  'tight-core': {
    workerName: 'xid',
    config: resolve(REPOSITORY_ROOT, 'apps/server/wrangler.jsonc'),
    entry: resolve(REPOSITORY_ROOT, 'apps/server/dist/xid/index.js'),
    assets: resolve(REPOSITORY_ROOT, 'apps/server/dist/client'),
  },
}

export function releaseCommandEnvironment(
  environment = process.env,
  { cloudflare = false, extra = {} } = {},
) {
  const clean = {}
  for (const name of CHILD_ENVIRONMENT_NAMES) {
    if (environment[name]) clean[name] = environment[name]
  }
  if (cloudflare) {
    for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']) {
      if (!environment[name]) throw new TypeError(`${name} is required`)
      clean[name] = environment[name]
    }
  }
  return { ...clean, ...extra }
}

function run(command, args, options = {}) {
  const capture = options.capture === true
  const binary = options.binary === true
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: binary ? null : 'utf8',
    env: releaseCommandEnvironment(process.env, {
      cloudflare: options.cloudflare === true,
      extra: options.env,
    }),
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const stdout = capture ? String(result.stdout ?? '').trim() : ''
    const stderr = capture ? String(result.stderr ?? '').trim() : ''
    const detail = [stdout, stderr].filter(Boolean).join('\n')
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`)
  }
  return capture ? result.stdout : ''
}

function flagValue(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? null : (args[index + 1] ?? null)
}

function requireFlag(args, name) {
  const value = flagValue(args, name)
  if (!value) throw new TypeError(`${name} is required`)
  return value
}

function requireEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new TypeError(`${name} is required`)
  return value
}

function checkedReleaseId(value) {
  if (!RELEASE_ID.test(value)) throw new TypeError('release id has an invalid shape')
  return value
}

function checkedGitSha(value, name) {
  if (!GIT_SHA.test(value)) throw new TypeError(`${name} must be a full lowercase git SHA`)
  run('git', ['cat-file', '-e', `${value}^{commit}`], { capture: true })
  return value
}

function checkedCompatCoreGitSha(value) {
  const gitSha = checkedGitSha(value, 'compat Core git SHA')
  if (gitSha !== ALLOWED_COMPAT_CORE_SHA) {
    throw new TypeError(`compat Core git SHA must equal ${ALLOWED_COMPAT_CORE_SHA}`)
  }
  return gitSha
}

function checkedManifestPath(value) {
  const pathname = resolve(value)
  const relativePath = relative(RELEASE_ROOT, pathname)
  if (relativePath.startsWith('..') || relativePath === '') {
    throw new TypeError('manifest must stay under .xid/releases')
  }
  return pathname
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(pathname) {
  return sha256(readFileSync(pathname))
}

function gitFileSha256(gitSha, pathname) {
  return sha256(
    run('git', ['show', `${gitSha}:${pathname}`], {
      binary: true,
      capture: true,
    }),
  )
}

function loadManifest(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const errors = validateWebReleaseManifest(manifest)
  if (errors.length > 0) throw new TypeError(errors.join('\n'))
  return manifest
}

function writeManifest(manifestPath, manifest) {
  const temporaryPath = `${manifestPath}.next`
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(temporaryPath, manifestPath)
}

async function recordOperation(manifestPath, record, operation) {
  markOperationStarted(record)
  writeManifest(manifestPath, loadManifestObject(manifestPath, record))
  try {
    const value = await operation()
    record.result = 'PASS'
    writeManifest(manifestPath, loadManifestObject(manifestPath, record))
    return value
  } catch (error) {
    record.result = 'FAIL'
    writeManifest(manifestPath, loadManifestObject(manifestPath, record))
    throw error
  }
}

export function markOperationStarted(record) {
  record.result = 'FAIL'
  return record
}

let activeManifest = null

function loadManifestObject(manifestPath, record) {
  if (!activeManifest) throw new Error(`no active manifest for ${manifestPath}`)
  if (!record) throw new Error('manifest record is required')
  return activeManifest
}

function setActiveManifest(manifest) {
  activeManifest = manifest
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}`)
  }
  return response.json()
}

function cloudflareHeaders() {
  return {
    Authorization: `Bearer ${requireEnvironment('CLOUDFLARE_API_TOKEN')}`,
    'Content-Type': 'application/json',
  }
}

function cloudflareResult(response, operation) {
  if (response?.success !== true) {
    const messages = Array.isArray(response?.errors)
      ? response.errors.map((error) => error.message).filter(Boolean)
      : []
    throw new Error(`${operation} failed${messages.length > 0 ? `: ${messages.join('; ')}` : ''}`)
  }
  return response.result
}

function githubHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${requireEnvironment('GITHUB_TOKEN')}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

async function githubJson(pathname, { body, method = 'GET' } = {}) {
  const repository = requireEnvironment('GITHUB_REPOSITORY')
  const url = `https://api.github.com/repos/${repository}${pathname}`
  const response = await fetch(url, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: githubHeaders(),
    method,
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    throw new Error(`${method} ${url} failed with HTTP ${response.status}`)
  }
  return response.json()
}

function checkedWorkflowRunId(value) {
  if (!/^[1-9][0-9]*$/u.test(value ?? '')) {
    throw new TypeError('workflow run id must be a positive integer')
  }
  return String(value)
}

function checkedWorkflowRunAttempt(value) {
  if (!/^[1-9][0-9]*$/u.test(value ?? '')) {
    throw new TypeError('workflow run attempt must be a positive integer')
  }
  return String(value)
}

function checkedRepositoryId(value) {
  if (!/^[1-9][0-9]*$/u.test(value ?? '')) {
    throw new TypeError('repository id must be a positive integer')
  }
  return String(value)
}

function parseDeploymentPayload(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

export function validateReleaseCheckpointPayload(
  payload,
  { releaseGitSha, repositoryId, workflowRunAttempt, workflowRunId },
) {
  if (payload?.schemaVersion !== 1) throw new Error('release checkpoint schema is not 1')
  if (String(payload.workflowRunId ?? '') !== String(workflowRunId)) {
    throw new Error('release checkpoint workflow run id does not match')
  }
  if (String(payload.workflowRunAttempt ?? '') !== String(workflowRunAttempt)) {
    throw new Error('release checkpoint workflow run attempt does not match')
  }
  if (String(payload.repositoryId ?? '') !== String(repositoryId)) {
    throw new Error('release checkpoint repository id does not match')
  }
  if (payload.releaseGitSha !== releaseGitSha) {
    throw new Error('release checkpoint git SHA does not match')
  }
  checkedReleaseId(payload.releaseId)
  checkedCompatCoreGitSha(payload.compatCoreGitSha)
  for (const field of ['releaseLockfileSha256', 'compatCoreLockfileSha256']) {
    if (!SHA256.test(payload[field] ?? '')) {
      throw new Error(`release checkpoint ${field} is invalid`)
    }
  }
  if (!VERSION_ID.test(payload.compatCoreVersionId ?? '')) {
    throw new Error('release checkpoint compatibility Core version is invalid')
  }
  for (const workerName of ['xid', 'xid-console', 'xid-site']) {
    const worker = payload.productionBaseline?.workers?.[workerName]
    activeDeploymentSnapshot({
      deployments: [
        {
          created_on: 'checkpoint',
          id: worker?.deploymentId,
          versions: worker?.versions?.map((version) => ({
            percentage: version.percentage,
            version_id: version.versionId,
          })),
        },
      ],
    })
  }
  if (
    !Array.isArray(payload.productionBaseline?.frontendRoutes) ||
    payload.productionBaseline.frontendRoutes.length !== 0
  ) {
    throw new Error('release checkpoint frontend route baseline must be empty')
  }
  if (!/^[a-f0-9]{32}$/u.test(payload.zoneId ?? '')) {
    throw new Error('release checkpoint zone id is invalid')
  }
  for (const workerId of ['console', 'site']) {
    const patterns = payload.expectedPatterns?.[workerId]
    if (
      !Array.isArray(patterns) ||
      patterns.length === 0 ||
      patterns.some((pattern) => typeof pattern !== 'string' || pattern.length === 0)
    ) {
      throw new Error(`release checkpoint ${workerId} route patterns are invalid`)
    }
  }
  return payload
}

export function checkpointPhaseFromStatus(status) {
  if (!status) return 'PREPARED'
  const phase = status.description
  if (!CHECKPOINT_PHASES.has(phase)) throw new TypeError(`unknown checkpoint phase ${phase}`)
  const expectedState = CHECKPOINT_PHASE_STATES.get(phase)
  if (status.state !== expectedState) {
    throw new Error(
      `release checkpoint phase ${phase} has state ${status.state ?? 'missing'}, expected ${expectedState}`,
    )
  }
  return phase
}

async function createDeploymentStatus(deploymentId, phase) {
  if (!CHECKPOINT_PHASES.has(phase)) throw new TypeError(`unknown checkpoint phase ${phase}`)
  const state = CHECKPOINT_PHASE_STATES.get(phase)
  return githubJson(`/deployments/${deploymentId}/statuses`, {
    body: {
      description: phase,
      environment: GITHUB_DEPLOYMENT_ENVIRONMENT,
      log_url:
        `https://github.com/${requireEnvironment('GITHUB_REPOSITORY')}/actions/runs/` +
        `${checkedWorkflowRunId(requireEnvironment('GITHUB_RUN_ID'))}/attempts/` +
        checkedWorkflowRunAttempt(requireEnvironment('GITHUB_RUN_ATTEMPT')),
      state,
    },
    method: 'POST',
  })
}

async function findReleaseCheckpoint(
  workflowRunId,
  workflowRunAttempt,
  releaseGitSha,
  repositoryId,
) {
  const query = new URLSearchParams({
    environment: GITHUB_DEPLOYMENT_ENVIRONMENT,
    per_page: '100',
    sha: releaseGitSha,
  })
  const deployments = await githubJson(`/deployments?${query.toString()}`)
  if (!Array.isArray(deployments)) {
    throw new Error('GitHub deployments response has an unknown shape')
  }
  const matches = deployments
    .map((deployment) => ({
      deployment,
      payload: parseDeploymentPayload(deployment.payload),
    }))
    .filter(
      ({ payload }) =>
        String(payload?.workflowRunId ?? '') === workflowRunId &&
        String(payload?.workflowRunAttempt ?? '') === workflowRunAttempt &&
        String(payload?.repositoryId ?? '') === repositoryId,
    )
  if (matches.length === 0) return null
  if (matches.length !== 1) {
    throw new Error(`workflow run ${workflowRunId} has ${matches.length} release checkpoints`)
  }
  const match = matches[0]
  const payload = validateReleaseCheckpointPayload(match.payload, {
    releaseGitSha,
    repositoryId,
    workflowRunAttempt,
    workflowRunId,
  })
  const statuses = await githubJson(`/deployments/${match.deployment.id}/statuses?per_page=100`)
  if (!Array.isArray(statuses)) {
    throw new Error('GitHub deployment statuses response has an unknown shape')
  }
  const latestStatus = [...statuses].sort((left, right) =>
    String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')),
  )[0]
  const phase = checkpointPhaseFromStatus(latestStatus)
  return {
    deploymentId: String(match.deployment.id),
    payload,
    phase,
  }
}

async function assertNoUnfinishedReleaseCheckpoint() {
  const query = new URLSearchParams({
    environment: GITHUB_DEPLOYMENT_ENVIRONMENT,
    per_page: '100',
  })
  const deployments = await githubJson(`/deployments?${query.toString()}`)
  if (!Array.isArray(deployments)) {
    throw new Error('GitHub deployments response has an unknown shape')
  }
  const latest = deployments
    .map((deployment) => ({
      deployment,
      payload: parseDeploymentPayload(deployment.payload),
    }))
    .filter(
      ({ deployment, payload }) =>
        deployment.task === 'xid-web-release' && payload?.schemaVersion === 1,
    )
    .sort((left, right) =>
      String(right.deployment.created_at ?? '').localeCompare(
        String(left.deployment.created_at ?? ''),
      ),
    )[0]
  if (!latest) return
  const workflowRunId = checkedWorkflowRunId(String(latest.payload.workflowRunId ?? ''))
  const workflowRunAttempt = checkedWorkflowRunAttempt(
    String(latest.payload.workflowRunAttempt ?? ''),
  )
  const repositoryId = checkedRepositoryId(String(latest.payload.repositoryId ?? ''))
  const releaseGitSha = checkedGitSha(latest.payload.releaseGitSha, 'release git SHA')
  validateReleaseCheckpointPayload(latest.payload, {
    releaseGitSha,
    repositoryId,
    workflowRunAttempt,
    workflowRunId,
  })
  const statuses = await githubJson(`/deployments/${latest.deployment.id}/statuses?per_page=100`)
  if (!Array.isArray(statuses)) {
    throw new Error('GitHub deployment statuses response has an unknown shape')
  }
  const latestStatus = [...statuses].sort((left, right) =>
    String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')),
  )[0]
  const phase = checkpointPhaseFromStatus(latestStatus)
  if (phase !== 'SUCCESS' && phase !== 'ROLLED_BACK') {
    throw new Error(
      `previous web release run ${workflowRunId} attempt ${workflowRunAttempt} is ${phase}`,
    )
  }
}

async function createReleaseCheckpoint(manifestPath, manifest) {
  const workflowRunId = checkedWorkflowRunId(requireEnvironment('GITHUB_RUN_ID'))
  const workflowRunAttempt = checkedWorkflowRunAttempt(requireEnvironment('GITHUB_RUN_ATTEMPT'))
  const repositoryId = checkedRepositoryId(requireEnvironment('GITHUB_REPOSITORY_ID'))
  const existing = await findReleaseCheckpoint(
    workflowRunId,
    workflowRunAttempt,
    manifest.source.releaseGitSha,
    repositoryId,
  )
  if (existing) throw new Error(`workflow run ${workflowRunId} already has a release checkpoint`)
  const compatCoreVersionId = manifest.artifacts['compat-core'].cloudflareVersionId
  if (!VERSION_ID.test(compatCoreVersionId ?? '')) {
    throw new Error('compatibility Core version must exist before the release checkpoint')
  }
  const payload = {
    schemaVersion: 1,
    workflowRunId,
    workflowRunAttempt,
    repositoryId,
    releaseId: manifest.releaseId,
    releaseGitSha: manifest.source.releaseGitSha,
    releaseLockfileSha256: manifest.source.releaseLockfileSha256,
    compatCoreGitSha: manifest.source.compatCoreGitSha,
    compatCoreLockfileSha256: manifest.source.compatCoreLockfileSha256,
    compatCoreVersionId,
    productionBaseline: manifest.productionBaseline,
    zoneId: manifest.routeInventory.zoneId,
    expectedPatterns: manifest.routeInventory.expectedPatterns,
  }
  validateReleaseCheckpointPayload(payload, {
    releaseGitSha: manifest.source.releaseGitSha,
    repositoryId,
    workflowRunAttempt,
    workflowRunId,
  })
  const deployment = await githubJson('/deployments', {
    body: {
      auto_merge: false,
      description: `Coordinated web release ${manifest.releaseId}`,
      environment: GITHUB_DEPLOYMENT_ENVIRONMENT,
      payload,
      production_environment: true,
      ref: manifest.source.releaseGitSha,
      required_contexts: [],
      task: 'xid-web-release',
      transient_environment: false,
    },
    method: 'POST',
  })
  if (!deployment?.id) throw new Error('GitHub release checkpoint has no deployment id')
  manifest.remoteCheckpoint = {
    deploymentId: String(deployment.id),
    phase: 'PREPARED',
    repositoryId,
    workflowRunAttempt,
    workflowRunId,
  }
  writeManifest(manifestPath, manifest)
  await createDeploymentStatus(deployment.id, 'PREPARED')
  return manifest.remoteCheckpoint
}

async function setCheckpointPhase(manifestPath, manifest, phase) {
  const deploymentId = manifest.remoteCheckpoint?.deploymentId
  if (!deploymentId) throw new Error('release manifest has no remote checkpoint')
  await createDeploymentStatus(deploymentId, phase)
  manifest.remoteCheckpoint.phase = phase
  writeManifest(manifestPath, manifest)
}

function stringArray(value) {
  return Array.isArray(value) ? value.map(String) : []
}

export function triggerAffectsMain(trigger) {
  if (trigger?.disabled === true || trigger?.enabled === false) return false
  const excluded = stringArray(trigger?.branch_excludes)
  if (excluded.includes('*') || excluded.includes('main')) return false
  const included = stringArray(trigger?.branch_includes)
  return included.length === 0 || included.includes('*') || included.includes('main')
}

export function isCoreBuildTrigger(trigger) {
  const root = String(trigger?.root_directory ?? '')
    .replaceAll('\\', '/')
    .replace(/^\/+/u, '')
    .replace(/\/+$/u, '')
  return root === 'apps/server'
}

export function isUploadOnlyCoreBuildTrigger(trigger) {
  if (!isCoreBuildTrigger(trigger) || !triggerAffectsMain(trigger)) return true
  const command = String(trigger?.deploy_command ?? '')
  const uploadsVersion = /\bwrangler\s+versions\s+upload\b/u.test(command)
  const promotesVersion = /\bwrangler\s+versions\s+deploy\b/u.test(command)
  const deploysWorker = /\bwrangler\s+deploy\b/u.test(command)
  const mutatesTriggers = /\bwrangler\s+triggers\s+deploy\b/u.test(command)
  const mutatesD1 = /\bwrangler\s+d1\s+migrations\s+apply\b/u.test(command)
  return uploadsVersion && !promotesVersion && !deploysWorker && !mutatesTriggers && !mutatesD1
}

export function assertSafeCoreBuildTriggers(triggers) {
  if (!Array.isArray(triggers)) {
    throw new Error('Cloudflare Builds trigger response has an unknown shape')
  }
  if (triggers.length === 0) throw new Error('Cloudflare Worker xid has no Builds trigger')
  const mainTriggers = triggers.filter(triggerAffectsMain)
  if (mainTriggers.length === 0) {
    throw new Error('Cloudflare Worker xid has no Builds trigger for main')
  }
  const safe = mainTriggers.filter(
    (trigger) => isCoreBuildTrigger(trigger) && isUploadOnlyCoreBuildTrigger(trigger),
  )
  const unsafe = mainTriggers.filter(
    (trigger) => !isCoreBuildTrigger(trigger) || !isUploadOnlyCoreBuildTrigger(trigger),
  )
  if (safe.length === 0) {
    throw new Error('Cloudflare Worker xid has no safe upload-only Builds trigger for main')
  }
  if (unsafe.length > 0) {
    throw new Error(
      'Core Workers Builds main trigger must use wrangler versions upload without promotion, routes, or D1 mutation',
    )
  }
}

export function canRemoveFrontendRoutes(coreRestoreResult) {
  return coreRestoreResult === 'PASS'
}

export function recoveryActionForCheckpointPhase(phase) {
  if (!CHECKPOINT_PHASES.has(phase)) {
    throw new TypeError(`unknown checkpoint phase ${phase}`)
  }
  if (phase === 'PREPARED') return 'SKIP'
  if (phase === 'SUCCESS') return 'VERIFY_RELEASE'
  if (phase === 'ROLLED_BACK') return 'VERIFY_BASELINE'
  return 'ROLLBACK'
}

export function parseWranglerVersionUploadOutput(
  text,
  expectedWorkerName,
  { requirePreview = true } = {},
) {
  const entries = String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const entry = [...entries].reverse().find((value) => value.type === 'version-upload')
  if (!entry) throw new TypeError('Wrangler output has no version-upload entry')
  if (entry.version !== 1) throw new TypeError('Wrangler version-upload output version is not 1')
  if (entry.worker_name !== expectedWorkerName) {
    throw new TypeError(`Wrangler uploaded ${entry.worker_name}, expected ${expectedWorkerName}`)
  }
  if (!VERSION_ID.test(entry.version_id ?? '')) {
    throw new TypeError('Wrangler output has an invalid version_id')
  }
  if (requirePreview) {
    for (const field of ['preview_url', 'preview_alias_url']) {
      const value = entry[field]
      if (typeof value !== 'string' || !value.startsWith('https://')) {
        throw new TypeError(`Wrangler output has no ${field}`)
      }
    }
  } else {
    for (const field of ['preview_url', 'preview_alias_url']) {
      const value = entry[field]
      if (value !== null && value !== undefined && !String(value).startsWith('https://')) {
        throw new TypeError(`Wrangler output has an invalid ${field}`)
      }
    }
  }
  return entry
}

export function verifyTaggedVersion(versions, expectedTag, expectedVersionId) {
  if (!Array.isArray(versions)) throw new TypeError('Wrangler versions list output is not an array')
  const version = versions.find((entry) => entry.id === expectedVersionId)
  if (!version) throw new TypeError(`version ${expectedVersionId} is absent from versions list`)
  if (version.annotations?.['workers/tag'] !== expectedTag) {
    throw new TypeError(`version ${expectedVersionId} does not carry tag ${expectedTag}`)
  }
  return version
}

async function verifyGithubCi(releaseGitSha) {
  const repository = requireEnvironment('GITHUB_REPOSITORY')
  const token = requireEnvironment('GITHUB_TOKEN')
  const query = new URLSearchParams({
    head_sha: releaseGitSha,
    event: 'push',
    status: 'completed',
    per_page: '20',
  })
  const url = `https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs?${query.toString()}`
  const response = await fetchJson(url, {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  })
  const successful = response.workflow_runs?.some(
    (runResult) =>
      runResult.head_sha === releaseGitSha &&
      runResult.head_branch === 'main' &&
      runResult.event === 'push' &&
      runResult.conclusion === 'success',
  )
  if (!successful) throw new Error(`release SHA ${releaseGitSha} has no successful main CI run`)
}

function verifyReleaseCommit(releaseGitSha) {
  const head = String(run('git', ['rev-parse', 'HEAD'], { capture: true })).trim()
  if (head !== releaseGitSha) {
    throw new Error(`checked out HEAD ${head} does not match release SHA ${releaseGitSha}`)
  }
  const originMain = String(run('git', ['rev-parse', 'origin/main'], { capture: true })).trim()
  if (originMain !== releaseGitSha) {
    throw new Error(`origin/main ${originMain} does not match release SHA ${releaseGitSha}`)
  }
}

function verifyCompatCoreCommit(compatCoreGitSha, releaseGitSha) {
  if (compatCoreGitSha !== ALLOWED_COMPAT_CORE_SHA) {
    throw new Error(`compat Core git SHA must equal ${ALLOWED_COMPAT_CORE_SHA}`)
  }
  run('git', ['merge-base', '--is-ancestor', compatCoreGitSha, 'origin/main'])
  run('git', ['merge-base', '--is-ancestor', compatCoreGitSha, releaseGitSha])
}

function verifyMigrationFree(compatCoreGitSha, releaseGitSha) {
  const changed = String(
    run(
      'git',
      ['diff', '--name-only', compatCoreGitSha, releaseGitSha, '--', 'packages/db/drizzle'],
      { capture: true },
    ),
  ).trim()
  if (changed) {
    throw new Error(`web release contains D1 migration changes:\n${changed}`)
  }
}

async function verifyWwwDns() {
  const accountId = requireEnvironment('CLOUDFLARE_ACCOUNT_ID')
  const zonesQuery = new URLSearchParams({ name: 'xid.dev', 'account.id': accountId })
  const zonesResponse = await fetchJson(
    `https://api.cloudflare.com/client/v4/zones?${zonesQuery.toString()}`,
    cloudflareHeaders(),
  )
  const zones = cloudflareResult(zonesResponse, 'Cloudflare zone lookup')
  const zone = Array.isArray(zones) ? zones.find((entry) => entry.name === 'xid.dev') : null
  if (!zone?.id) throw new Error('Cloudflare zone xid.dev was not found')

  const recordsQuery = new URLSearchParams({ name: 'www.xid.dev', per_page: '100' })
  const recordsResponse = await fetchJson(
    `https://api.cloudflare.com/client/v4/zones/${zone.id}/dns_records?${recordsQuery.toString()}`,
    cloudflareHeaders(),
  )
  const records = cloudflareResult(recordsResponse, 'Cloudflare DNS lookup')
  const proxied = Array.isArray(records)
    ? records.some((record) => record.name === 'www.xid.dev' && record.proxied === true)
    : false
  if (!proxied) throw new Error('www.xid.dev does not have a proxied DNS record')
  return zone.id
}

async function verifyWorkersBuilds() {
  const accountId = requireEnvironment('CLOUDFLARE_ACCOUNT_ID')
  const scriptsResponse = await fetchJson(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`,
    cloudflareHeaders(),
  )
  const scripts = cloudflareResult(scriptsResponse, 'Cloudflare Worker scripts lookup')
  const coreScript = Array.isArray(scripts)
    ? scripts.find((script) => script.id === STAGES['compat-core'].workerName)
    : null
  if (!coreScript?.tag) throw new Error('Cloudflare Worker xid has no Builds worker tag')

  const triggersResponse = await fetchJson(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/builds/workers/${encodeURIComponent(coreScript.tag)}/triggers`,
    cloudflareHeaders(),
  )
  const result = cloudflareResult(triggersResponse, 'Cloudflare Builds trigger lookup')
  const triggers = Array.isArray(result)
    ? result
    : Array.isArray(result?.triggers)
      ? result.triggers
      : null
  assertSafeCoreBuildTriggers(triggers)
}

export function hasActiveDeployment(result) {
  try {
    activeDeploymentSnapshot(result)
    return true
  } catch {
    return false
  }
}

export function activeDeploymentSnapshot(result) {
  const deployments = Array.isArray(result)
    ? result
    : Array.isArray(result?.deployments)
      ? result.deployments
      : null
  if (!deployments || deployments.length === 0) {
    throw new Error('Worker has no deployment')
  }
  const latest = [...deployments].sort((left, right) =>
    String(right.created_on ?? '').localeCompare(String(left.created_on ?? '')),
  )[0]
  if (!latest?.id || !Array.isArray(latest.versions) || latest.versions.length === 0) {
    throw new Error('Worker latest deployment has no active versions')
  }
  const versions = latest.versions.map((version) => {
    const versionId = version.version_id ?? version.id
    const percentage = Number(version.percentage)
    if (!VERSION_ID.test(versionId ?? '') || !Number.isFinite(percentage) || percentage <= 0) {
      throw new Error('Worker latest deployment has an invalid version split')
    }
    return { versionId, percentage }
  })
  const total = versions.reduce((sum, version) => sum + version.percentage, 0)
  if (Math.abs(total - 100) > 0.001) {
    throw new Error(`Worker latest deployment percentages total ${total}, expected 100`)
  }
  return {
    deploymentId: String(latest.id),
    versions,
  }
}

async function verifyWorkerDeployments() {
  const accountId = requireEnvironment('CLOUDFLARE_ACCOUNT_ID')
  const snapshots = {}
  for (const workerName of ['xid', 'xid-console', 'xid-site']) {
    const response = await fetchJson(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/deployments`,
      cloudflareHeaders(),
    )
    const result = cloudflareResult(response, `Cloudflare ${workerName} deployment lookup`)
    snapshots[workerName] = activeDeploymentSnapshot(result)
  }
  return snapshots
}

export function assertCleanFrontendRouteBaseline(routes) {
  if (!Array.isArray(routes)) throw new TypeError('routes must be an array')
  const owned = routes.filter(
    (route) => route.script === 'xid-console' || route.script === 'xid-site',
  )
  if (owned.length > 0) {
    throw new Error(
      `frontend Worker routes already exist: ${owned
        .map((route) => `${route.script}:${route.pattern}`)
        .join(', ')}`,
    )
  }
  return []
}

function canonicalDeploymentSnapshot(snapshot) {
  return {
    deploymentId: snapshot.deploymentId,
    versions: [...snapshot.versions].sort((left, right) =>
      left.versionId.localeCompare(right.versionId),
    ),
  }
}

export function deploymentVersionSplitsEqual(left, right) {
  return (
    JSON.stringify(canonicalDeploymentSnapshot(left).versions) ===
    JSON.stringify(canonicalDeploymentSnapshot(right).versions)
  )
}

export function deploymentSnapshotsEqual(left, right) {
  return (
    JSON.stringify(canonicalDeploymentSnapshot(left)) ===
    JSON.stringify(canonicalDeploymentSnapshot(right))
  )
}

async function verifyProductionBaselineUnchanged(manifest) {
  const currentWorkers = await verifyWorkerDeployments()
  for (const workerName of ['xid', 'xid-console', 'xid-site']) {
    const baseline = manifest.productionBaseline?.workers?.[workerName]
    if (!baseline || !deploymentSnapshotsEqual(baseline, currentWorkers[workerName])) {
      throw new Error(`Cloudflare Worker ${workerName} changed after the production baseline`)
    }
  }
  const routes = await listZoneWorkerRoutes(manifest.routeInventory.zoneId)
  assertCleanFrontendRouteBaseline(routes)
}

async function prepareRelease(args) {
  const releaseId = checkedReleaseId(requireFlag(args, '--release-id'))
  const releaseGitSha = checkedGitSha(requireFlag(args, '--release-git-sha'), 'release git SHA')
  const compatCoreGitSha = checkedCompatCoreGitSha(requireFlag(args, '--compat-core-git-sha'))
  if (requireFlag(args, '--confirm') !== EXPECTED_CONFIRMATION) {
    throw new TypeError(`--confirm must equal ${EXPECTED_CONFIRMATION}`)
  }
  const releaseLockfileSha256 = gitFileSha256(releaseGitSha, 'pnpm-lock.yaml')
  const compatCoreLockfileSha256 = gitFileSha256(compatCoreGitSha, 'pnpm-lock.yaml')
  const manifestPath = resolve(RELEASE_ROOT, releaseId, 'manifest.json')

  run(process.execPath, [
    resolve(REPOSITORY_ROOT, 'scripts/web-release-manifest.mjs'),
    'init',
    '--release-id',
    releaseId,
    '--release-git-sha',
    releaseGitSha,
    '--release-lockfile-sha256',
    releaseLockfileSha256,
    '--compat-core-git-sha',
    compatCoreGitSha,
    '--compat-core-lockfile-sha256',
    compatCoreLockfileSha256,
  ])

  const manifest = loadManifest(manifestPath)
  setActiveManifest(manifest)

  await recordOperation(manifestPath, manifest.preflight['main-ci'], async () => {
    verifyReleaseCommit(releaseGitSha)
    verifyCompatCoreCommit(compatCoreGitSha, releaseGitSha)
    await verifyGithubCi(releaseGitSha)
  })
  await recordOperation(manifestPath, manifest.preflight['database-migration-free'], () =>
    verifyMigrationFree(compatCoreGitSha, releaseGitSha),
  )
  await recordOperation(manifestPath, manifest.preflight['worker-routes-contract'], () =>
    run('pnpm', ['run', 'test:web-routes']),
  )

  process.stdout.write(`PASS prepared ${relative(REPOSITORY_ROOT, manifestPath)}\n`)
}

async function verifyCloudflarePreconditions(manifestPath, manifest) {
  const zoneId = await recordOperation(
    manifestPath,
    manifest.preflight['www-dns-proxied'],
    verifyWwwDns,
  )
  manifest.routeInventory.zoneId = zoneId
  writeManifest(manifestPath, manifest)
  const productionBaseline = await recordOperation(
    manifestPath,
    manifest.preflight['worker-deployments-ready'],
    async () => {
      const workers = await verifyWorkerDeployments()
      const routes = await listZoneWorkerRoutes(zoneId)
      const frontendRoutes = assertCleanFrontendRouteBaseline(routes)
      await compatEdgeSmoke()
      await baselineWwwCoreSmoke()
      return { frontendRoutes, workers }
    },
  )
  manifest.productionBaseline = productionBaseline
  writeManifest(manifestPath, manifest)
  await recordOperation(
    manifestPath,
    manifest.preflight['workers-builds-upload-only'],
    verifyWorkersBuilds,
  )
}

function assertReleaseReady(manifest) {
  for (const preflightId of WEB_RELEASE_PREFLIGHT_IDS) {
    if (manifest.preflight[preflightId].result !== 'PASS') {
      throw new Error(`preflight ${preflightId} is not PASS`)
    }
  }
  const head = String(run('git', ['rev-parse', 'HEAD'], { capture: true })).trim()
  if (head !== manifest.source.releaseGitSha) {
    throw new Error(`HEAD ${head} does not match ${manifest.source.releaseGitSha}`)
  }
  const originMain = String(run('git', ['rev-parse', 'origin/main'], { capture: true })).trim()
  if (originMain !== manifest.source.releaseGitSha) {
    throw new Error(`origin/main ${originMain} does not match ${manifest.source.releaseGitSha}`)
  }
  if (!manifest.productionBaseline?.workers?.xid) {
    throw new Error('release manifest has no production Core baseline')
  }
}

function verifyReleaseCommitCurrent(manifest) {
  run('git', ['fetch', '--no-tags', 'origin', 'main'])
  assertReleaseReady(manifest)
}

function createCompatUploadSource(manifestPath, manifest) {
  const releaseDirectory = dirname(manifestPath)
  const inputDirectory = resolve(releaseDirectory, 'compat-input')
  mkdirSync(inputDirectory, { recursive: true })
  return buildArtifact(manifest.source.compatCoreGitSha, inputDirectory).then((result) => {
    if (!SHA256.test(result.artifactSha256)) {
      throw new TypeError('compat Core input artifact has an invalid SHA-256')
    }
    const archive = resolve(REPOSITORY_ROOT, result.artifact)
    const sourceDirectory = resolve(releaseDirectory, 'compat-source')
    if (existsSync(sourceDirectory)) {
      throw new Error(`compat source already exists at ${sourceDirectory}`)
    }
    mkdirSync(sourceDirectory, { recursive: true })
    run('tar', ['-xzf', archive, '-C', sourceDirectory])

    const sourceConfigPath = resolve(sourceDirectory, 'wrangler.jsonc')
    const sourceConfig = parseJsonc(readFileSync(sourceConfigPath, 'utf8'), sourceConfigPath)
    const uploadConfig = createCompatUploadConfig(sourceConfig)
    const uploadConfigPath = resolve(sourceDirectory, 'upload.wrangler.json')
    writeFileSync(uploadConfigPath, `${JSON.stringify(uploadConfig, null, 2)}\n`, { flag: 'wx' })
    return {
      config: uploadConfigPath,
      entry: resolve(sourceDirectory, 'worker-bundle/index.js'),
      assets: resolve(sourceDirectory, 'static-assets'),
      bundleSha256: result.workerBundleSha256,
      moduleGraphSha256: result.workerModuleGraphSha256,
      prebundled: true,
    }
  })
}

export function createCompatUploadConfig(sourceConfig) {
  const d1Databases = Array.isArray(sourceConfig.d1_databases)
    ? sourceConfig.d1_databases.map(({ migrations_dir: _migrationsDirectory, ...database }) => ({
        ...database,
      }))
    : sourceConfig.d1_databases
  return {
    ...sourceConfig,
    main: './worker-bundle/index.js',
    base_dir: './worker-bundle',
    no_bundle: true,
    find_additional_modules: true,
    rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }],
    preview_urls: true,
    assets: {
      ...sourceConfig.assets,
      directory: './static-assets',
    },
    d1_databases: d1Databases,
  }
}

function stageSource(manifestPath, stageId, compatSource) {
  if (stageId === 'compat-core') return compatSource
  return STAGES[stageId]
}

function versionTag(manifest, stageId) {
  const gitSha =
    stageId === 'compat-core' ? manifest.source.compatCoreGitSha : manifest.source.releaseGitSha
  return `${stageId}-${gitSha.slice(0, 12)}-${sha256(manifest.releaseId).slice(0, 8)}`
}

function previewAlias(manifest, stageId) {
  const gitSha =
    stageId === 'compat-core' ? manifest.source.compatCoreGitSha : manifest.source.releaseGitSha
  return `${stageId}-${gitSha.slice(0, 8)}`
}

function displayPath(pathname) {
  const pathFromRoot = relative(REPOSITORY_ROOT, pathname)
  return pathFromRoot.startsWith('..') ? pathname : pathFromRoot
}

function archiveUploadedStage({
  manifestPath,
  manifest,
  stageId,
  source,
  bundleDirectory,
  versionId,
}) {
  const releaseDirectory = dirname(manifestPath)
  const artifactRoot = resolve(releaseDirectory, 'artifacts')
  const staging = resolve(artifactRoot, `${stageId}-uploaded`)
  if (existsSync(staging)) throw new Error(`artifact staging already exists at ${staging}`)
  mkdirSync(staging, { recursive: true })
  cpSync(bundleDirectory, resolve(staging, 'worker-bundle'), { recursive: true })
  cpSync(source.assets, resolve(staging, 'static-assets'), { recursive: true })
  cpSync(source.config, resolve(staging, 'wrangler.jsonc'))
  const metadata = {
    schemaVersion: 1,
    stageId,
    workerName: STAGES[stageId].workerName,
    gitSha: manifest.artifacts[stageId].gitSha,
    lockfileSha256: manifest.artifacts[stageId].lockfileSha256,
    cloudflareVersionId: versionId,
    wranglerVersion: String(
      run('pnpm', ['exec', 'wrangler', '--version'], { capture: true }),
    ).trim(),
    uploadEntry: 'worker-bundle/index.js',
    uploadAssets: 'static-assets',
  }
  writeFileSync(resolve(staging, 'build-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, {
    flag: 'wx',
  })

  const archive = resolve(artifactRoot, `${stageId}-${manifest.artifacts[stageId].gitSha}.tar.gz`)
  if (existsSync(archive)) throw new Error(`artifact already exists at ${archive}`)
  run('tar', ['-czf', archive, '-C', staging, '.'])
  return sha256File(archive)
}

export function verifyBundleIdentity(expectedSha256, bundlePath) {
  if (!SHA256.test(expectedSha256 ?? '')) {
    throw new TypeError('expected bundle SHA-256 is invalid')
  }
  const actualSha256 = sha256File(bundlePath)
  if (actualSha256 !== expectedSha256) {
    throw new Error(`uploaded bundle SHA-256 ${actualSha256} does not match ${expectedSha256}`)
  }
  return actualSha256
}

export function verifyModuleGraphIdentity(expectedSha256, bundleDirectory) {
  if (!SHA256.test(expectedSha256 ?? '')) {
    throw new TypeError('expected module graph SHA-256 is invalid')
  }
  const actualSha256 = workerModuleGraphSha256(bundleDirectory)
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `uploaded module graph SHA-256 ${actualSha256} does not match ${expectedSha256}`,
    )
  }
  return actualSha256
}

async function uploadStage(manifestPath, manifest, stageId, source) {
  const artifact = manifest.artifacts[stageId]
  const releaseDirectory = dirname(manifestPath)
  const outputDirectory = resolve(releaseDirectory, 'wrangler-output')
  const bundleDirectory = resolve(releaseDirectory, 'bundles', stageId)
  mkdirSync(outputDirectory, { recursive: true })
  mkdirSync(dirname(bundleDirectory), { recursive: true })
  if (existsSync(bundleDirectory))
    throw new Error(`bundle output already exists at ${bundleDirectory}`)
  const outputFile = resolve(outputDirectory, `${stageId}.ndjson`)
  if (existsSync(outputFile)) throw new Error(`Wrangler output already exists at ${outputFile}`)
  const tag = versionTag(manifest, stageId)
  const alias = previewAlias(manifest, stageId)
  const args = ['versions', 'upload']
  if (source.entry) args.push(source.entry)
  if (source.prebundled) args.push('--no-bundle')
  args.push(
    '--config',
    source.config,
    '--tag',
    tag,
    '--preview-alias',
    alias,
    '--keep-vars',
    '--env=',
    '--outdir',
    bundleDirectory,
  )
  if (source.assets && !source.entry && stageId === 'tight-core') {
    args.push('--assets', source.assets)
  }
  if (source.assets && source.entry) args.push('--assets', source.assets)
  artifact.upload.command = `WRANGLER_OUTPUT_FILE_PATH=<output> pnpm exec wrangler ${args
    .map((value) => (value.startsWith(REPOSITORY_ROOT) ? displayPath(value) : value))
    .join(' ')}`
  writeManifest(manifestPath, manifest)

  const entry = await recordOperation(manifestPath, artifact.upload, () => {
    run('pnpm', ['exec', 'wrangler', ...args], {
      cloudflare: true,
      env: { WRANGLER_OUTPUT_FILE_PATH: outputFile },
    })
    const parsed = parseWranglerVersionUploadOutput(
      readFileSync(outputFile, 'utf8'),
      STAGES[stageId].workerName,
      { requirePreview: stageId === 'console' || stageId === 'site' },
    )
    const versions = JSON.parse(
      String(
        run(
          'pnpm',
          ['exec', 'wrangler', 'versions', 'list', '--config', source.config, '--json', '--env='],
          { capture: true, cloudflare: true },
        ),
      ),
    )
    verifyTaggedVersion(versions, tag, parsed.version_id)
    if (source.prebundled) {
      verifyBundleIdentity(source.bundleSha256, resolve(bundleDirectory, 'index.js'))
      verifyModuleGraphIdentity(source.moduleGraphSha256, bundleDirectory)
    }
    artifact.cloudflareVersionId = parsed.version_id
    artifact.preview.command = parsed.preview_alias_url
      ? `HTTP preview smoke ${parsed.preview_alias_url}`
      : `bundle and static asset gate ${displayPath(bundleDirectory)}`
    writeManifest(manifestPath, manifest)
    return parsed
  })

  artifact.artifactSha256 = archiveUploadedStage({
    manifestPath,
    manifest,
    stageId,
    source,
    bundleDirectory,
    versionId: entry.version_id,
  })
  writeManifest(manifestPath, manifest)
  return {
    bundleDirectory,
    previewUrl: entry.preview_alias_url ?? entry.preview_url ?? null,
  }
}

async function responseWithRetry(url, init = {}) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  })
}

function responseHeader(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name)
  const entry = Object.entries(headers ?? {}).find(
    ([headerName]) => headerName.toLowerCase() === name.toLowerCase(),
  )
  return entry ? String(entry[1]) : null
}

export function validateHttpSnapshot(snapshot, options = {}) {
  const statuses = options.statuses ?? [200]
  if (!statuses.includes(snapshot.status)) {
    throw new Error(`${snapshot.url} returned HTTP ${snapshot.status}`)
  }
  const owner = responseHeader(snapshot.headers, 'x-xid-route-owner')
  if (options.owner && owner !== options.owner) {
    throw new Error(
      `${snapshot.url} route owner is ${owner ?? 'missing'}, expected ${options.owner}`,
    )
  }
  if (options.forbidOwners?.includes(owner)) {
    throw new Error(`${snapshot.url} reached forbidden route owner ${owner}`)
  }
  const contentType = responseHeader(snapshot.headers, 'content-type') ?? ''
  if (
    options.contentType &&
    !contentType.toLowerCase().startsWith(options.contentType.toLowerCase())
  ) {
    throw new Error(
      `${snapshot.url} content-type is ${contentType}, expected ${options.contentType}`,
    )
  }
  if (
    options.exactContentType &&
    contentType.toLowerCase() !== options.exactContentType.toLowerCase()
  ) {
    throw new Error(
      `${snapshot.url} content-type is ${contentType}, expected exactly ${options.exactContentType}`,
    )
  }
  if (options.exactLocation) {
    const location = responseHeader(snapshot.headers, 'location')
    const resolved = location ? new URL(location, snapshot.url).href : null
    if (resolved !== options.exactLocation) {
      throw new Error(
        `${snapshot.url} location is ${resolved ?? 'missing'}, expected ${options.exactLocation}`,
      )
    }
  }
  if (options.exactBody !== undefined && snapshot.body !== options.exactBody) {
    throw new Error(`${snapshot.url} body does not exactly match ${options.exactBody}`)
  }
  const bodyIncludes = Array.isArray(options.bodyIncludes)
    ? options.bodyIncludes
    : options.bodyIncludes
      ? [options.bodyIncludes]
      : []
  for (const expected of bodyIncludes) {
    if (!snapshot.body.includes(expected)) {
      throw new Error(`${snapshot.url} body does not include ${expected}`)
    }
  }
}

async function expectHttp(baseUrl, pathname, options = {}) {
  const url = new URL(pathname, baseUrl)
  let lastError = null
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      const response = await responseWithRetry(url, {
        headers: {
          Accept: options.accept ?? '*/*',
        },
        redirect: options.redirect ?? 'follow',
      })
      const body = await response.text()
      validateHttpSnapshot(
        {
          body,
          headers: response.headers,
          status: response.status,
          url: url.href,
        },
        options,
      )
      return
    } catch (error) {
      lastError = error
      if (attempt < 12) await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000))
    }
  }
  throw lastError
}

async function coreHttpSmoke(baseUrl, forbidOwners = []) {
  await expectHttp(baseUrl, '/v1/health', {
    contentType: 'application/json',
    exactBody: '{"ok":true}',
    forbidOwners,
  })
  await expectHttp(baseUrl, '/.well-known/openid-configuration', {
    bodyIncludes: ['"issuer":"https://xid.dev"', '"jwks_uri"'],
    contentType: 'application/json',
    forbidOwners,
  })
  await expectHttp(baseUrl, '/jwks', {
    bodyIncludes: '"keys"',
    contentType: 'application/json',
    forbidOwners,
  })
  await expectHttp(baseUrl, '/scim/v2/ServiceProviderConfig', {
    bodyIncludes: 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
    exactContentType: 'application/scim+json',
    forbidOwners,
    statuses: [200],
  })
}

function coreBundleStaticGate(source, bundleDirectory) {
  for (const pathname of [
    resolve(bundleDirectory, 'index.js'),
    resolve(source.assets, 'index.html'),
  ]) {
    if (!existsSync(pathname) || statSync(pathname).size === 0) {
      throw new Error(`Core preview fallback artifact is missing ${displayPath(pathname)}`)
    }
  }
}

async function consoleHttpSmoke(baseUrl, owner = 'console') {
  for (const pathname of ['/console', '/console/organizations']) {
    await expectHttp(baseUrl, pathname, {
      accept: 'text/html',
      bodyIncludes: '<div id="root">',
      contentType: 'text/html',
      owner,
    })
  }
}

async function siteHttpSmoke(baseUrl, owner = 'site') {
  await expectHttp(baseUrl, '/', {
    accept: 'text/html',
    bodyIncludes: 'XID developer documentation',
    contentType: 'text/html',
    owner,
  })
  await expectHttp(baseUrl, '/getting-started', {
    accept: 'text/html',
    bodyIncludes: 'Getting started',
    contentType: 'text/html',
    owner,
  })
  await expectHttp(baseUrl, '/getting-started/index.md', {
    bodyIncludes: 'Source: https://xid.dev/getting-started/index.mdx',
    exactContentType: 'text/markdown; charset=utf-8',
    owner,
  })
  await expectHttp(baseUrl, '/getting-started/index.mdx', {
    bodyIncludes: 'title: "Getting started"',
    exactContentType: 'text/markdown; charset=utf-8',
    owner,
  })
  await expectHttp(baseUrl, '/llms.txt', {
    bodyIncludes: ['## Sections', '41 published pages'],
    exactContentType: 'text/plain; charset=utf-8',
    owner,
  })
  await expectHttp(baseUrl, '/llms-full.txt', {
    bodyIncludes: ['Published pages: 328', 'Source: https://xid.dev/getting-started/index.mdx'],
    exactContentType: 'text/plain; charset=utf-8',
    owner,
  })
}

async function previewSmoke(stageId, preview, source) {
  if (stageId === 'compat-core' || stageId === 'tight-core') {
    if (preview.previewUrl) {
      try {
        await coreHttpSmoke(preview.previewUrl)
        return
      } catch {
        coreBundleStaticGate(source, preview.bundleDirectory)
        return
      }
    }
    coreBundleStaticGate(source, preview.bundleDirectory)
    return
  }
  if (stageId === 'console') {
    await consoleHttpSmoke(preview.previewUrl)
    return
  }
  await siteHttpSmoke(preview.previewUrl)
}

async function coreEdgeSmoke() {
  await coreHttpSmoke('https://xid.dev', ['console', 'site'])
}

async function compatEdgeSmoke() {
  await coreEdgeSmoke()
  for (const pathname of ['/', '/console']) {
    await expectHttp('https://xid.dev', pathname, {
      accept: 'text/html',
      bodyIncludes: '<div id="root">',
      contentType: 'text/html',
      forbidOwners: ['console', 'site'],
    })
  }
}

async function baselineWwwCoreSmoke() {
  await expectHttp('https://www.xid.dev', '/getting-started?release-smoke=1', {
    accept: 'text/html',
    bodyIncludes: '<div id="root">',
    contentType: 'text/html',
    forbidOwners: ['console', 'site'],
  })
}

async function consoleEdgeSmoke() {
  await coreEdgeSmoke()
  await consoleHttpSmoke('https://xid.dev')
}

async function fullEdgeSmoke() {
  await consoleEdgeSmoke()
  await siteHttpSmoke('https://xid.dev')
  await expectHttp('https://xid.dev', '/docs/getting-started', {
    exactLocation: 'https://xid.dev/getting-started',
    owner: 'site',
    redirect: 'manual',
    statuses: [308],
  })
  await expectHttp('https://www.xid.dev', '/getting-started?release-smoke=1', {
    exactLocation: 'https://xid.dev/getting-started?release-smoke=1',
    owner: 'site',
    redirect: 'manual',
    statuses: [308],
  })
}

async function consoleRemovedRollbackSmoke() {
  await coreEdgeSmoke()
  await expectHttp('https://xid.dev', '/console', {
    accept: 'text/html',
    bodyIncludes: '<div id="root">',
    contentType: 'text/html',
    forbidOwners: ['console', 'site'],
  })
}

async function sitePublicRemovedRollbackSmoke(expectSiteWww) {
  await consoleRemovedRollbackSmoke()
  await expectHttp('https://xid.dev', '/', {
    accept: 'text/html',
    bodyIncludes: '<div id="root">',
    contentType: 'text/html',
    forbidOwners: ['console', 'site'],
  })
  if (expectSiteWww) {
    await expectHttp('https://www.xid.dev', '/getting-started?release-smoke=1', {
      exactLocation: 'https://xid.dev/getting-started?release-smoke=1',
      owner: 'site',
      redirect: 'manual',
      statuses: [308],
    })
  } else {
    await baselineWwwCoreSmoke()
  }
}

async function completeRollbackSmoke() {
  await compatEdgeSmoke()
  await baselineWwwCoreSmoke()
}

async function deployStage(manifestPath, manifest, stageId, edgeSmoke) {
  const artifact = manifest.artifacts[stageId]
  const versionId = artifact.cloudflareVersionId
  if (!VERSION_ID.test(versionId ?? '')) throw new Error(`${stageId} has no version ID`)
  const config = STAGES[stageId].config
  artifact.deploy.command = `pnpm exec wrangler versions deploy ${versionId}@100% --config ${displayPath(config)} --yes --env=`
  writeManifest(manifestPath, manifest)
  await recordOperation(manifestPath, artifact.deploy, async () => {
    run(
      'pnpm',
      [
        'exec',
        'wrangler',
        'versions',
        'deploy',
        `${versionId}@100%`,
        '--config',
        config,
        '--yes',
        '--env=',
      ],
      { cloudflare: true },
    )
    if (edgeSmoke) await edgeSmoke()
  })
}

async function activateRoutes(manifestPath, manifest, stageId, edgeSmoke) {
  const artifact = manifest.artifacts[stageId]
  const change = manifest.routeChanges[`${stageId}-activate`]
  const config = STAGES[stageId].config
  const command = `pnpm exec wrangler triggers deploy --config ${displayPath(config)} --env=`
  artifact.route.command = command
  change.command = command
  markOperationStarted(artifact.route)
  markOperationStarted(change)
  writeManifest(manifestPath, manifest)
  try {
    run('pnpm', ['exec', 'wrangler', 'triggers', 'deploy', '--config', config, '--env='], {
      cloudflare: true,
    })
    await edgeSmoke()
    artifact.route.result = 'PASS'
    change.result = 'PASS'
    writeManifest(manifestPath, manifest)
  } catch (error) {
    writeManifest(manifestPath, manifest)
    throw error
  }
}

function markSuccessfulReleaseRollbacksSkipped(manifest) {
  for (const stageId of WEB_RELEASE_STAGE_IDS) {
    if (manifest.artifacts[stageId].rollback.result === 'UNKNOWN') {
      manifest.artifacts[stageId].rollback.result = 'SKIP'
    }
  }
  for (const changeId of WEB_ROUTE_CHANGE_IDS) {
    if (changeId.endsWith('-remove') || changeId.startsWith('site-remove-')) {
      if (manifest.routeChanges[changeId].result === 'UNKNOWN') {
        manifest.routeChanges[changeId].result = 'SKIP'
      }
    }
  }
}

async function release(args) {
  const manifestPath = checkedManifestPath(requireFlag(args, '--manifest'))
  requireEnvironment('CLOUDFLARE_API_TOKEN')
  requireEnvironment('CLOUDFLARE_ACCOUNT_ID')
  requireEnvironment('GITHUB_TOKEN')
  const manifest = loadManifest(manifestPath)
  setActiveManifest(manifest)
  await assertNoUnfinishedReleaseCheckpoint()
  await verifyCloudflarePreconditions(manifestPath, manifest)
  assertReleaseReady(manifest)

  run('pnpm', ['build'])
  const generatedCompatSource = await createCompatUploadSource(manifestPath, manifest)

  const compatSource = stageSource(manifestPath, 'compat-core', generatedCompatSource)
  const compatPreview = await uploadStage(manifestPath, manifest, 'compat-core', compatSource)
  await recordOperation(manifestPath, manifest.artifacts['compat-core'].preview, () =>
    previewSmoke('compat-core', compatPreview, compatSource),
  )
  verifyReleaseCommitCurrent(manifest)
  await verifyProductionBaselineUnchanged(manifest)
  await createReleaseCheckpoint(manifestPath, manifest)
  await setCheckpointPhase(manifestPath, manifest, 'COMPAT_INTENT')
  await deployStage(manifestPath, manifest, 'compat-core', compatEdgeSmoke)
  await setCheckpointPhase(manifestPath, manifest, 'COMPAT_VERIFIED')

  const consoleSource = stageSource(manifestPath, 'console', compatSource)
  const consolePreview = await uploadStage(manifestPath, manifest, 'console', consoleSource)
  await recordOperation(manifestPath, manifest.artifacts.console.preview, () =>
    previewSmoke('console', consolePreview, consoleSource),
  )
  await deployStage(manifestPath, manifest, 'console')

  const siteSource = stageSource(manifestPath, 'site', compatSource)
  const sitePreview = await uploadStage(manifestPath, manifest, 'site', siteSource)
  await recordOperation(manifestPath, manifest.artifacts.site.preview, () =>
    previewSmoke('site', sitePreview, siteSource),
  )
  await deployStage(manifestPath, manifest, 'site')

  await setCheckpointPhase(manifestPath, manifest, 'CONSOLE_ROUTES_INTENT')
  await activateRoutes(manifestPath, manifest, 'console', consoleEdgeSmoke)
  await setCheckpointPhase(manifestPath, manifest, 'SITE_ROUTES_INTENT')
  await activateRoutes(manifestPath, manifest, 'site', fullEdgeSmoke)

  const tightCoreSource = stageSource(manifestPath, 'tight-core', compatSource)
  const tightCorePreview = await uploadStage(manifestPath, manifest, 'tight-core', tightCoreSource)
  await recordOperation(manifestPath, manifest.artifacts['tight-core'].preview, () =>
    previewSmoke('tight-core', tightCorePreview, tightCoreSource),
  )
  await setCheckpointPhase(manifestPath, manifest, 'TIGHT_INTENT')
  await deployStage(manifestPath, manifest, 'tight-core', fullEdgeSmoke)

  markSuccessfulReleaseRollbacksSkipped(manifest)
  writeManifest(manifestPath, manifest)
  const successfulManifest = structuredClone(manifest)
  successfulManifest.remoteCheckpoint.phase = 'SUCCESS'
  const errors = validateWebReleaseManifest(successfulManifest, {
    requireSuccessfulRelease: true,
  })
  if (errors.length > 0) throw new TypeError(errors.join('\n'))
  await setCheckpointPhase(manifestPath, manifest, 'SUCCESS')
  process.stdout.write(`PASS released ${manifest.releaseId}\n`)
}

async function listZoneWorkerRoutes(zoneId) {
  const response = await fetchJson(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/workers/routes`,
    cloudflareHeaders(),
  )
  const routes = cloudflareResult(response, 'Cloudflare Zone Workers Routes lookup')
  if (!Array.isArray(routes)) {
    throw new Error('Cloudflare Zone Workers Routes response has an unknown shape')
  }
  return routes
}

async function deleteZoneWorkerRoute(zoneId, routeId) {
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/workers/routes/${routeId}`
  const response = await fetch(url, {
    headers: cloudflareHeaders(),
    method: 'DELETE',
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`DELETE ${url} failed with HTTP ${response.status}`)
  const result = cloudflareResult(await response.json(), `Cloudflare route ${routeId} deletion`)
  if (result?.id !== routeId) {
    throw new Error(
      `Cloudflare route deletion returned ${result?.id ?? 'no id'}, expected ${routeId}`,
    )
  }
}

async function createZoneWorkerRoute(zoneId, route) {
  if (!route?.pattern || !route?.script) {
    throw new TypeError('Cloudflare Worker route restore requires pattern and script')
  }
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/workers/routes`
  const response = await fetch(url, {
    body: JSON.stringify({ pattern: route.pattern, script: route.script }),
    headers: cloudflareHeaders(),
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    throw new Error(`POST ${url} failed with HTTP ${response.status}`)
  }
  const result = cloudflareResult(
    await response.json(),
    `Cloudflare Zone Workers Route restore ${route.pattern}`,
  )
  if (result?.pattern !== route.pattern || result?.script !== route.script || !result?.id) {
    throw new Error(`Cloudflare restored route ${route.pattern} has an unknown response shape`)
  }
}

async function restoreZoneWorkerRoutes(zoneId, routes) {
  if (routes.length === 0) return
  const before = await listZoneWorkerRoutes(zoneId)
  for (const route of routes) {
    const existing = before.find((entry) => entry.pattern === route.pattern)
    if (existing && existing.script !== route.script) {
      throw new Error(
        `cannot restore ${route.pattern}; it is now owned by ${existing.script ?? 'no script'}`,
      )
    }
    if (!existing) await createZoneWorkerRoute(zoneId, route)
  }
  const after = await listZoneWorkerRoutes(zoneId)
  for (const route of routes) {
    if (!after.some((entry) => entry.pattern === route.pattern && entry.script === route.script)) {
      throw new Error(`Cloudflare route ${route.pattern} was not restored`)
    }
  }
}

export function selectRollbackRoutes(routes, { expectedPatterns, mode, workerName }) {
  if (!Array.isArray(routes)) throw new TypeError('routes must be an array')
  if (!Array.isArray(expectedPatterns) || expectedPatterns.length === 0) {
    throw new TypeError('expectedPatterns must be a non-empty array')
  }
  const expected = new Set(expectedPatterns)
  const owned = routes.filter((route) => route.script === workerName)
  const unexpected = owned.filter((route) => !expected.has(route.pattern))
  if (unexpected.length > 0) {
    throw new Error(
      `${workerName} owns unexpected route patterns: ${unexpected
        .map((route) => route.pattern)
        .join(', ')}`,
    )
  }
  return owned.filter((route) => {
    if (!route.id || !route.pattern) throw new Error(`${workerName} route has no id or pattern`)
    const isWww = route.pattern.startsWith('www.xid.dev/')
    return mode === 'all' || (mode === 'www' ? isWww : !isWww)
  })
}

async function rollbackRoute({
  edgeSmoke,
  manifestPath,
  manifest,
  changeId,
  expectedPatterns,
  mode,
  workerName,
}) {
  const record = manifest.routeChanges[changeId]
  markOperationStarted(record)
  writeManifest(manifestPath, manifest)
  let targets = []
  try {
    const zoneId = manifest.routeInventory.zoneId
    if (!zoneId) throw new Error('release manifest has no Cloudflare zone id')
    const before = await listZoneWorkerRoutes(zoneId)
    targets = selectRollbackRoutes(before, { expectedPatterns, mode, workerName })
    for (const route of targets) {
      await deleteZoneWorkerRoute(zoneId, route.id)
    }
    const after = await listZoneWorkerRoutes(zoneId)
    const remaining = selectRollbackRoutes(after, { expectedPatterns, mode, workerName })
    if (remaining.length > 0) {
      throw new Error(`${workerName} rollback routes remain after deletion`)
    }
    await edgeSmoke({ after, targets })
    record.result = 'PASS'
  } catch (error) {
    let restoreError = null
    try {
      const zoneId = manifest.routeInventory.zoneId
      if (zoneId) await restoreZoneWorkerRoutes(zoneId, targets)
    } catch (caught) {
      restoreError = caught
    }
    writeManifest(manifestPath, manifest)
    if (restoreError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nroute restore failed: ${
          restoreError instanceof Error ? restoreError.message : String(restoreError)
        }`,
      )
    }
    throw error
  }
  writeManifest(manifestPath, manifest)
}

async function rollback(args) {
  const manifestPath = checkedManifestPath(requireFlag(args, '--manifest'))
  requireEnvironment('CLOUDFLARE_API_TOKEN')
  requireEnvironment('CLOUDFLARE_ACCOUNT_ID')
  requireEnvironment('GITHUB_TOKEN')
  const manifest = loadManifest(manifestPath)
  setActiveManifest(manifest)
  const localCheckpoint = manifest.remoteCheckpoint
  if (
    !localCheckpoint?.workflowRunId ||
    !localCheckpoint?.workflowRunAttempt ||
    !localCheckpoint?.repositoryId
  ) {
    throw new Error('release manifest has no remote checkpoint identity')
  }
  const checkpoint = await findReleaseCheckpoint(
    checkedWorkflowRunId(localCheckpoint.workflowRunId),
    checkedWorkflowRunAttempt(localCheckpoint.workflowRunAttempt),
    manifest.source.releaseGitSha,
    checkedRepositoryId(localCheckpoint.repositoryId),
  )
  if (!checkpoint || checkpoint.deploymentId !== localCheckpoint.deploymentId) {
    throw new Error('release manifest remote checkpoint does not match GitHub')
  }
  manifest.remoteCheckpoint.phase = checkpoint.phase
  writeManifest(manifestPath, manifest)
  const checkpointPhase = checkpoint.phase
  const recoveryAction = recoveryActionForCheckpointPhase(checkpointPhase)
  if (recoveryAction === 'VERIFY_RELEASE') {
    await fullEdgeSmoke()
    process.stdout.write('SKIP rollback because the release checkpoint is SUCCESS\n')
    return
  }
  if (recoveryAction === 'VERIFY_BASELINE') {
    await completeRollbackSmoke()
    process.stdout.write(`PASS rollback already complete for ${manifest.releaseId}\n`)
    return
  }
  if (recoveryAction === 'SKIP') {
    for (const stageId of WEB_RELEASE_STAGE_IDS) {
      if (manifest.artifacts[stageId].rollback.result === 'UNKNOWN') {
        manifest.artifacts[stageId].rollback.result = 'SKIP'
      }
    }
    for (const changeId of WEB_ROUTE_CHANGE_IDS) {
      if (manifest.routeChanges[changeId].result === 'UNKNOWN') {
        manifest.routeChanges[changeId].result = 'SKIP'
      }
    }
    writeManifest(manifestPath, manifest)
    await setCheckpointPhase(manifestPath, manifest, 'ROLLED_BACK')
    process.stdout.write('SKIP rollback because the checkpoint has no production intent\n')
    return
  }

  const baseline = manifest.productionBaseline?.workers?.xid
  if (!baseline?.deploymentId || !Array.isArray(baseline.versions)) {
    throw new Error('release manifest has no production Core deployment baseline')
  }
  const baselineTargets = baseline.versions.map((version) => {
    if (
      !VERSION_ID.test(version.versionId ?? '') ||
      !Number.isFinite(version.percentage) ||
      version.percentage <= 0
    ) {
      throw new Error('production Core deployment baseline has an invalid version split')
    }
    return `${version.versionId}@${version.percentage}%`
  })
  await setCheckpointPhase(manifestPath, manifest, 'ROLLBACK_INTENT')

  const tightRollback = manifest.artifacts['tight-core'].rollback
  tightRollback.command =
    `pnpm exec wrangler versions deploy ${baselineTargets.join(' ')} ` +
    '--config apps/server/wrangler.jsonc --yes --env='
  markOperationStarted(tightRollback)
  writeManifest(manifestPath, manifest)
  try {
    run(
      'pnpm',
      [
        'exec',
        'wrangler',
        'versions',
        'deploy',
        ...baselineTargets,
        '--config',
        STAGES['compat-core'].config,
        '--yes',
        '--env=',
      ],
      { cloudflare: true },
    )
    const restoredWorkers = await verifyWorkerDeployments()
    if (!deploymentVersionSplitsEqual(baseline, restoredWorkers.xid)) {
      throw new Error(
        'production Core deployment does not match the recorded baseline after restore',
      )
    }
    await coreEdgeSmoke()
    const routes = await listZoneWorkerRoutes(manifest.routeInventory.zoneId)
    const frontendRoutes = routes.filter(
      (route) => route.script === 'xid-console' || route.script === 'xid-site',
    )
    if (frontendRoutes.length === 0) await completeRollbackSmoke()
    tightRollback.result = 'PASS'
  } catch (error) {
    for (const changeId of ['console-remove', 'site-remove-public', 'site-remove-www']) {
      if (manifest.routeChanges[changeId].result === 'UNKNOWN') {
        manifest.routeChanges[changeId].result = 'SKIP'
      }
    }
    writeManifest(manifestPath, manifest)
    throw new Error(
      `production Core baseline restore failed; frontend routes were preserved\n${error.message}`,
    )
  }
  for (const stageId of ['compat-core', 'console', 'site']) {
    if (manifest.artifacts[stageId].rollback.result === 'UNKNOWN') {
      manifest.artifacts[stageId].rollback.result = 'SKIP'
    }
  }
  writeManifest(manifestPath, manifest)

  await rollbackRoute({
    edgeSmoke: consoleRemovedRollbackSmoke,
    manifestPath,
    manifest,
    changeId: 'console-remove',
    expectedPatterns: manifest.routeInventory.expectedPatterns.console,
    mode: 'all',
    workerName: 'xid-console',
  })
  await rollbackRoute({
    edgeSmoke: ({ after }) =>
      sitePublicRemovedRollbackSmoke(
        after.some(
          (route) => route.script === 'xid-site' && route.pattern.startsWith('www.xid.dev/'),
        ),
      ),
    manifestPath,
    manifest,
    changeId: 'site-remove-public',
    expectedPatterns: manifest.routeInventory.expectedPatterns.site,
    mode: 'non-www',
    workerName: 'xid-site',
  })
  await rollbackRoute({
    edgeSmoke: completeRollbackSmoke,
    manifestPath,
    manifest,
    changeId: 'site-remove-www',
    expectedPatterns: manifest.routeInventory.expectedPatterns.site,
    mode: 'www',
    workerName: 'xid-site',
  })
  await setCheckpointPhase(manifestPath, manifest, 'ROLLED_BACK')
  process.stdout.write(`PASS rolled back ${manifest.releaseId}\n`)
}

function verifyRecoveryCommit(releaseGitSha) {
  const head = String(run('git', ['rev-parse', 'HEAD'], { capture: true })).trim()
  const originMain = String(run('git', ['rev-parse', 'origin/main'], { capture: true })).trim()
  if (head !== originMain) {
    throw new Error(`recovery HEAD ${head} does not match trusted origin/main ${originMain}`)
  }
  run('git', ['merge-base', '--is-ancestor', releaseGitSha, head])
}

async function recoverRollback(args) {
  const workflowRunId = checkedWorkflowRunId(requireFlag(args, '--workflow-run-id'))
  const workflowRunAttempt = checkedWorkflowRunAttempt(requireFlag(args, '--workflow-run-attempt'))
  const releaseGitSha = checkedGitSha(requireFlag(args, '--release-git-sha'), 'release git SHA')
  const repositoryId = checkedRepositoryId(requireEnvironment('GITHUB_REPOSITORY_ID'))
  requireEnvironment('GITHUB_TOKEN')
  requireEnvironment('CLOUDFLARE_API_TOKEN')
  requireEnvironment('CLOUDFLARE_ACCOUNT_ID')
  verifyRecoveryCommit(releaseGitSha)

  const checkpoint = await findReleaseCheckpoint(
    workflowRunId,
    workflowRunAttempt,
    releaseGitSha,
    repositoryId,
  )
  if (!checkpoint) {
    const recoveryDirectory = resolve(
      RELEASE_ROOT,
      `recovery-${workflowRunId}-${workflowRunAttempt}`,
    )
    mkdirSync(recoveryDirectory, { recursive: true })
    writeFileSync(
      resolve(recoveryDirectory, 'recovery.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          workflowRunId,
          workflowRunAttempt,
          releaseGitSha,
          result: 'SKIP',
          reason: 'NO_REMOTE_CHECKPOINT',
        },
        null,
        2,
      )}\n`,
      { flag: 'wx' },
    )
    process.stdout.write('SKIP rollback because no remote release checkpoint exists\n')
    return
  }

  const payload = checkpoint.payload
  const releaseId = checkedReleaseId(payload.releaseId)
  const manifestPath = resolve(RELEASE_ROOT, releaseId, 'manifest.json')
  run(process.execPath, [
    resolve(REPOSITORY_ROOT, 'scripts/web-release-manifest.mjs'),
    'init',
    '--release-id',
    releaseId,
    '--release-git-sha',
    releaseGitSha,
    '--release-lockfile-sha256',
    payload.releaseLockfileSha256,
    '--compat-core-git-sha',
    payload.compatCoreGitSha,
    '--compat-core-lockfile-sha256',
    payload.compatCoreLockfileSha256,
  ])

  const manifest = loadManifest(manifestPath)
  setActiveManifest(manifest)
  manifest.productionBaseline = payload.productionBaseline
  manifest.routeInventory.zoneId = payload.zoneId
  manifest.routeInventory.expectedPatterns = payload.expectedPatterns
  manifest.remoteCheckpoint = {
    deploymentId: checkpoint.deploymentId,
    phase: checkpoint.phase,
    repositoryId,
    workflowRunAttempt,
    workflowRunId,
  }
  manifest.artifacts['compat-core'].cloudflareVersionId = payload.compatCoreVersionId
  writeManifest(manifestPath, manifest)
  return rollback(['--manifest', manifestPath])
}

async function runCli() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'prepare') return prepareRelease(args)
  if (command === 'release') return release(args)
  if (command === 'rollback') return rollback(args)
  if (command === 'recover-rollback') return recoverRollback(args)
  throw new TypeError(
    'usage: run-web-release.mjs prepare --release-id <id> --release-git-sha <sha> ' +
      '--compat-core-git-sha <sha> --confirm DEPLOY_XID_WEB | ' +
      'release --manifest <path> | rollback --manifest <path> | ' +
      'recover-rollback --workflow-run-id <id> --workflow-run-attempt <attempt> ' +
      '--release-git-sha <sha>',
  )
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await runCli()
  } catch (error) {
    process.stderr.write(`FAIL ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
