import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// 发布器只允许打到 wrangler.jsonc 里登记的这一个 Cloudflare 账号,防止误发到别的账号。
// fork 自托管时把这里和 wrangler.jsonc 的 account_id 一起换成自己的账号 id。
const PRODUCTION_ACCOUNT_ID = '86e4d320a5d69fb54f9721fb219a4902'
const REQUIRED_CI_CHECKS = ['quality', 'security']
const SCRIPT_DIRECTORY = dirname(new URL(import.meta.url).pathname)
export const VERIFIED_WRANGLER_CONFIG_PATH = join(SCRIPT_DIRECTORY, '..', 'wrangler.jsonc')
const MIGRATIONS_DIRECTORY = join(SCRIPT_DIRECTORY, '..', '..', '..', 'packages', 'db', 'drizzle')
const MIGRATION_META_DIRECTORY = join(MIGRATIONS_DIRECTORY, 'meta')
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
  assertNoProductionTargetOverrides()
  const config = readFileSync(VERIFIED_WRANGLER_CONFIG_PATH, 'utf8')
  const workerName = config.match(/"name"\s*:\s*"([^"]+)"/u)?.[1]
  const accountId = config.match(/"account_id"\s*:\s*"([a-f0-9]{32})"/iu)?.[1]
  const databaseId = config.match(
    /"d1_databases"\s*:\s*\[[\s\S]*?"binding"\s*:\s*"DB"[\s\S]*?"database_id"\s*:\s*"([a-f0-9-]{36})"/iu,
  )?.[1]
  if (accountId !== PRODUCTION_ACCOUNT_ID) {
    throw new Error(
      `wrangler config account_id must match the configured production account ${PRODUCTION_ACCOUNT_ID}`,
    )
  }
  if (workerName !== 'xid') throw new Error('wrangler config name must be xid')
  if (!databaseId) throw new Error('wrangler config DB binding missing database_id')
  return {
    accountId,
    databaseId,
    workerName,
    configPath: VERIFIED_WRANGLER_CONFIG_PATH,
    configDigest: sha256(config),
  }
}

export function verifiedWranglerConfigArgs() {
  return ['--config', VERIFIED_WRANGLER_CONFIG_PATH]
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
