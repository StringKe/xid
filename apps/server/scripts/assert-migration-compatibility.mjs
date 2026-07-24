import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const migrationDir = join(scriptDir, '..', '..', '..', 'packages', 'db', 'drizzle')
const migrationMetaDir = join(migrationDir, 'meta')

const IDENTIFIER = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_$]*)'
const CREATE_TABLE = new RegExp(
  String.raw`^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENTIFIER}\s*\([\s\S]+\)$`,
  'iu',
)
const CREATE_INDEX = new RegExp(
  String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENTIFIER}\s+ON\s+${IDENTIFIER}\s*\([\s\S]+\)(?:\s+WHERE\s+[\s\S]+)?$`,
  'iu',
)
const ALTER_TABLE_ADD_COLUMN = new RegExp(
  String.raw`^ALTER\s+TABLE\s+${IDENTIFIER}\s+ADD(?:\s+COLUMN)?\s+${IDENTIFIER}\s+([\s\S]+)$`,
  'iu',
)

// 历史数据迁移和索引替换(0007/0008/0009/0020)已在本地与生产链路执行,仅允许字节级不变的既有文件通过。
// 0033 是经评审的例外:TTL 收口需要把存量旧默认 session_policy(30min/7d)幂等回填为 3d/30d,语句只命中旧默认行。
// 0034 是经评审的例外:applications.access_token_ttl_sec 改可空(NULL = 继承租户 token 策略),SQLite 不支持
// ALTER COLUMN 改约束,走标准表重建;applications 是小型配置表,INSERT SELECT 全列拷贝、零数据语义变化,
// 存量 3600 值原样保留,索引随 DROP 自动清除后按原样重建。
// 后续迁移不得复用此例外。
const APPROVED_LEGACY_MIGRATION_DIGESTS = new Map([
  [
    '0007_users_active_identifier_indexes.sql',
    '604575618cdf7728aa7027136d75c5201a5cd34ef7b676d91601d847d8a97583',
  ],
  ['0008_aspiring_reaper.sql', '340c7c51befe9222d9e15c7f17009b1b276ba062de845d43a71155bfe7d71ce7'],
  [
    '0009_primary_email_backfill.sql',
    'a25ddcfd6468be554f5b232d558ad16c6352de19cd9dbc390c9a6fb98367917e',
  ],
  [
    '0020_saml_sp_org_scope.sql',
    'dfff9ace677e0df83b7622b65a03e4f82500f4472c323a6faf8efbe65ec853ca',
  ],
  [
    '0033_ttl_policy_columns.sql',
    '19762b29721d196f70bcb48e9b1946cf206e362f6a058a827b7b44ca8d591ab5',
  ],
  [
    '0034_applications_ttl_nullable.sql',
    '93d6f0e3093ff6a69c004f5e766f4d1c769c0bbf41a76dc8ef70d695b529050b',
  ],
])

// 这些手工迁移早于 journal 约束。清单以文件摘要固定，避免新增迁移借历史路径绕过 metadata。
const APPROVED_UNJOURNALED_MIGRATION_DIGESTS = new Map([
  [
    '0007_users_active_identifier_indexes.sql',
    '604575618cdf7728aa7027136d75c5201a5cd34ef7b676d91601d847d8a97583',
  ],
  [
    '0009_primary_email_backfill.sql',
    'a25ddcfd6468be554f5b232d558ad16c6352de19cd9dbc390c9a6fb98367917e',
  ],
  ['0018_saml_slo.sql', 'cb6c0a208a4bbcb5b7125d58dde3a35c80c5d60e6edd5b6b684d411956f7acc8'],
  [
    '0019_saml_slo_hardening.sql',
    '8863ca05d31f2923a6a6d96c31f19bfeebafa22f4d31ce04061f7bc2ef7573d1',
  ],
])

const SNAPSHOT_REQUIRED_THROUGH = 16
const APPROVED_PRE_CUTOFF_SNAPSHOT_GAPS = new Map([
  [
    '0007_users_active_identifier_indexes.sql',
    '604575618cdf7728aa7027136d75c5201a5cd34ef7b676d91601d847d8a97583',
  ],
  [
    '0009_primary_email_backfill.sql',
    'a25ddcfd6468be554f5b232d558ad16c6352de19cd9dbc390c9a6fb98367917e',
  ],
])

function readMigrations() {
  return readdirSync(migrationDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(migrationDir, file), 'utf8') }))
}

function readJournalEntries() {
  const journal = JSON.parse(readFileSync(join(migrationMetaDir, '_journal.json'), 'utf8'))
  if (!Array.isArray(journal.entries)) throw new Error('migration journal entries must be an array')
  return journal.entries
}

function readSnapshots() {
  return readdirSync(migrationMetaDir)
    .filter((file) => /^\d{4}_snapshot\.json$/u.test(file))
    .sort()
    .map((file) => ({ file, content: readFileSync(join(migrationMetaDir, file), 'utf8') }))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function splitStatements(sql) {
  const statements = []
  let current = ''
  let quote = undefined
  let inLineComment = false
  let inBlockComment = false
  const normalized = sql.replaceAll('--> statement-breakpoint', ';')

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]
    const next = normalized[index + 1]

    if (inLineComment) {
      if (character === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (character === '*' && next === '/') {
        inBlockComment = false
        index += 1
      }
      continue
    }
    if (quote !== undefined) {
      current += character
      if (character === quote) {
        if (next === quote) {
          current += next
          index += 1
        } else {
          quote = undefined
        }
      }
      continue
    }
    if (character === '-' && next === '-') {
      inLineComment = true
      index += 1
      continue
    }
    if (character === '/' && next === '*') {
      inBlockComment = true
      index += 1
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      current += character
      continue
    }
    if (character === ';') {
      const isTrigger = /^\s*CREATE\s+TRIGGER\b/iu.test(current)
      if (isTrigger && /^\s*END\s*;/iu.test(normalized.slice(index + 1))) {
        current += character
        continue
      }
      const statement = current.trim()
      if (statement.length > 0) statements.push(statement)
      current = ''
      continue
    }
    current += character
  }

  const statement = current.trim()
  if (statement.length > 0) statements.push(statement)
  return statements
}

function isSafeAddedColumn(statement) {
  const match = statement.match(ALTER_TABLE_ADD_COLUMN)
  if (match === null) return false
  const definition = match[1]
  if (/\b(?:PRIMARY\s+KEY|UNIQUE)\b/iu.test(definition)) return false
  return !/\bNOT\s+NULL\b/iu.test(definition) || /\bDEFAULT\b/iu.test(definition)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function namedIdentifier(name) {
  return `(?:\`${name}\`|"${name}"|\\[${name}\\]|${name})`
}

function isSafeCreateTrigger(statement) {
  const normalized = statement.replace(/\s+/gu, ' ').trim()
  const match = new RegExp(
    String.raw`^CREATE TRIGGER (?:IF NOT EXISTS )?(${IDENTIFIER}) BEFORE INSERT ON (${IDENTIFIER})(?: WHEN (.+?))? BEGIN (.+) END$`,
    'iu',
  ).exec(normalized)
  if (match === null) return false

  const [, , table, condition, body] = match
  const escapedTable = escapeRegExp(table)
  const tenantId = namedIdentifier('tenant_id')
  const userId = namedIdentifier('user_id')
  const batchId = namedIdentifier('batch_id')
  if (condition !== undefined) {
    const safeCondition = new RegExp(
      String.raw`^\( SELECT count\(\*\) FROM ${escapedTable} WHERE ${tenantId} = NEW\.${tenantId} AND ${userId} = NEW\.${userId} AND ${IDENTIFIER} IS NULL \) >= [1-9][0-9]*$`,
      'iu',
    )
    return safeCondition.test(condition) && /^SELECT RAISE\(ABORT, '[A-Za-z0-9_]+'\);$/iu.test(body)
  }

  const safeDelete = new RegExp(
    String.raw`^DELETE FROM ${escapedTable} WHERE ${tenantId} = NEW\.${tenantId} AND ${userId} = NEW\.${userId} AND ${batchId} <> NEW\.${batchId};$`,
    'iu',
  )
  return safeDelete.test(body)
}

function isApprovedAdditiveStatement(statement) {
  return (
    CREATE_TABLE.test(statement) ||
    CREATE_INDEX.test(statement) ||
    isSafeAddedColumn(statement) ||
    isSafeCreateTrigger(statement)
  )
}

function incompatibleStatements({ file, sql }) {
  const expectedDigest = APPROVED_LEGACY_MIGRATION_DIGESTS.get(file)
  if (expectedDigest !== undefined && sha256(sql) === expectedDigest) return []

  return splitStatements(sql)
    .filter((statement) => !isApprovedAdditiveStatement(statement))
    .map((statement) => `${file}: ${statement.replace(/\s+/gu, ' ').slice(0, 120)}`)
}

function migrationTag(file) {
  return file.replace(/\.sql$/u, '')
}

function migrationNumber(file) {
  const match = /^(\d{4})_/u.exec(file)
  if (match === null) throw new Error(`migration filename requires a four digit prefix: ${file}`)
  return Number.parseInt(match[1], 10)
}

function snapshotTag(file) {
  const match = /^(\d{4})_snapshot\.json$/u.exec(file)
  if (match === null) throw new Error(`invalid migration snapshot filename: ${file}`)
  return match[1]
}

function assertJournalCoverage(migrations, journalEntries) {
  const migrationByTag = new Map(
    migrations.map(({ file, sql }) => [migrationTag(file), { file, sql }]),
  )
  const journalTags = new Set()

  for (const entry of journalEntries) {
    if (typeof entry?.tag !== 'string') throw new Error('migration journal entry requires a tag')
    if (journalTags.has(entry.tag))
      throw new Error(`migration journal contains duplicate tag: ${entry.tag}`)
    if (!migrationByTag.has(entry.tag)) {
      throw new Error(`migration journal references missing SQL file: ${entry.tag}.sql`)
    }
    journalTags.add(entry.tag)
  }

  for (const { file, sql } of migrations) {
    if (journalTags.has(migrationTag(file))) continue
    const expectedDigest = APPROVED_UNJOURNALED_MIGRATION_DIGESTS.get(file)
    if (expectedDigest === undefined || sha256(sql) !== expectedDigest) {
      throw new Error(`migration SQL is missing a journal entry: ${file}`)
    }
  }

  return journalTags
}

function assertSnapshotPolicy(migrations, journalTags, snapshots) {
  const snapshotPrefixes = new Set()

  for (const snapshot of snapshots) {
    const prefix = snapshotTag(snapshot.file)
    if (snapshotPrefixes.has(prefix))
      throw new Error(`duplicate migration snapshot prefix: ${prefix}`)
    if (![...journalTags].some((tag) => tag.startsWith(`${prefix}_`))) {
      throw new Error(`migration snapshot has no journal entry: ${snapshot.file}`)
    }
    let parsed
    try {
      parsed = JSON.parse(snapshot.content)
    } catch {
      throw new Error(`migration snapshot is not valid JSON: ${snapshot.file}`)
    }
    if (parsed.dialect !== 'sqlite') {
      throw new Error(`migration snapshot has unsupported dialect: ${snapshot.file}`)
    }
    snapshotPrefixes.add(prefix)
  }

  for (const { file, sql } of migrations) {
    if (migrationNumber(file) > SNAPSHOT_REQUIRED_THROUGH) continue
    const prefix = file.slice(0, 4)
    if (snapshotPrefixes.has(prefix)) continue
    const expectedDigest = APPROVED_PRE_CUTOFF_SNAPSHOT_GAPS.get(file)
    if (sql === undefined || expectedDigest === undefined || sha256(sql) !== expectedDigest) {
      throw new Error(`migration requires a Drizzle snapshot: ${file}`)
    }
  }
}

export function assertMigrationMetadata({
  migrations = readMigrations(),
  journalEntries = readJournalEntries(),
  snapshots = readSnapshots(),
} = {}) {
  const journalTags = assertJournalCoverage(migrations, journalEntries)
  assertSnapshotPolicy(migrations, journalTags, snapshots)
}

export function assertMigrationCompatibility({
  migrations = readMigrations(),
  journalEntries = readJournalEntries(),
  snapshots = readSnapshots(),
} = {}) {
  assertMigrationMetadata({ migrations, journalEntries, snapshots })
  const incompatible = migrations.flatMap(incompatibleStatements)
  if (incompatible.length > 0) {
    throw new Error(
      `migration compatibility requires approved additive DDL only; blocked: ${incompatible.join(', ')}`,
    )
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  assertMigrationCompatibility()
  process.stdout.write('PASS migration compatibility: approved additive DDL only\n')
}
