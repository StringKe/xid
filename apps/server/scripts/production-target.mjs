import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// 发布器只允许打到 wrangler.jsonc 里登记的这一个 Cloudflare 账号,防止误发到别的账号。
// fork 自托管时把这里和 wrangler.jsonc 的 account_id 一起换成自己的账号 id。
const PRODUCTION_ACCOUNT_ID = '86e4d320a5d69fb54f9721fb219a4902'
export const REQUIRED_CI_CHECKS = ['check', 'test', 'build', 'smoke', 'security']
export const PRODUCTION_WORKER_KEYS = ['core', 'console', 'site']
const SCRIPT_DIRECTORY = dirname(new URL(import.meta.url).pathname)
export const VERIFIED_WRANGLER_CONFIG_PATH = join(SCRIPT_DIRECTORY, '..', 'wrangler.jsonc')
const VERIFIED_CONSOLE_WRANGLER_CONFIG_PATH = join(
  SCRIPT_DIRECTORY,
  '..',
  '..',
  'console',
  'wrangler.jsonc',
)
const VERIFIED_SITE_WRANGLER_CONFIG_PATH = join(
  SCRIPT_DIRECTORY,
  '..',
  '..',
  'site',
  'wrangler.jsonc',
)
const MIGRATIONS_DIRECTORY = join(SCRIPT_DIRECTORY, '..', '..', '..', 'packages', 'db', 'drizzle')
const MIGRATION_META_DIRECTORY = join(MIGRATIONS_DIRECTORY, 'meta')
export const CLOUDFLARE_SECURITY_RULES_PATH = join(
  SCRIPT_DIRECTORY,
  '..',
  '..',
  '..',
  'docs',
  'deployment',
  'cloudflare-security-rules.v1.json',
)
const TARGET_OVERRIDE_ENVIRONMENT = [
  'WRANGLER_CONFIG',
  'XID_WRANGLER_CONFIG',
  'XID_PRODUCTION_DB_BINDING',
  'XID_PRODUCTION_WORKER_FILTER',
]

export function assertNoProductionTargetOverrides(environment = process.env) {
  const overridden = TARGET_OVERRIDE_ENVIRONMENT.find((name) => environment[name]?.trim())
  if (overridden) throw new Error(`production target override is forbidden: ${overridden}`)
}

export function readConfiguredDeploymentTarget() {
  return readConfiguredDeploymentTargets().core
}

export function readConfiguredDeploymentTargets() {
  assertNoProductionTargetOverrides()
  const definitions = {
    core: {
      workerName: 'xid',
      configPath: VERIFIED_WRANGLER_CONFIG_PATH,
      requiresDatabase: true,
    },
    console: {
      workerName: 'xid-console',
      configPath: VERIFIED_CONSOLE_WRANGLER_CONFIG_PATH,
      requiresDatabase: false,
    },
    site: {
      workerName: 'xid-site',
      configPath: VERIFIED_SITE_WRANGLER_CONFIG_PATH,
      requiresDatabase: false,
    },
  }
  return Object.fromEntries(
    Object.entries(definitions).map(([key, definition]) => {
      const config = readFileSync(definition.configPath, 'utf8')
      const workerName = config.match(/"name"\s*:\s*"([^"]+)"/u)?.[1]
      const accountId = config.match(/"account_id"\s*:\s*"([a-f0-9]{32})"/iu)?.[1]
      const databaseId = config.match(
        /"d1_databases"\s*:\s*\[[\s\S]*?"binding"\s*:\s*"DB"[\s\S]*?"database_id"\s*:\s*"([a-f0-9-]{36})"/iu,
      )?.[1]
      if (accountId !== PRODUCTION_ACCOUNT_ID) {
        throw new Error(
          `${definition.workerName} wrangler config account_id must match the configured production account ${PRODUCTION_ACCOUNT_ID}`,
        )
      }
      if (workerName !== definition.workerName) {
        throw new Error(`wrangler config name must be ${definition.workerName}`)
      }
      if (definition.requiresDatabase && !databaseId) {
        throw new Error('xid wrangler config DB binding missing database_id')
      }
      return [
        key,
        {
          accountId,
          databaseId: databaseId ?? null,
          workerName,
          configPath: definition.configPath,
          configDigest: sha256(config),
        },
      ]
    }),
  )
}

export function verifiedWranglerConfigArgs(configPath = VERIFIED_WRANGLER_CONFIG_PATH) {
  return ['--config', configPath]
}

export function verifiedRemoteD1MigrationArgs(configPath = VERIFIED_WRANGLER_CONFIG_PATH) {
  return [
    '--filter',
    '@xid-kit/server',
    'exec',
    'wrangler',
    'd1',
    'migrations',
    'list',
    'DB',
    '--remote',
    ...verifiedWranglerConfigArgs(configPath),
  ]
}

export function parsePendingD1Migrations(output) {
  const normalized = String(output)
  const migrations = [
    ...normalized.matchAll(/(?:^|\s)(\d{4}_[A-Za-z0-9_.-]+\.sql)(?=\s|$)/gmu),
  ].map((match) => match[1])
  if (migrations.length > 0) {
    return [...new Set(migrations)].sort((left, right) => left.localeCompare(right))
  }
  if (normalized.includes('No migrations to apply!')) return []
  throw new Error('wrangler d1 migrations list output was not recognized')
}

export function readCloudflareSecurityRulesState({
  manifestPath = CLOUDFLARE_SECURITY_RULES_PATH,
  content,
} = {}) {
  const raw = content ?? readFileSync(manifestPath, 'utf8')
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch {
    throw new Error('Cloudflare security rules manifest returned invalid JSON')
  }
  if (manifest?.schemaVersion !== 1) {
    throw new Error('Cloudflare security rules manifest schemaVersion must be 1')
  }
  if (!['EXTERNAL', 'RECONCILED'].includes(manifest.deploymentState)) {
    throw new Error('Cloudflare security rules manifest deploymentState is invalid')
  }
  return {
    manifestDigest: sha256(raw),
    deploymentState: manifest.deploymentState,
  }
}

export function readMigrationDigest({
  migrationsDirectory = MIGRATIONS_DIRECTORY,
  migrationMetaDirectory = MIGRATION_META_DIRECTORY,
  migrationFiles,
  metadataFiles,
} = {}) {
  const hash = createHash('sha256')
  const sqlFiles =
    migrationFiles ??
    readdirSync(migrationsDirectory)
      .filter((name) => /^\d+_.+\.sql$/u.test(name))
      .sort((left, right) => left.localeCompare(right))
      .map((name) => ({ name, content: readFileSync(join(migrationsDirectory, name)) }))
  if (sqlFiles.length === 0) throw new Error('no SQL migrations found for production target digest')
  const metaFiles =
    metadataFiles ??
    [
      '_journal.json',
      ...readdirSync(migrationMetaDirectory)
        .filter((name) => /^\d{4}_snapshot\.json$/u.test(name))
        .sort((left, right) => left.localeCompare(right)),
    ].map((name) => ({ name, content: readFileSync(join(migrationMetaDirectory, name)) }))
  for (const file of sqlFiles) {
    hash.update(`sql/${file.name}`)
    hash.update('\u0000')
    hash.update(file.content)
    hash.update('\u0000')
  }
  for (const file of metaFiles) {
    hash.update(`meta/${file.name}`)
    hash.update('\u0000')
    hash.update(file.content)
    hash.update('\u0000')
  }
  return hash.digest('hex')
}

export function assertRequiredCiConclusions(output, gitHead) {
  if (!/^[0-9a-f]{40}$/u.test(gitHead)) {
    throw new Error('required CI checks require the current full git HEAD')
  }
  let body
  try {
    body = JSON.parse(output)
  } catch {
    throw new Error('required CI check-runs returned invalid JSON')
  }
  const conclusions = {}
  for (const name of REQUIRED_CI_CHECKS) {
    const checks = body.check_runs?.filter((item) => item?.name === name) ?? []
    if (checks.length !== 1) {
      throw new Error(`required CI check ${name} must appear exactly once for ${gitHead}`)
    }
    const check = checks[0]
    if (check.head_sha !== gitHead) {
      throw new Error(`required CI check ${name} does not match current git HEAD`)
    }
    if (check?.status !== 'completed' || check.conclusion !== 'success') {
      throw new Error(`required CI check ${name} is not successful`)
    }
    conclusions[name] = check.conclusion
  }
  return conclusions
}

export function assertSuccessfulWorkersBuilds(output, gitHead, targets) {
  const ciConclusions = assertRequiredCiConclusions(output, gitHead)
  let body
  try {
    body = JSON.parse(output)
  } catch {
    throw new Error('Workers Builds check-runs returned invalid JSON')
  }

  const workers = {}
  for (const key of PRODUCTION_WORKER_KEYS) {
    const target = targets?.[key]
    if (!target?.workerName) throw new Error(`production Worker target ${key} is missing`)
    const checkName = `Workers Builds: ${target.workerName}`
    const checks = body.check_runs?.filter((item) => item?.name === checkName) ?? []
    if (checks.length !== 1) {
      throw new Error(`${checkName} must appear exactly once for ${gitHead}`)
    }
    const check = checks[0]
    if (check.head_sha !== gitHead) {
      throw new Error(`${checkName} does not match current git HEAD`)
    }
    if (check.status !== 'completed' || check.conclusion !== 'success') {
      throw new Error(
        `${checkName} not successful status=${check.status} conclusion=${check.conclusion}`,
      )
    }
    const summary = String(check.output?.summary ?? '')
    const versionId = summary.match(/Version ID:\s*([a-f0-9-]+)/u)?.[1]
    if (!versionId) throw new Error(`${checkName} missing Version ID for ${gitHead}`)
    workers[key] = {
      buildId: check.external_id ?? 'unknown',
      checkRunId: check.id,
      workerVersionId: versionId,
    }
  }
  return { workers, ciConclusions }
}

export function assertActiveDeployment(output, expectedVersionId, workerName) {
  let deployment
  try {
    deployment = JSON.parse(output)
  } catch {
    throw new Error(`${workerName} deployment status returned invalid JSON`)
  }
  const activeVersions =
    deployment.versions?.filter((version) => Number(version.percentage) === 100) ?? []
  if (activeVersions.length !== 1) {
    throw new Error(`${workerName} must have exactly one 100 percent active Worker version`)
  }
  const active = activeVersions[0]
  if (active.version_id !== expectedVersionId) {
    throw new Error(
      `${workerName} active Worker version ${active.version_id} does not match Workers Builds version ${expectedVersionId}`,
    )
  }
  if (typeof deployment.id !== 'string' || deployment.id.length === 0) {
    throw new Error(`${workerName} active Worker deployment is missing its deployment id`)
  }
  return {
    deploymentId: deployment.id,
    workerVersionId: active.version_id,
    activePercentage: Number(active.percentage),
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
