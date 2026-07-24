import { describe, expect, it } from 'vitest'
import {
  assertMigrationCompatibility,
  assertMigrationMetadata,
} from '../assert-migration-compatibility.mjs'

function journal(tag) {
  return [{ tag }]
}

function snapshot(prefix) {
  return [{ file: `${prefix}_snapshot.json`, content: '{"dialect":"sqlite"}' }]
}

describe('migration compatibility gate', () => {
  it('accepts committed migrations and additive DDL', () => {
    expect(() => assertMigrationCompatibility()).not.toThrow()
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
        snapshots: [
          ...snapshot('0001'),
          ...snapshot('0002'),
          ...snapshot('0003'),
          ...snapshot('0004'),
          ...snapshot('0005'),
        ],
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
    'DROP INDEX users_locale_idx;',
    'ALTER TABLE users DROP COLUMN locale;',
    'ALTER TABLE users RENAME COLUMN locale TO language;',
    'ALTER TABLE users ADD locale text NOT NULL;',
    'CREATE TABLE users_copy AS SELECT * FROM users;',
    'CREATE VIRTUAL TABLE search USING fts5(body);',
  ])('rejects non-additive or unsafe SQL: %s', (sql) => {
    expect(() =>
      assertMigrationCompatibility({
        migrations: [{ file: '0099_bad.sql', sql }],
        journalEntries: journal('0099_bad'),
        snapshots: [],
      }),
    ).toThrow('migration compatibility requires approved additive DDL only')
  })

  it('rejects a modified approved legacy migration', () => {
    expect(() =>
      assertMigrationCompatibility({
        migrations: [
          {
            file: '0008_aspiring_reaper.sql',
            sql: 'DROP INDEX users_tenant_username_unq;',
          },
        ],
        journalEntries: journal('0008_aspiring_reaper'),
        snapshots: snapshot('0008'),
      }),
    ).toThrow('migration compatibility requires approved additive DDL only')
  })

  it('rejects missing journal SQL pairs and unjournaled new migrations', () => {
    expect(() =>
      assertMigrationMetadata({
        migrations: [],
        journalEntries: journal('0001_closed_frightful_four'),
        snapshots: [],
      }),
    ).toThrow('migration journal references missing SQL file')

    expect(() =>
      assertMigrationMetadata({
        migrations: [{ file: '0028_missing_journal.sql', sql: 'CREATE TABLE records (id text);' }],
        journalEntries: [],
        snapshots: [],
      }),
    ).toThrow('migration SQL is missing a journal entry')
  })

  it('keeps the historical snapshot policy explicit', () => {
    expect(() =>
      assertMigrationMetadata({
        migrations: [
          { file: '0001_closed_frightful_four.sql', sql: 'CREATE TABLE records (id text);' },
        ],
        journalEntries: journal('0001_closed_frightful_four'),
        snapshots: [],
      }),
    ).toThrow('migration requires a Drizzle snapshot')

    expect(() =>
      assertMigrationMetadata({
        migrations: [{ file: '0017_scim_targets.sql', sql: 'CREATE TABLE records (id text);' }],
        journalEntries: journal('0017_scim_targets'),
        snapshots: [],
      }),
    ).not.toThrow()
  })
})
