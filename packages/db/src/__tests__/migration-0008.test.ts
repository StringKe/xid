import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import migration from '../../drizzle/0008_control-plane-projects.sql?raw'

function legacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE manager_assignments (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      manager_role TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT
    );
    CREATE UNIQUE INDEX manager_assignments_unq
      ON manager_assignments (user_id, manager_role, scope_type, scope_id);

    CREATE TABLE role_permissions (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      permission_id TEXT NOT NULL
    );
    CREATE UNIQUE INDEX role_permissions_role_perm_unq
      ON role_permissions (role_id, permission_id);

    CREATE TABLE projects (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return db
}

describe('0008_control-plane-projects migration', () => {
  it('deduplicates legacy null-scope instance managers before enforcing uniqueness', () => {
    const db = legacyDatabase()
    db.exec(`
      INSERT INTO manager_assignments
        (id, tenant_id, user_id, manager_role, scope_type, scope_id)
      VALUES
        ('mgr_b', 'tenant_a', 'user_a', 'instance_manager', 'instance', NULL),
        ('mgr_a', 'tenant_a', 'user_a', 'instance_manager', 'instance', NULL);
    `)

    db.exec(migration)

    expect(
      db
        .prepare(
          `SELECT id FROM manager_assignments
           WHERE tenant_id = ? AND user_id = ? ORDER BY id`,
        )
        .all('tenant_a', 'user_a'),
    ).toEqual([{ id: 'mgr_a' }])
    expect(() =>
      db
        .prepare(
          `INSERT INTO manager_assignments
            (id, tenant_id, user_id, manager_role, scope_type, scope_id)
           VALUES (?, ?, ?, 'instance_manager', 'instance', NULL)`,
        )
        .run('mgr_c', 'tenant_a', 'user_a'),
    ).toThrow()
    expect(() =>
      db
        .prepare(
          `INSERT INTO manager_assignments
            (id, tenant_id, user_id, manager_role, scope_type, scope_id)
           VALUES (?, ?, ?, 'instance_manager', 'instance', NULL)`,
        )
        .run('mgr_c', 'tenant_b', 'user_a'),
    ).not.toThrow()

    db.close()
  })

  it('adds Project lifecycle columns and tenant-first control-plane uniqueness', () => {
    const db = legacyDatabase()
    db.exec(migration)

    db.prepare(
      `INSERT INTO projects
        (id, tenant_id, org_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 1, 1)`,
    ).run('proj_a', 'tenant_a', 'org_a', 'Project A')
    expect(
      db.prepare('SELECT status, deleted_at FROM projects WHERE id = ?').get('proj_a'),
    ).toEqual({ status: 'active', deleted_at: null })

    db.prepare(
      `INSERT INTO role_permissions (id, tenant_id, role_id, permission_id)
       VALUES (?, ?, ?, ?)`,
    ).run('rp_a', 'tenant_a', 'role_a', 'perm_a')
    expect(() =>
      db
        .prepare(
          `INSERT INTO role_permissions (id, tenant_id, role_id, permission_id)
           VALUES (?, ?, ?, ?)`,
        )
        .run('rp_b', 'tenant_a', 'role_a', 'perm_a'),
    ).toThrow()
    const indexSql = db
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'index'
           AND name IN (
             'manager_assignments_unq',
             'manager_assignments_tenant_scope_unq',
             'manager_assignments_instance_unq',
             'role_permissions_role_perm_unq',
             'role_permissions_tenant_role_perm_unq'
           )
         ORDER BY name`,
      )
      .all()
    expect(indexSql).toHaveLength(5)
    expect(indexSql).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'manager_assignments_tenant_scope_unq',
          sql: expect.stringContaining(
            '(`tenant_id`,`user_id`,`manager_role`,`scope_type`,`scope_id`)',
          ),
        }),
        expect.objectContaining({
          name: 'role_permissions_tenant_role_perm_unq',
          sql: expect.stringContaining('(`tenant_id`,`role_id`,`permission_id`)'),
        }),
      ]),
    )

    db.close()
  })
})
