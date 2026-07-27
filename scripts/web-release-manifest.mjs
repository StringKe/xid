import { readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseJsonc } from './verify-worker-routes.mjs'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..')
const RELEASE_ROOT = resolve(REPOSITORY_ROOT, '.xid', 'releases')
const GIT_SHA = /^[a-f0-9]{40}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const VERSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const RELEASE_ID = /^[a-z0-9][a-z0-9-]{2,63}$/u
const RESULT_VALUES = new Set(['PASS', 'FAIL', 'SKIP', 'UNKNOWN'])
const CHECKPOINT_PHASES = new Set([
  'PREPARED',
  'COMPAT_INTENT',
  'COMPAT_VERIFIED',
  'CONSOLE_ROUTES_INTENT',
  'SITE_ROUTES_INTENT',
  'TIGHT_INTENT',
  'SUCCESS',
  'ROLLBACK_INTENT',
  'ROLLED_BACK',
])

export const WEB_RELEASE_STAGE_IDS = ['compat-core', 'console', 'site', 'tight-core']

export const WEB_RELEASE_PREFLIGHT_IDS = [
  'main-ci',
  'database-migration-free',
  'www-dns-proxied',
  'worker-deployments-ready',
  'workers-builds-upload-only',
  'worker-routes-contract',
]

export const WEB_ROUTE_CHANGE_IDS = [
  'console-activate',
  'site-activate',
  'console-remove',
  'site-remove-public',
  'site-remove-www',
]

const WORKERS = {
  'compat-core': { name: 'xid', config: 'apps/server/wrangler.jsonc' },
  console: { name: 'xid-console', config: 'apps/console/wrangler.jsonc' },
  site: { name: 'xid-site', config: 'apps/site/wrangler.jsonc' },
  'tight-core': { name: 'xid', config: 'apps/server/wrangler.jsonc' },
}

function commandResult(command, result = 'UNKNOWN') {
  return { command, result }
}

function versionUploadCommand(stageId, gitSha) {
  const worker = WORKERS[stageId]
  const tag = `${stageId}-${gitSha.slice(0, 12)}`
  return `pnpm exec wrangler versions upload --config ${worker.config} --tag ${tag}`
}

function versionDeployCommand(stageId) {
  const worker = WORKERS[stageId]
  return `pnpm exec wrangler versions deploy <${stageId}-version-id>@100% --config ${worker.config} --yes`
}

function rollbackCommand(stageId) {
  const worker = WORKERS[stageId]
  const target =
    stageId === 'tight-core'
      ? 'compat-core'
      : stageId === 'compat-core'
        ? 'previous-core'
        : `previous-${stageId}`
  return `pnpm exec wrangler rollback <${target}-version-id> --config ${worker.config} --yes`
}

function previewCommand(stageId) {
  const worker = WORKERS[stageId]
  if (stageId === 'compat-core' || stageId === 'tight-core') {
    return 'Core HTTP preview when available; exact bundle and static asset gate otherwise'
  }
  return `curl --fail --show-error https://<${stageId}-version-prefix>-${worker.name}.<workers-subdomain>.workers.dev/`
}

function workerRoutePatterns(configPath) {
  const config = readWranglerConfig(configPath)
  return config.routes.map((route) => String(route.pattern ?? route))
}

export function createWebReleaseManifest({
  releaseId,
  releaseGitSha,
  releaseLockfileSha256,
  compatCoreGitSha,
  compatCoreLockfileSha256,
}) {
  if (!RELEASE_ID.test(releaseId)) throw new TypeError('releaseId has an invalid shape')
  if (!GIT_SHA.test(releaseGitSha)) {
    throw new TypeError('releaseGitSha must be a full lowercase commit SHA')
  }
  if (!SHA256.test(releaseLockfileSha256)) {
    throw new TypeError('releaseLockfileSha256 must be a lowercase SHA-256 digest')
  }
  if (!GIT_SHA.test(compatCoreGitSha)) {
    throw new TypeError('compatCoreGitSha must be a full lowercase commit SHA')
  }
  if (!SHA256.test(compatCoreLockfileSha256)) {
    throw new TypeError('compatCoreLockfileSha256 must be a lowercase SHA-256 digest')
  }

  const artifacts = Object.fromEntries(
    WEB_RELEASE_STAGE_IDS.map((stageId) => {
      const worker = WORKERS[stageId]
      const gitSha = stageId === 'compat-core' ? compatCoreGitSha : releaseGitSha
      const lockfileSha256 =
        stageId === 'compat-core' ? compatCoreLockfileSha256 : releaseLockfileSha256
      const deploy = commandResult(versionDeployCommand(stageId))
      const route =
        stageId === 'console'
          ? commandResult(`pnpm exec wrangler triggers deploy --config ${worker.config}`)
          : stageId === 'site'
            ? commandResult(`pnpm exec wrangler triggers deploy --config ${worker.config}`)
            : commandResult('SKIP', 'SKIP')

      return [
        stageId,
        {
          workerName: worker.name,
          gitSha,
          lockfileSha256,
          artifactSha256: null,
          cloudflareVersionId: null,
          upload: commandResult(versionUploadCommand(stageId, gitSha)),
          preview: commandResult(previewCommand(stageId)),
          deploy,
          route,
          rollback: commandResult(rollbackCommand(stageId)),
        },
      ]
    }),
  )

  return {
    schemaVersion: 1,
    releaseId,
    source: {
      releaseGitSha,
      releaseLockfileSha256,
      compatCoreGitSha,
      compatCoreLockfileSha256,
    },
    preflight: {
      'main-ci': commandResult(
        'GitHub Actions API: require a successful CI push run for releaseGitSha',
      ),
      'database-migration-free': commandResult(
        'git diff --quiet <compat-core-git-sha> <release-git-sha> -- packages/db/drizzle',
      ),
      'www-dns-proxied': commandResult('Cloudflare DNS API: require www.xid.dev proxied=true'),
      'worker-deployments-ready': commandResult(
        'Cloudflare Workers Deployments API: require active xid, xid-console, and xid-site deployments',
      ),
      'workers-builds-upload-only': commandResult(
        'Cloudflare Builds API: reject a main trigger that promotes Core or mutates routes',
      ),
      'worker-routes-contract': commandResult('pnpm run test:web-routes'),
    },
    routeInventory: {
      zoneId: null,
      expectedPatterns: {
        console: workerRoutePatterns(WORKERS.console.config),
        site: workerRoutePatterns(WORKERS.site.config),
      },
    },
    productionBaseline: null,
    remoteCheckpoint: null,
    artifacts,
    routeChanges: {
      'console-activate': artifacts.console.route,
      'site-activate': artifacts.site.route,
      'console-remove': commandResult(
        'Cloudflare Zone Workers Routes API: delete recorded xid-console route ids',
      ),
      'site-remove-public': commandResult(
        'Cloudflare Zone Workers Routes API: delete recorded xid-site non-www route ids',
      ),
      'site-remove-www': commandResult(
        'Cloudflare Zone Workers Routes API: delete recorded xid-site www route ids',
      ),
    },
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateCommandResult(value, path, errors, requireComplete) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`)
    return
  }
  if (typeof value.command !== 'string' || value.command.length === 0) {
    errors.push(`${path}.command must be a non-empty string`)
  }
  if (!RESULT_VALUES.has(value.result)) {
    errors.push(`${path}.result must be PASS, FAIL, SKIP, or UNKNOWN`)
  }
  if (requireComplete && value.result === 'UNKNOWN') {
    errors.push(`${path}.result is incomplete`)
  }
}

function validateArtifact(value, { errors, requireComplete, source, stageId }) {
  const path = `artifacts.${stageId}`
  if (!isObject(value)) {
    errors.push(`${path} must be an object`)
    return
  }
  if (value.workerName !== WORKERS[stageId].name) {
    errors.push(`${path}.workerName must be ${WORKERS[stageId].name}`)
  }
  if (!GIT_SHA.test(value.gitSha ?? '')) errors.push(`${path}.gitSha is invalid`)
  const expectedGitSha = stageId === 'compat-core' ? source.compatCoreGitSha : source.releaseGitSha
  if (value.gitSha !== expectedGitSha) {
    errors.push(`${path}.gitSha must match its source git SHA`)
  }
  if (!SHA256.test(value.lockfileSha256 ?? '')) {
    errors.push(`${path}.lockfileSha256 is invalid`)
  }
  const expectedLockfileSha256 =
    stageId === 'compat-core' ? source.compatCoreLockfileSha256 : source.releaseLockfileSha256
  if (value.lockfileSha256 !== expectedLockfileSha256) {
    errors.push(`${path}.lockfileSha256 must match its source lockfile digest`)
  }
  if (value.artifactSha256 !== null && !SHA256.test(value.artifactSha256)) {
    errors.push(`${path}.artifactSha256 is invalid`)
  }
  if (value.cloudflareVersionId !== null && !VERSION_ID.test(value.cloudflareVersionId)) {
    errors.push(`${path}.cloudflareVersionId is invalid`)
  }
  if (requireComplete && value.artifactSha256 === null) {
    errors.push(`${path}.artifactSha256 is incomplete`)
  }
  if (requireComplete && value.cloudflareVersionId === null) {
    errors.push(`${path}.cloudflareVersionId is incomplete`)
  }
  for (const field of ['upload', 'preview', 'deploy', 'route', 'rollback']) {
    validateCommandResult(value[field], `${path}.${field}`, errors, requireComplete)
  }
}

function validateExpectedResult(value, path, expectedResult, errors) {
  if (!isObject(value) || !RESULT_VALUES.has(value.result)) return
  if (value.result !== expectedResult) {
    errors.push(`${path}.result must be ${expectedResult} for a successful release`)
  }
}

function validateSuccessfulRelease(manifest, errors) {
  if (isObject(manifest.preflight)) {
    for (const preflightId of WEB_RELEASE_PREFLIGHT_IDS) {
      validateExpectedResult(
        manifest.preflight[preflightId],
        `preflight.${preflightId}`,
        'PASS',
        errors,
      )
    }
  }

  if (isObject(manifest.artifacts)) {
    for (const stageId of WEB_RELEASE_STAGE_IDS) {
      const artifact = manifest.artifacts[stageId]
      if (!isObject(artifact)) continue
      for (const operation of ['upload', 'preview', 'deploy']) {
        validateExpectedResult(
          artifact[operation],
          `artifacts.${stageId}.${operation}`,
          'PASS',
          errors,
        )
      }
      validateExpectedResult(
        artifact.route,
        `artifacts.${stageId}.route`,
        stageId === 'console' || stageId === 'site' ? 'PASS' : 'SKIP',
        errors,
      )
      validateExpectedResult(artifact.rollback, `artifacts.${stageId}.rollback`, 'SKIP', errors)
    }
  }

  if (isObject(manifest.routeChanges)) {
    for (const changeId of WEB_ROUTE_CHANGE_IDS) {
      validateExpectedResult(
        manifest.routeChanges[changeId],
        `routeChanges.${changeId}`,
        changeId.endsWith('-activate') ? 'PASS' : 'SKIP',
        errors,
      )
    }
  }
  if (manifest.remoteCheckpoint?.phase !== 'SUCCESS') {
    errors.push('remoteCheckpoint.phase must be SUCCESS for a successful release')
  }
}

function validateDeploymentSnapshot(value, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`)
    return
  }
  if (typeof value.deploymentId !== 'string' || value.deploymentId.length === 0) {
    errors.push(`${path}.deploymentId must be a non-empty string`)
  }
  if (!Array.isArray(value.versions) || value.versions.length === 0) {
    errors.push(`${path}.versions must be a non-empty array`)
    return
  }
  let total = 0
  for (const [index, version] of value.versions.entries()) {
    if (!isObject(version) || !VERSION_ID.test(version.versionId ?? '')) {
      errors.push(`${path}.versions[${index}].versionId is invalid`)
    }
    if (!isObject(version) || !Number.isFinite(version.percentage) || version.percentage <= 0) {
      errors.push(`${path}.versions[${index}].percentage must be positive`)
    } else {
      total += version.percentage
    }
  }
  if (Math.abs(total - 100) > 0.001) {
    errors.push(`${path}.versions percentages must total 100`)
  }
}

function validateProductionBaseline(value, errors, requireComplete) {
  if (value === null || value === undefined) {
    if (requireComplete) errors.push('productionBaseline is incomplete')
    return
  }
  if (!isObject(value)) {
    errors.push('productionBaseline must be an object')
    return
  }
  if (!isObject(value.workers)) {
    errors.push('productionBaseline.workers must be an object')
  } else {
    for (const workerName of ['xid', 'xid-console', 'xid-site']) {
      validateDeploymentSnapshot(
        value.workers[workerName],
        `productionBaseline.workers.${workerName}`,
        errors,
      )
    }
  }
  if (!Array.isArray(value.frontendRoutes)) {
    errors.push('productionBaseline.frontendRoutes must be an array')
  } else if (value.frontendRoutes.length !== 0) {
    errors.push('productionBaseline.frontendRoutes must be empty for this one-time migration')
  }
}

function validateRemoteCheckpoint(value, errors, requireComplete) {
  if (value === null || value === undefined) {
    if (requireComplete) errors.push('remoteCheckpoint is incomplete')
    return
  }
  if (!isObject(value)) {
    errors.push('remoteCheckpoint must be an object')
    return
  }
  for (const field of ['deploymentId', 'repositoryId', 'workflowRunAttempt', 'workflowRunId']) {
    if (!/^[1-9][0-9]*$/u.test(value[field] ?? '')) {
      errors.push(`remoteCheckpoint.${field} must be a positive integer string`)
    }
  }
  if (!CHECKPOINT_PHASES.has(value.phase)) {
    errors.push('remoteCheckpoint.phase is invalid')
  }
}

function findSecretLikePath(value, path = '$', findings = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findSecretLikePath(entry, `${path}[${index}]`, findings))
    return findings
  }
  if (!isObject(value)) return findings

  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`
    if (/(?:secret|token|api[_-]?key|private[_-]?key)/iu.test(key)) findings.push(entryPath)
    findSecretLikePath(entry, entryPath, findings)
  }
  return findings
}

export function validateWebReleaseManifest(manifest, options = {}) {
  const requireSuccessfulRelease = options.requireSuccessfulRelease === true
  const requireComplete = options.requireComplete === true || requireSuccessfulRelease
  const errors = []
  if (!isObject(manifest)) return ['manifest must be an object']
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  if (!RELEASE_ID.test(manifest.releaseId ?? '')) errors.push('releaseId is invalid')
  if (!isObject(manifest.source)) {
    errors.push('source must be an object')
  } else {
    if (!GIT_SHA.test(manifest.source.releaseGitSha ?? '')) {
      errors.push('source.releaseGitSha is invalid')
    }
    if (!SHA256.test(manifest.source.releaseLockfileSha256 ?? '')) {
      errors.push('source.releaseLockfileSha256 is invalid')
    }
    if (!GIT_SHA.test(manifest.source.compatCoreGitSha ?? '')) {
      errors.push('source.compatCoreGitSha is invalid')
    }
    if (!SHA256.test(manifest.source.compatCoreLockfileSha256 ?? '')) {
      errors.push('source.compatCoreLockfileSha256 is invalid')
    }
  }
  if (!isObject(manifest.artifacts)) {
    errors.push('artifacts must be an object')
  } else if (isObject(manifest.source)) {
    for (const stageId of WEB_RELEASE_STAGE_IDS) {
      validateArtifact(manifest.artifacts[stageId], {
        errors,
        requireComplete,
        source: manifest.source,
        stageId,
      })
    }
  }
  if (!isObject(manifest.preflight)) {
    errors.push('preflight must be an object')
  } else {
    for (const preflightId of WEB_RELEASE_PREFLIGHT_IDS) {
      validateCommandResult(
        manifest.preflight[preflightId],
        `preflight.${preflightId}`,
        errors,
        requireComplete,
      )
    }
  }
  if (!isObject(manifest.routeInventory)) {
    errors.push('routeInventory must be an object')
  } else {
    const zoneId = manifest.routeInventory.zoneId
    if (zoneId !== null && !/^[a-f0-9]{32}$/u.test(zoneId)) {
      errors.push('routeInventory.zoneId is invalid')
    }
    if (requireComplete && zoneId === null) {
      errors.push('routeInventory.zoneId is incomplete')
    }
    const expectedPatterns = manifest.routeInventory.expectedPatterns
    if (!isObject(expectedPatterns)) {
      errors.push('routeInventory.expectedPatterns must be an object')
    } else {
      for (const workerId of ['console', 'site']) {
        const patterns = expectedPatterns[workerId]
        if (
          !Array.isArray(patterns) ||
          patterns.length === 0 ||
          patterns.some((pattern) => typeof pattern !== 'string' || pattern.length === 0)
        ) {
          errors.push(`routeInventory.expectedPatterns.${workerId} must be non-empty strings`)
        }
      }
    }
  }
  if (!isObject(manifest.routeChanges)) {
    errors.push('routeChanges must be an object')
  } else {
    for (const changeId of WEB_ROUTE_CHANGE_IDS) {
      validateCommandResult(
        manifest.routeChanges[changeId],
        `routeChanges.${changeId}`,
        errors,
        requireComplete,
      )
    }
  }
  validateProductionBaseline(manifest.productionBaseline, errors, requireComplete)
  validateRemoteCheckpoint(manifest.remoteCheckpoint, errors, requireComplete)
  for (const finding of findSecretLikePath(manifest)) {
    errors.push(`${finding} uses a secret-like field name`)
  }
  if (requireSuccessfulRelease) validateSuccessfulRelease(manifest, errors)
  return errors
}

function hasRecordedFailure(value) {
  if (Array.isArray(value)) return value.some(hasRecordedFailure)
  if (!isObject(value)) return false
  if (value.result === 'FAIL') return true
  return Object.values(value).some(hasRecordedFailure)
}

function loadJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function parseFlag(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? null : (args[index + 1] ?? null)
}

function safeReleasePath(releaseId, target) {
  const resolved = resolve(RELEASE_ROOT, releaseId, target)
  const relativePath = relative(RELEASE_ROOT, resolved)
  if (relativePath.startsWith('..') || relativePath === '') {
    throw new TypeError('release output must stay under .xid/releases')
  }
  return resolved
}

function readWranglerConfig(pathname) {
  return parseJsonc(readFileSync(resolve(REPOSITORY_ROOT, pathname), 'utf8'), pathname)
}

async function runCli() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'validate') {
    const file = args.find((value) => !value.startsWith('--'))
    if (!file) throw new TypeError('validate requires a manifest path')
    const manifest = loadJson(resolve(file))
    const errors = validateWebReleaseManifest(manifest, {
      requireComplete: args.includes('--complete-evidence'),
      requireSuccessfulRelease: args.includes('--complete'),
    })
    if (errors.length > 0) throw new TypeError(errors.join('\n'))
    if (hasRecordedFailure(manifest)) {
      process.stdout.write(`Recorded failure evidence in web release manifest ${file}\n`)
    } else {
      process.stdout.write(`PASS web release manifest ${file}\n`)
    }
    return
  }

  if (command === 'init') {
    const releaseId = parseFlag(args, '--release-id')
    const releaseGitSha = parseFlag(args, '--release-git-sha')
    const releaseLockfileSha256 = parseFlag(args, '--release-lockfile-sha256')
    const compatCoreGitSha = parseFlag(args, '--compat-core-git-sha')
    const compatCoreLockfileSha256 = parseFlag(args, '--compat-core-lockfile-sha256')
    if (
      !releaseId ||
      !releaseGitSha ||
      !releaseLockfileSha256 ||
      !compatCoreGitSha ||
      !compatCoreLockfileSha256
    ) {
      throw new TypeError(
        'init requires --release-id, --release-git-sha, --release-lockfile-sha256, --compat-core-git-sha, and --compat-core-lockfile-sha256',
      )
    }
    const manifest = createWebReleaseManifest({
      releaseId,
      releaseGitSha,
      releaseLockfileSha256,
      compatCoreGitSha,
      compatCoreLockfileSha256,
    })
    const manifestPath = safeReleasePath(releaseId, 'manifest.json')
    await mkdir(dirname(manifestPath), { recursive: true })
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    process.stdout.write(`PASS initialized ${relative(REPOSITORY_ROOT, manifestPath)}\n`)
    return
  }

  throw new TypeError(
    `usage: ${basename(process.argv[1])} validate <manifest> [--complete | --complete-evidence] | init --release-id <id> --release-git-sha <sha> --release-lockfile-sha256 <sha256> --compat-core-git-sha <sha> --compat-core-lockfile-sha256 <sha256>`,
  )
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli()
}
