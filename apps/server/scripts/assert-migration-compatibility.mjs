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

function isSafeMembershipSeatLimitTrigger(statement) {
  const normalized = statement.replace(/\s+/gu, ' ').trim()
  const triggerMatch =
    /^CREATE TRIGGER `?(memberships_seat_limit_before_insert|memberships_seat_limit_before_update)`? (BEFORE INSERT ON `?memberships`?|BEFORE UPDATE OF `?status`?, `?tenant_id`?, `?org_id`?, `?user_id`? ON `?memberships`?) WHEN (.+) BEGIN SELECT RAISE\(ABORT, 'seat_limit_exceeded'\); END$/iu.exec(
      normalized,
    )
  if (triggerMatch === null) return false
  const [, name, event, condition] = triggerMatch
  if (
    name === 'memberships_seat_limit_before_insert' &&
    !event.toUpperCase().startsWith('BEFORE INSERT')
  ) {
    return false
  }
  if (
    name === 'memberships_seat_limit_before_update' &&
    !event.toUpperCase().startsWith('BEFORE UPDATE')
  ) {
    return false
  }
  const required = [
    "NEW.`status` = 'active'",
    'NOT EXISTS ( SELECT 1 FROM `memberships`',
    'SELECT COUNT(DISTINCT `memberships`.`user_id`) FROM `memberships`',
    '`memberships`.`tenant_id` = NEW.`tenant_id`',
    '`memberships`.`user_id` = NEW.`user_id`',
    "`memberships`.`status` = 'active'",
    'FROM `organization_quotas`',
    '`tenant_id` = NEW.`tenant_id`',
    "`quota_key` = 'seats'",
    '`enforcement`',
    "'block_creation'",
    'SELECT `limit`',
  ]
  if (name === 'memberships_seat_limit_before_update') {
    required.push('`memberships`.`id` <> OLD.`id`')
  }
  return required.every((fragment) => condition.includes(fragment))
}

function isSafeResourceQuotaTrigger(statement) {
  const normalized = statement.replace(/\s+/gu, ' ').trim()
  const specs = {
    organizations_quota_before_insert: {
      event: 'BEFORE INSERT ON `organizations`',
      quotaKey: 'organizations',
      resourceTable: '`organizations`',
      required: ['NEW.`parent_org_id` IS NOT NULL', 'NEW.`deleted_at` IS NULL'],
    },
    organizations_quota_before_update: {
      event:
        'BEFORE UPDATE OF `status`, `deleted_at`, `tenant_id`, `parent_org_id` ON `organizations`',
      quotaKey: 'organizations',
      resourceTable: '`organizations`',
      required: ['NEW.`parent_org_id` IS NOT NULL', '`id` <> OLD.`id`'],
    },
    sso_connections_quota_before_insert: {
      event: 'BEFORE INSERT ON `sso_connections`',
      quotaKey: 'sso_connections',
      resourceTable: '`sso_connections`',
      required: ["NEW.`status` <> 'deleted'"],
    },
    sso_connections_quota_before_update: {
      event: 'BEFORE UPDATE OF `status`, `tenant_id` ON `sso_connections`',
      quotaKey: 'sso_connections',
      resourceTable: '`sso_connections`',
      required: ["OLD.`status` = 'deleted'", '`id` <> OLD.`id`'],
    },
  }
  const match =
    /^CREATE TRIGGER `?([a-z0-9_]+)`? (.+?) WHEN (.+) BEGIN SELECT RAISE\(ABORT, 'resource_quota_exceeded'\); END$/iu.exec(
      normalized,
    )
  if (match === null) return false
  const [, name, event, condition] = match
  const spec = specs[name]
  if (spec === undefined || event !== spec.event) return false
  return [
    'FROM `organization_quotas`',
    '`tenant_id` = NEW.`tenant_id`',
    `\`quota_key\` = '${spec.quotaKey}'`,
    '`enforcement`',
    "'block_creation'",
    'SELECT `limit`',
    'SELECT COUNT(*)',
    `FROM ${spec.resourceTable}`,
    ...spec.required,
  ].every((fragment) => condition.includes(fragment))
}

function isSafeOrganizationSeatQuotaBackfill(statement) {
  const normalized = statement.replace(/\s+/gu, ' ').trim()
  return (
    normalized ===
    [
      'INSERT INTO `organization_quotas` ( `tenant_id`, `quota_key`, `limit`, `enforcement`,',
      '`updated_by`, `created_at`, `updated_at` ) SELECT `organizations`.`tenant_id`,',
      "'seats', `organizations`.`seat_limit`, 'block_creation', NULL,",
      '`organizations`.`created_at`, `organizations`.`updated_at` FROM `organizations`',
      'WHERE `organizations`.`parent_org_id` IS NULL',
      'ON CONFLICT (`tenant_id`, `quota_key`) DO NOTHING',
    ].join(' ')
  )
}

function isSafeLegacyInvitationCutover(statement) {
  const normalized = statement.replace(/\s+/gu, ' ').trim()
  return (
    normalized ===
      "UPDATE `invitations` SET `status` = 'revoked', `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE `status` = 'pending' AND `token_version` = 'legacy'" ||
    normalized ===
      "CREATE TRIGGER `invitations_reject_legacy_pending_before_insert` BEFORE INSERT ON `invitations` WHEN NEW.`status` = 'pending' AND NEW.`token_version` = 'legacy' BEGIN SELECT RAISE(ABORT, 'legacy_invitation_token_disabled'); END"
  )
}

// These exact rewrites normalize only active invitation targets and revoke deterministic duplicate
// losers before the tenant/org/email partial UNIQUE index is installed.
function isSafeInvitationEmailClaimCutover(statement) {
  const normalized = statement.replace(/\s+/gu, ' ').trim()
  const normalizePendingEmail = [
    'UPDATE `invitations`',
    'SET `email` = lower(trim(`email`)),',
    "`updated_at` = CAST(strftime('%s', 'now') AS integer) * 1000",
    "WHERE `status` IN ('pending', 'claim_verified')",
    'AND `email` <> lower(trim(`email`))',
  ].join(' ')
  const revokeDuplicatePending = [
    'UPDATE `invitations` AS `duplicate`',
    "SET `status` = 'revoked',",
    "`updated_at` = CAST(strftime('%s', 'now') AS integer) * 1000",
    "WHERE `duplicate`.`status` IN ('pending', 'claim_verified')",
    'AND EXISTS ( SELECT 1 FROM `invitations` AS `keeper`',
    'WHERE `keeper`.`tenant_id` = `duplicate`.`tenant_id`',
    'AND `keeper`.`org_id` = `duplicate`.`org_id`',
    'AND `keeper`.`email` = `duplicate`.`email`',
    "AND `keeper`.`status` IN ('pending', 'claim_verified')",
    'AND ( `keeper`.`created_at` > `duplicate`.`created_at`',
    'OR ( `keeper`.`created_at` = `duplicate`.`created_at`',
    'AND `keeper`.`id` > `duplicate`.`id` ) ) )',
  ].join(' ')
  return normalized === normalizePendingEmail || normalized === revokeDuplicatePending
}

// The legacy UNIQUE index permits duplicate NULL scope ids. This exact cutover removes only
// redundant copies of the same instance-level authorization before the partial UNIQUE index lands.
function isSafeInstanceManagerDeduplication(statement) {
  const normalized = statement.replace(/\s+/gu, ' ').trim()
  return (
    normalized ===
    [
      'DELETE FROM `manager_assignments`',
      "WHERE `manager_role` = 'instance_manager'",
      "AND `scope_type` = 'instance'",
      'AND `scope_id` IS NULL',
      'AND EXISTS ( SELECT 1 FROM `manager_assignments` AS `retained`',
      'WHERE `retained`.`tenant_id` = `manager_assignments`.`tenant_id`',
      'AND `retained`.`user_id` = `manager_assignments`.`user_id`',
      'AND `retained`.`manager_role` = `manager_assignments`.`manager_role`',
      'AND `retained`.`scope_type` = `manager_assignments`.`scope_type`',
      'AND `retained`.`scope_id` IS NULL',
      'AND `retained`.`id` < `manager_assignments`.`id` )',
    ].join(' ')
  )
}

// These exact rewrites preserve every certificate while making the active-only UNIQUE index
// installable. Keeping full-statement equality prevents this exception from becoming a general
// cert_store UPDATE channel.
function isSafeSamlCertificateUniquenessCutover(statement) {
  const normalized = statement.replace(/\s+/gu, ' ').trim()
  const legacyIdpStatusRename = [
    'UPDATE `cert_store`',
    "SET `status` = 'retiring', `updated_at` = unixepoch() * 1000",
    "WHERE `status` = 'expiring'",
    "AND `usage` = 'saml_idp_signing'",
  ].join(' ')
  const legacySpStatusBackfill = [
    'UPDATE `cert_store`',
    "SET `status` = 'active', `updated_at` = unixepoch() * 1000",
    "WHERE `status` = 'expiring'",
    "AND `usage` IN ('saml_sp_signing', 'saml_sp_encryption')",
  ].join(' ')
  const activeCertificateDeduplication = [
    'UPDATE `cert_store`',
    "SET `status` = 'retiring', `updated_at` = unixepoch() * 1000",
    "WHERE `status` = 'active'",
    "AND `usage` = 'saml_idp_signing'",
    'AND EXISTS ( SELECT 1 FROM `cert_store` AS `retained`',
    'WHERE `retained`.`tenant_id` = `cert_store`.`tenant_id`',
    'AND `retained`.`usage` = `cert_store`.`usage`',
    "AND `retained`.`status` = 'active'",
    'AND `retained`.`id` < `cert_store`.`id` )',
  ].join(' ')
  return (
    normalized === legacyIdpStatusRename ||
    normalized === legacySpStatusBackfill ||
    normalized === activeCertificateDeduplication
  )
}

function isSafeOrganizationHierarchyTrigger(statement) {
  const normalized = statement.replace(/\s+/gu, ' ').trim()
  const insertTrigger = [
    'CREATE TRIGGER `organizations_hierarchy_insert_guard`',
    'BEFORE INSERT ON `organizations`',
    'WHEN ( NEW.`id` = NEW.`tenant_id` AND NEW.`parent_org_id` IS NOT NULL )',
    'OR ( NEW.`id` <> NEW.`tenant_id` AND ( NEW.`parent_org_id` IS NULL',
    'OR NEW.`parent_org_id` <> NEW.`tenant_id` OR NOT EXISTS ( SELECT 1',
    'FROM `organizations` AS parent WHERE parent.`id` = NEW.`tenant_id`',
    'AND parent.`tenant_id` = NEW.`tenant_id`',
    'AND parent.`instance_id` = NEW.`instance_id`',
    'AND parent.`parent_org_id` IS NULL AND parent.`status` =',
    "'active' ) ) ) BEGIN SELECT RAISE(ABORT, 'organization_hierarchy_invalid'); END",
  ].join(' ')
  const updateTrigger = [
    'CREATE TRIGGER `organizations_hierarchy_update_guard`',
    'BEFORE UPDATE OF `id`, `tenant_id`, `instance_id`, `parent_org_id`, `status`, `deleted_at`',
    'ON `organizations` WHEN NEW.`id` <> OLD.`id`',
    'OR NEW.`tenant_id` <> OLD.`tenant_id`',
    'OR NEW.`instance_id` <> OLD.`instance_id`',
    'OR NOT (NEW.`parent_org_id` IS OLD.`parent_org_id`)',
    'OR ( NEW.`id` = NEW.`tenant_id` AND NEW.`parent_org_id` IS NOT NULL )',
    'OR ( NEW.`id` <> NEW.`tenant_id` AND ( NEW.`parent_org_id` IS NULL',
    'OR NEW.`parent_org_id` <> NEW.`tenant_id` OR NOT EXISTS ( SELECT 1',
    'FROM `organizations` AS parent WHERE parent.`id` = NEW.`tenant_id`',
    'AND parent.`tenant_id` = NEW.`tenant_id`',
    'AND parent.`instance_id` = NEW.`instance_id`',
    'AND parent.`parent_org_id` IS NULL',
    "AND (NEW.`status` <> 'active' OR parent.`status` = 'active') ) ) )",
    "BEGIN SELECT RAISE(ABORT, 'organization_hierarchy_invalid'); END",
  ].join(' ')
  return normalized === insertTrigger || normalized === updateTrigger
}

function isSafeCreateTrigger(statement) {
  if (isSafeLegacyInvitationCutover(statement)) return true
  if (isSafeMembershipSeatLimitTrigger(statement)) return true
  if (isSafeResourceQuotaTrigger(statement)) return true
  if (isSafeOrganizationHierarchyTrigger(statement)) return true
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
    isSafeCreateTrigger(statement) ||
    isSafeOrganizationSeatQuotaBackfill(statement) ||
    isSafeLegacyInvitationCutover(statement) ||
    isSafeInvitationEmailClaimCutover(statement) ||
    isSafeInstanceManagerDeduplication(statement) ||
    isSafeSamlCertificateUniquenessCutover(statement)
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
