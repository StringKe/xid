// Outbound SCIM mapping migration:stable identity keys are tenant-first and additive.
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migrationDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'packages',
  'db',
  'drizzle',
)

function applyAll(db) {
  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(migrationDir, file), 'utf8'))
  }
}

function insertMapping(db, { id, tenantId, targetId, downstreamId }) {
  db.prepare(
    `INSERT INTO scim_target_resources
      (id, tenant_id, org_id, target_id, resource_type, local_resource_id, external_id,
       downstream_id, status, last_synced_at, created_at, updated_at)
     VALUES (?, ?, 'org_1', ?, 'User', 'user_1', 'user_1', ?, 'active', 1000, 1000, 1000)`,
  ).run(id, tenantId, targetId, downstreamId)
}

describe('migration 0002 outbound SCIM resources', () => {
  it('空库全量 apply 后包含 stable mapping 字段和三个索引', () => {
    const db = new DatabaseSync(':memory:')
    applyAll(db)

    const columns = db
      .prepare(`PRAGMA table_info('scim_target_resources')`)
      .all()
      .map((column) => column.name)
    expect(columns).toEqual([
      'id',
      'tenant_id',
      'org_id',
      'target_id',
      'resource_type',
      'local_resource_id',
      'external_id',
      'downstream_id',
      'status',
      'last_synced_at',
      'created_at',
      'updated_at',
    ])
    const indexes = db
      .prepare(`PRAGMA index_list('scim_target_resources')`)
      .all()
      .map((index) => index.name)
    expect(indexes).toEqual(
      expect.arrayContaining([
        'scim_target_resources_local_unq',
        'scim_target_resources_downstream_unq',
        'scim_target_resources_tenant_org_target_status_id_idx',
      ]),
    )
    db.close()
  })

  it('同一 tenant/target/local resource 拒绝重复,不同 tenant 可复用 local id', () => {
    const db = new DatabaseSync(':memory:')
    applyAll(db)
    insertMapping(db, {
      id: 'map_1',
      tenantId: 'tenant_1',
      targetId: 'target_1',
      downstreamId: 'down_1',
    })

    expect(() =>
      insertMapping(db, {
        id: 'map_2',
        tenantId: 'tenant_1',
        targetId: 'target_1',
        downstreamId: 'down_2',
      }),
    ).toThrow()
    expect(() =>
      insertMapping(db, {
        id: 'map_3',
        tenantId: 'tenant_2',
        targetId: 'target_1',
        downstreamId: 'down_1',
      }),
    ).not.toThrow()
    db.close()
  })
})
