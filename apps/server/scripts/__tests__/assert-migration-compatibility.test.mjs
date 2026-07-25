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
        ],
        journalEntries: [
          { tag: '0001_add_column' },
          { tag: '0002_new_table' },
          { tag: '0003_index' },
          { tag: '0004_trigger' },
          { tag: '0005_trigger' },
        ],
        snapshots: ['0001', '0002', '0003', '0004', '0005'].map((prefix) => ({
          file: `${prefix}_snapshot.json`,
          content: '{"dialect":"sqlite"}',
        })),
      }),
    ).not.toThrow()
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
