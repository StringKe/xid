import { describe, expect, it } from 'vitest'
import {
  assertMigrationCompatibility,
  assertMigrationMetadata,
} from '../assert-migration-compatibility.mjs'

// 合成迁移一律配齐 journal + snapshot,让每个用例只剩一个变量:被测的那条语句形状。
// 用合成输入而不是仓库里的真实迁移文件,守卫的行为契约才不会随 packages/db/drizzle 的内容漂移。
function migrationSet(file, sql) {
  return {
    migrations: [{ file, sql }],
    journalEntries: [{ tag: file.replace(/\.sql$/u, '') }],
    snapshots: [{ file: `${file.slice(0, 4)}_snapshot.json`, content: '{"dialect":"sqlite"}' }],
  }
}

const samlCertificateCutoverSql = `UPDATE \`cert_store\`
SET \`status\` = 'retiring',
    \`updated_at\` = unixepoch() * 1000
WHERE \`status\` = 'expiring'
  AND \`usage\` = 'saml_idp_signing';
UPDATE \`cert_store\`
SET \`status\` = 'active',
    \`updated_at\` = unixepoch() * 1000
WHERE \`status\` = 'expiring'
  AND \`usage\` IN ('saml_sp_signing', 'saml_sp_encryption');
UPDATE \`cert_store\`
SET \`status\` = 'retiring',
    \`updated_at\` = unixepoch() * 1000
WHERE \`status\` = 'active'
  AND \`usage\` = 'saml_idp_signing'
  AND EXISTS (
    SELECT 1
    FROM \`cert_store\` AS \`retained\`
    WHERE \`retained\`.\`tenant_id\` = \`cert_store\`.\`tenant_id\`
      AND \`retained\`.\`usage\` = \`cert_store\`.\`usage\`
      AND \`retained\`.\`status\` = 'active'
      AND \`retained\`.\`id\` < \`cert_store\`.\`id\`
  );
CREATE UNIQUE INDEX \`cert_store_tenant_usage_active_unq\`
  ON \`cert_store\` (\`tenant_id\`, \`usage\`)
  WHERE \`cert_store\`.\`status\` = 'active'
    AND \`cert_store\`.\`usage\` = 'saml_idp_signing';`

const invitationEmailClaimCutoverSql = `UPDATE \`invitations\`
SET \`email\` = lower(trim(\`email\`)),
    \`updated_at\` = CAST(strftime('%s', 'now') AS integer) * 1000
WHERE \`status\` IN ('pending', 'claim_verified')
  AND \`email\` <> lower(trim(\`email\`));
UPDATE \`invitations\` AS \`duplicate\`
SET \`status\` = 'revoked',
    \`updated_at\` = CAST(strftime('%s', 'now') AS integer) * 1000
WHERE \`duplicate\`.\`status\` IN ('pending', 'claim_verified')
  AND EXISTS (
    SELECT 1
    FROM \`invitations\` AS \`keeper\`
    WHERE \`keeper\`.\`tenant_id\` = \`duplicate\`.\`tenant_id\`
      AND \`keeper\`.\`org_id\` = \`duplicate\`.\`org_id\`
      AND \`keeper\`.\`email\` = \`duplicate\`.\`email\`
      AND \`keeper\`.\`status\` IN ('pending', 'claim_verified')
      AND (
        \`keeper\`.\`created_at\` > \`duplicate\`.\`created_at\`
        OR (
          \`keeper\`.\`created_at\` = \`duplicate\`.\`created_at\`
          AND \`keeper\`.\`id\` > \`duplicate\`.\`id\`
        )
      )
  );`

// 守卫出厂时白名单为空,drop 通道的用例必须自带批准清单,顺带证明"批准"是一次显式动作。
const approvedTableDrops = new Map([
  ['legacy_table', 'test fixture: 生产 0 行且无读写路径'],
  ['legacy_shadow_table', 'test fixture: 生产 0 行且无读写路径'],
])

describe('migration compatibility gate', () => {
  it('accepts the migration set committed in the repository', () => {
    expect(() => assertMigrationCompatibility()).not.toThrow()
  })

  it('accepts additive DDL', () => {
    expect(() =>
      assertMigrationCompatibility({
        migrations: [
          {
            file: '0001_add_column.sql',
            sql: "ALTER TABLE users ADD locale text NOT NULL DEFAULT 'en';",
          },
          { file: '0002_new_table.sql', sql: 'CREATE TABLE audit_events (id text PRIMARY KEY);' },
          {
            file: '0003_index.sql',
            sql: 'CREATE UNIQUE INDEX audit_events_id_unq ON audit_events (id);',
          },
          {
            file: '0004_trigger.sql',
            sql: `CREATE TRIGGER active_records_limit
BEFORE INSERT ON records
WHEN (
  SELECT count(*)
  FROM records
  WHERE tenant_id = NEW.tenant_id
    AND user_id = NEW.user_id
    AND revoked_at IS NULL
) >= 10
BEGIN
  SELECT RAISE(ABORT, 'record_limit_exceeded');
END;`,
          },
          {
            file: '0005_trigger.sql',
            sql: `CREATE TRIGGER active_backup_codes
BEFORE INSERT ON backup_codes
BEGIN
  DELETE FROM backup_codes
  WHERE tenant_id = NEW.tenant_id
    AND user_id = NEW.user_id
    AND batch_id <> NEW.batch_id;
END;`,
          },
          {
            file: '0006_trigger.sql',
            sql: `CREATE TRIGGER memberships_seat_limit_before_update
BEFORE UPDATE OF status, tenant_id, org_id, user_id ON memberships
WHEN NEW.\`status\` = 'active'
 AND NOT EXISTS (
  SELECT 1
  FROM \`memberships\`
  WHERE \`memberships\`.\`tenant_id\` = NEW.\`tenant_id\`
    AND \`memberships\`.\`user_id\` = NEW.\`user_id\`
    AND \`memberships\`.\`status\` = 'active'
    AND \`memberships\`.\`id\` <> OLD.\`id\`
 )
 AND COALESCE((
  SELECT \`enforcement\`
  FROM \`organization_quotas\`
  WHERE \`tenant_id\` = NEW.\`tenant_id\`
    AND \`quota_key\` = 'seats'
 ), 'observe') = 'block_creation'
 AND (
  SELECT \`limit\`
  FROM \`organization_quotas\`
  WHERE \`tenant_id\` = NEW.\`tenant_id\`
    AND \`quota_key\` = 'seats'
 ) IS NOT NULL
 AND (
  SELECT COUNT(DISTINCT \`memberships\`.\`user_id\`)
  FROM \`memberships\`
  WHERE \`memberships\`.\`tenant_id\` = NEW.\`tenant_id\`
    AND \`memberships\`.\`status\` = 'active'
    AND \`memberships\`.\`id\` <> OLD.\`id\`
 ) >= (
  SELECT \`limit\`
  FROM \`organization_quotas\`
  WHERE \`tenant_id\` = NEW.\`tenant_id\`
    AND \`quota_key\` = 'seats'
 )
BEGIN
  SELECT RAISE(ABORT, 'seat_limit_exceeded');
END;`,
          },
        ],
        journalEntries: [
          { tag: '0001_add_column' },
          { tag: '0002_new_table' },
          { tag: '0003_index' },
          { tag: '0004_trigger' },
          { tag: '0005_trigger' },
          { tag: '0006_trigger' },
        ],
        snapshots: ['0001', '0002', '0003', '0004', '0005', '0006'].map((prefix) => ({
          file: `${prefix}_snapshot.json`,
          content: '{"dialect":"sqlite"}',
        })),
      }),
    ).not.toThrow()
  })

  it('accepts the exact abort-only resource quota trigger shape', () => {
    expect(() =>
      assertMigrationCompatibility(
        migrationSet(
          '0007_resource_quota.sql',
          `CREATE TRIGGER organizations_quota_before_insert
BEFORE INSERT ON \`organizations\`
WHEN NEW.\`parent_org_id\` IS NOT NULL
 AND NEW.\`deleted_at\` IS NULL
 AND COALESCE((
  SELECT \`enforcement\`
  FROM \`organization_quotas\`
  WHERE \`tenant_id\` = NEW.\`tenant_id\`
    AND \`quota_key\` = 'organizations'
 ), 'observe') = 'block_creation'
 AND (
  SELECT \`limit\`
  FROM \`organization_quotas\`
  WHERE \`tenant_id\` = NEW.\`tenant_id\`
    AND \`quota_key\` = 'organizations'
 ) IS NOT NULL
 AND (
  SELECT COUNT(*)
  FROM \`organizations\`
  WHERE \`tenant_id\` = NEW.\`tenant_id\`
    AND \`parent_org_id\` IS NOT NULL
    AND \`deleted_at\` IS NULL
 ) >= (
  SELECT \`limit\`
  FROM \`organization_quotas\`
  WHERE \`tenant_id\` = NEW.\`tenant_id\`
    AND \`quota_key\` = 'organizations'
 )
BEGIN
  SELECT RAISE(ABORT, 'resource_quota_exceeded');
END;`,
        ),
      ),
    ).not.toThrow()
  })

  it('accepts only the exact root seat quota compatibility backfill', () => {
    expect(() =>
      assertMigrationCompatibility(
        migrationSet(
          '0008_seat_quota_backfill.sql',
          `INSERT INTO \`organization_quotas\` (
  \`tenant_id\`, \`quota_key\`, \`limit\`, \`enforcement\`, \`updated_by\`, \`created_at\`, \`updated_at\`
)
SELECT
  \`organizations\`.\`tenant_id\`,
  'seats',
  \`organizations\`.\`seat_limit\`,
  'block_creation',
  NULL,
  \`organizations\`.\`created_at\`,
  \`organizations\`.\`updated_at\`
FROM \`organizations\`
WHERE \`organizations\`.\`parent_org_id\` IS NULL
ON CONFLICT (\`tenant_id\`, \`quota_key\`) DO NOTHING;`,
        ),
      ),
    ).not.toThrow()
  })

  it('accepts only the explicit legacy invitation cutover statements', () => {
    expect(() =>
      assertMigrationCompatibility(
        migrationSet(
          '0009_invitation_cutover.sql',
          `ALTER TABLE \`invitations\` ADD \`token_version\` text NOT NULL DEFAULT 'legacy';
UPDATE \`invitations\`
SET
  \`status\` = 'revoked',
  \`updated_at\` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE \`status\` = 'pending'
  AND \`token_version\` = 'legacy';
CREATE TRIGGER \`invitations_reject_legacy_pending_before_insert\`
BEFORE INSERT ON \`invitations\`
WHEN NEW.\`status\` = 'pending'
  AND NEW.\`token_version\` = 'legacy'
BEGIN
  SELECT RAISE(ABORT, 'legacy_invitation_token_disabled');
END;`,
        ),
      ),
    ).not.toThrow()
  })

  it('accepts only the exact invitation Email normalization and duplicate cutover', () => {
    expect(() =>
      assertMigrationCompatibility(
        migrationSet('0011_invitation_email_claim.sql', invitationEmailClaimCutoverSql),
      ),
    ).not.toThrow()
    expect(() =>
      assertMigrationCompatibility(
        migrationSet(
          '0011_invitation_email_claim.sql',
          invitationEmailClaimCutoverSql.replace(
            '`keeper`.`tenant_id` = `duplicate`.`tenant_id`',
            '`keeper`.`tenant_id` IS NOT NULL',
          ),
        ),
      ),
    ).toThrow('migration compatibility requires approved additive DDL only')
  })

  it('accepts only the exact redundant instance-manager deduplication', () => {
    const exact = `DELETE FROM \`manager_assignments\`
WHERE \`manager_role\` = 'instance_manager'
  AND \`scope_type\` = 'instance'
  AND \`scope_id\` IS NULL
  AND EXISTS (
    SELECT 1
    FROM \`manager_assignments\` AS \`retained\`
    WHERE \`retained\`.\`tenant_id\` = \`manager_assignments\`.\`tenant_id\`
      AND \`retained\`.\`user_id\` = \`manager_assignments\`.\`user_id\`
      AND \`retained\`.\`manager_role\` = \`manager_assignments\`.\`manager_role\`
      AND \`retained\`.\`scope_type\` = \`manager_assignments\`.\`scope_type\`
      AND \`retained\`.\`scope_id\` IS NULL
      AND \`retained\`.\`id\` < \`manager_assignments\`.\`id\`
  );`
    expect(() =>
      assertMigrationCompatibility(migrationSet('0008_manager_dedup.sql', exact)),
    ).not.toThrow()
    expect(() =>
      assertMigrationCompatibility(
        migrationSet(
          '0008_manager_dedup.sql',
          exact.replace(
            '`retained`.`tenant_id` = `manager_assignments`.`tenant_id`',
            '`retained`.`tenant_id` IS NOT NULL',
          ),
        ),
      ),
    ).toThrow('migration compatibility requires approved additive DDL only')
  })

  it('accepts only the exact SAML certificate status and active-certificate cutovers', () => {
    expect(() =>
      assertMigrationCompatibility(
        migrationSet('0009_saml_idp_certificate_uniqueness.sql', samlCertificateCutoverSql),
      ),
    ).not.toThrow()
  })

  it.each([
    [
      'a different target table',
      samlCertificateCutoverSql.replaceAll('`cert_store`', '`certificate_archive`'),
    ],
    [
      'a deduplication without tenant isolation',
      samlCertificateCutoverSql.replace(
        '    WHERE `retained`.`tenant_id` = `cert_store`.`tenant_id`\n',
        '',
      ),
    ],
    [
      'a deduplication without usage isolation',
      samlCertificateCutoverSql.replace(
        "WHERE `status` = 'active'\n  AND `usage` = 'saml_idp_signing'",
        "WHERE `status` = 'active'",
      ),
    ],
    [
      'a different destination status',
      samlCertificateCutoverSql.replaceAll("SET `status` = 'retiring'", "SET `status` = 'revoked'"),
    ],
    [
      'a different legacy source status',
      samlCertificateCutoverSql.replace(
        "WHERE `status` = 'expiring'\n  AND `usage` = 'saml_idp_signing'",
        "WHERE `status` = 'retired'\n  AND `usage` = 'saml_idp_signing'",
      ),
    ],
    [
      'a legacy SP backfill without explicit usages',
      samlCertificateCutoverSql.replace(
        "  AND `usage` IN ('saml_sp_signing', 'saml_sp_encryption')",
        '',
      ),
    ],
    [
      'a different active source status',
      samlCertificateCutoverSql.replace(
        "WHERE `status` = 'active'\n  AND `usage` = 'saml_idp_signing'",
        "WHERE `status` = 'retiring'\n  AND `usage` = 'saml_idp_signing'",
      ),
    ],
  ])('rejects SAML certificate cutover with %s', (_case, sql) => {
    expect(() =>
      assertMigrationCompatibility(migrationSet('0009_saml_idp_certificate_uniqueness.sql', sql)),
    ).toThrow('migration compatibility requires approved additive DDL only')
  })

  it.each([
    "INSERT INTO users (id) VALUES ('user_1');",
    "UPDATE users SET locale = 'en';",
    'DELETE FROM users;',
    "REPLACE INTO users (id) VALUES ('user_1');",
    'CREATE TRIGGER audit_users AFTER INSERT ON users BEGIN SELECT 1; END;',
    'CREATE TRIGGER unsafe BEFORE INSERT ON users BEGIN DELETE FROM users WHERE id = NEW.id; END;',
    'DROP TABLE users;',
    'DROP TABLE IF EXISTS users;',
    'DROP INDEX users_locale_idx;',
    'ALTER TABLE users DROP COLUMN status;',
    'ALTER TABLE users RENAME COLUMN locale TO language;',
    'ALTER TABLE users ADD COLUMN foo text NOT NULL;',
    'ALTER TABLE users ADD COLUMN bar text UNIQUE;',
    'CREATE TABLE users_copy AS SELECT * FROM users;',
    'CREATE VIRTUAL TABLE search USING fts5(body);',
  ])('rejects non-additive or unsafe SQL: %s', (sql) => {
    expect(() => assertMigrationCompatibility(migrationSet('0099_bad.sql', sql))).toThrow(
      'migration compatibility requires approved additive DDL only',
    )
  })

  it('rejects a data or index migration regardless of filename', () => {
    expect(() =>
      assertMigrationCompatibility(
        migrationSet('0008_aspiring_reaper.sql', 'DROP INDEX users_tenant_username_unq;'),
      ),
    ).toThrow('migration compatibility requires approved additive DDL only')
  })

  it('accepts an approved drop migration once the drizzle schema no longer declares the table', () => {
    expect(() =>
      assertMigrationCompatibility({
        ...migrationSet(
          '0001_drop_legacy_table.sql',
          'DROP TABLE IF EXISTS `legacy_table`;\n--> statement-breakpoint\nDROP TABLE IF EXISTS `legacy_shadow_table`;',
        ),
        schemaTableNames: new Set(['users']),
        approvedTableDrops,
      }),
    ).not.toThrow()
  })

  it('ships with an empty approved drop list so no table drop passes by default', () => {
    expect(() =>
      assertMigrationCompatibility({
        ...migrationSet('0001_drop_legacy_table.sql', 'DROP TABLE IF EXISTS `legacy_table`;'),
        schemaTableNames: new Set(),
      }),
    ).toThrow('migration compatibility requires approved additive DDL only')
  })

  it.each([
    ['an unapproved table', 'DROP TABLE IF EXISTS `users`;'],
    ['a missing IF EXISTS guard', 'DROP TABLE `legacy_table`;'],
    [
      'a bundled additive statement',
      'DROP TABLE IF EXISTS `legacy_table`;\nCREATE INDEX users_locale_idx ON users (locale);',
    ],
    [
      'a bundled index drop',
      'DROP TABLE IF EXISTS `legacy_table`;\nDROP INDEX legacy_table_key_unq;',
    ],
  ])('rejects a drop migration with %s', (_case, sql) => {
    expect(() =>
      assertMigrationCompatibility({
        ...migrationSet('0001_drop_legacy_table.sql', sql),
        schemaTableNames: new Set(),
        approvedTableDrops,
      }),
    ).toThrow('migration compatibility requires approved additive DDL only')
  })

  it('rejects an approved drop hidden outside a NNNN_drop_*.sql migration', () => {
    expect(() =>
      assertMigrationCompatibility({
        ...migrationSet('0001_cleanup.sql', 'DROP TABLE IF EXISTS `legacy_table`;'),
        schemaTableNames: new Set(),
        approvedTableDrops,
      }),
    ).toThrow('approved table drops require a NNNN_drop_*.sql migration')
  })

  it('rejects dropping a table the drizzle schema still declares', () => {
    expect(() =>
      assertMigrationCompatibility({
        ...migrationSet('0001_drop_legacy_table.sql', 'DROP TABLE IF EXISTS `legacy_table`;'),
        schemaTableNames: new Set(['legacy_table']),
        approvedTableDrops,
      }),
    ).toThrow('drizzle schema still declares dropped table legacy_table')
  })

  it('rejects missing journal SQL pairs', () => {
    expect(() =>
      assertMigrationMetadata({
        migrations: [],
        journalEntries: [{ tag: '0001_ghost' }],
        snapshots: [],
      }),
    ).toThrow('migration journal references missing SQL file')
  })

  it('rejects an unjournaled migration regardless of filename', () => {
    expect(() =>
      assertMigrationMetadata({
        migrations: [{ file: '0018_saml_slo.sql', sql: 'CREATE TABLE records (id text);' }],
        journalEntries: [],
        snapshots: [{ file: '0018_snapshot.json', content: '{"dialect":"sqlite"}' }],
      }),
    ).toThrow('migration SQL is missing a journal entry')
  })

  it.each(['0001_first_after_baseline.sql', '0017_scim_targets.sql'])(
    'requires a Drizzle snapshot for every migration: %s',
    (file) => {
      expect(() =>
        assertMigrationMetadata({
          migrations: [{ file, sql: 'CREATE TABLE records (id text);' }],
          journalEntries: [{ tag: file.replace(/\.sql$/u, '') }],
          snapshots: [],
        }),
      ).toThrow('migration requires a Drizzle snapshot')
    },
  )
})
