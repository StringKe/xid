import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const migrationDir = join(scriptDir, '..', '..', '..', 'packages', 'db', 'drizzle')
const migrationMetaDir = join(migrationDir, 'meta')
const schemaDir = join(scriptDir, '..', '..', '..', 'packages', 'db', 'src', 'schema')

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

const DROP_TABLE_IF_EXISTS = new RegExp(
  String.raw`^DROP\s+TABLE\s+IF\s+EXISTS\s+(${IDENTIFIER})$`,
  'iu',
)
const DROP_MIGRATION_FILENAME = /^\d{4}_drop_[a-z0-9_]+\.sql$/u

// 死表清理白名单,表名 -> 允许删除的依据。空 Map = 当前没有任何被批准的删表,DROP TABLE 一律按非
// additive 拒绝。删表通道本身保留:白名单是"批准"这个动作的载体,要删表就往这里加一条,四重约束
// (白名单 + IF EXISTS + NNNN_drop_* 纯 drop 文件 + Drizzle schema 已删同名表)全部命中才放行,
// 误用需要同时改四处,review diff 里藏不住。
// 加条目前必须先在生产库只读核对该表行数为 0 并确认全库无读写路径。
const APPROVED_TABLE_DROPS = new Map()

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

// @xid-kit/db 只能经 packages/db/src/schema/*.ts 触到 D1,schema 里还在的表就是业务仍可查询的表。
// 扫 sqliteTable('...') 字面量把"schema 删除"和"migration 删除"绑成同一个 commit,这是唯一防止
// 误删在用生产表的机械保证。\s* 跨行,匹配仓库现有的 sqliteTable(\n  'name', 写法。
function readSchemaTableNames() {
  return new Set(
    readdirSync(schemaDir)
      .filter((file) => file.endsWith('.ts'))
      .flatMap((file) => [
        ...readFileSync(join(schemaDir, file), 'utf8').matchAll(/sqliteTable\(\s*'([a-z0-9_]+)'/gu),
      ])
      .map((match) => match[1]),
  )
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

// 只认 DROP TABLE IF EXISTS:裸 DROP TABLE 重跑会炸,而 IF EXISTS 让每条语句都是幂等终态;
// 同时这个精确形状把 DROP INDEX / DROP VIEW / 裸 DROP TABLE 一律留在放行面之外。
function approvedDropTarget(statement, approvedTableDrops) {
  const match = statement.match(DROP_TABLE_IF_EXISTS)
  if (match === null) return undefined
  const raw = match[1]
  const name = /^[`"[]/u.test(raw) ? raw.slice(1, -1) : raw
  return approvedTableDrops.has(name) ? name : undefined
}

// 破坏性变更必须在 ls drizzle 和 _journal.json 里一眼可见,不能混在大 additive diff 里被 review 漏掉;
// 句间无事务时"半 additive 半 drop"的部分失败状态最难收拾,所以 drop 文件必须是纯 drop。
function dropMigrationViolations(file, statements, targets, schemaTableNames) {
  const problems = []
  if (!DROP_MIGRATION_FILENAME.test(file)) {
    problems.push(`${file}: approved table drops require a NNNN_drop_*.sql migration`)
  }
  statements.forEach((statement, index) => {
    if (targets[index] !== undefined) return
    problems.push(
      `${file}: drop migration allows approved DROP TABLE IF EXISTS only; got ${statement.replace(/\s+/gu, ' ').slice(0, 120)}`,
    )
  })
  for (const target of targets) {
    if (target !== undefined && schemaTableNames.has(target)) {
      problems.push(`${file}: drizzle schema still declares dropped table ${target}`)
    }
  }
  return problems
}

// 逐句判形状,没有"整个文件按文件名或摘要豁免"的通道:那种豁免一旦存在,任何语句都能藏进被豁免的
// 文件里,而守卫恰恰是靠语句形状而不是靠文件身份来判断安全性的。
function incompatibleStatements({ file, sql }, schemaTableNames, approvedTableDrops) {
  const statements = splitStatements(sql)
  const targets = statements.map((statement) => approvedDropTarget(statement, approvedTableDrops))
  if (targets.every((target) => target === undefined)) {
    return statements
      .filter((statement) => !isApprovedAdditiveStatement(statement))
      .map((statement) => `${file}: ${statement.replace(/\s+/gu, ' ').slice(0, 120)}`)
  }
  return dropMigrationViolations(file, statements, targets, schemaTableNames)
}

function migrationTag(file) {
  return file.replace(/\.sql$/u, '')
}

function migrationPrefix(file) {
  const match = /^(\d{4})_/u.exec(file)
  if (match === null) throw new Error(`migration filename requires a four digit prefix: ${file}`)
  return match[1]
}

function snapshotTag(file) {
  const match = /^(\d{4})_snapshot\.json$/u.exec(file)
  if (match === null) throw new Error(`invalid migration snapshot filename: ${file}`)
  return match[1]
}

// journal 是 drizzle 侧的迁移清单,wrangler 却按目录里的文件名排序 apply。漏登记的 .sql 对 drizzle
// 不可见,下一次 generate 会复用同一个序号(仓库历史上因此出现过两个 0018_ 文件),而生产已经按文件名
// 排序把它跑过了 -- 两侧对"迁移集合"的认知一旦分叉,顺序就成了偶然。所以每个 .sql 必须有 journal entry。
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

  for (const { file } of migrations) {
    if (journalTags.has(migrationTag(file))) continue
    throw new Error(`migration SQL is missing a journal entry: ${file}`)
  }

  return journalTags
}

// drizzle-kit generate 拿 meta 里最新 snapshot 当 diff 基线,漏交 snapshot 会让下一次 generate
// 对着旧基线重出已经上线的 DDL。手写 SQL(trigger / 回填,drizzle-kit 不建模)走
// drizzle-kit generate --custom,一样产出 snapshot 与 journal entry,所以不需要给谁开口子。
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

  for (const { file } of migrations) {
    if (snapshotPrefixes.has(migrationPrefix(file))) continue
    throw new Error(
      `migration requires a Drizzle snapshot (hand-written SQL: drizzle-kit generate --custom): ${file}`,
    )
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
  schemaTableNames = readSchemaTableNames(),
  approvedTableDrops = APPROVED_TABLE_DROPS,
} = {}) {
  assertMigrationMetadata({ migrations, journalEntries, snapshots })
  const incompatible = migrations.flatMap((migration) =>
    incompatibleStatements(migration, schemaTableNames, approvedTableDrops),
  )
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
