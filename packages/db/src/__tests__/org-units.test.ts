// OrgUnit 服务层:真 SQLite + 全量 migration,覆盖树/主岗/经理/TOCTOU/跨租户(设计 6)。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { TenantContext } from '@xid-kit/types'
import {
  addUnitMember,
  archiveUnit,
  createUnit,
  listSubtreeMembers,
  listTree,
  moveUnit,
  resolveApproverChain,
  setPrimaryUnit,
  updateUnit,
  type OrgUnitRow,
  type OrgUnitScope,
} from '../org-units'
import { SqliteD1 } from './sqlite-d1'

const migrationDir = fileURLToPath(new URL('../../drizzle/', import.meta.url))

function applyMigrations(db: DatabaseSync): void {
  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(migrationDir, file), 'utf8'))
  }
}

function makeCtx(tenantId: string): TenantContext {
  return {
    tenantId,
    issuer: 'https://xid.test',
    rpId: `${tenantId}.xid.test`,
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: {},
  }
}

const TENANT = 'tenant_a'
const ORG = 'org_a'

function makeScopeIn(sqlite: SqliteD1, tenantId: string, orgId: string): OrgUnitScope {
  return {
    d1: sqlite as unknown as D1Database,
    ctx: makeCtx(tenantId),
    orgId,
  }
}

function makeScope(): OrgUnitScope & { sqlite: SqliteD1 } {
  const sqlite = new SqliteD1()
  applyMigrations(sqlite.database)
  return { sqlite, ...makeScopeIn(sqlite, TENANT, ORG) }
}

function seedMembership(
  sqlite: SqliteD1,
  input: { id: string; userId: string; status?: string; tenantId?: string; orgId?: string },
): void {
  sqlite.database
    .prepare(
      `INSERT INTO memberships (id, tenant_id, org_id, user_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1000, 1000)`,
    )
    .run(
      input.id,
      input.tenantId ?? TENANT,
      input.orgId ?? ORG,
      input.userId,
      input.status ?? 'active',
    )
}

async function mustUnit(
  result: Promise<{ ok: boolean; value?: OrgUnitRow; error?: { message: string } }>,
): Promise<OrgUnitRow> {
  const resolved = await result
  if (!resolved.ok || !resolved.value) {
    throw new Error(`expected ok result, got ${resolved.error?.message ?? 'unknown'}`)
  }
  return resolved.value
}

async function buildChain(scope: OrgUnitScope, depth: number): Promise<OrgUnitRow[]> {
  const chain: OrgUnitRow[] = []
  for (let level = 1; level <= depth; level += 1) {
    const parent = chain[chain.length - 1]
    const unit = await mustUnit(
      createUnit(scope, {
        parentUnitId: parent?.id,
        slug: `level-${level}`,
        name: `Level ${level}`,
      }),
    )
    chain.push(unit)
  }
  return chain
}

describe('org-units service', () => {
  it('creates a 3-level tree and listTree returns path lexicographic order', async () => {
    const scope = makeScope()
    const root = await mustUnit(createUnit(scope, { slug: 'company', name: 'Company' }))
    const eng = await mustUnit(
      createUnit(scope, { parentUnitId: root.id, slug: 'engineering', name: 'Engineering' }),
    )
    const fe = await mustUnit(
      createUnit(scope, { parentUnitId: eng.id, slug: 'frontend', name: 'Frontend' }),
    )
    expect(root.depth).toBe(1)
    expect(root.path).toBe(`/${root.id}`)
    expect(eng.depth).toBe(2)
    expect(eng.path).toBe(`${root.path}/${eng.id}`)
    expect(fe.depth).toBe(3)
    expect(fe.path).toBe(`${eng.path}/${fe.id}`)

    const tree = await listTree(scope)
    expect(tree.map((row) => row.id).sort()).toEqual([root.id, eng.id, fe.id].sort())
    // path 字典序 = 先根遍历,父节点先于子节点。
    const paths = tree.map((row) => row.path)
    expect(paths).toEqual([...paths].sort())
    expect(paths.indexOf(root.path)).toBeLessThan(paths.indexOf(eng.path))
    expect(paths.indexOf(eng.path)).toBeLessThan(paths.indexOf(fe.path))
  })

  it('rejects creating a 9th level unit (depth limit 8)', async () => {
    const scope = makeScope()
    const chain = await buildChain(scope, 8)
    const deepest = chain[chain.length - 1] as OrgUnitRow
    const result = await createUnit(scope, {
      parentUnitId: deepest.id,
      slug: 'level-9',
      name: 'Level 9',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('unprocessable_entity')
  })

  it('rejects sibling slug conflicts with already_exists', async () => {
    const scope = makeScope()
    const root = await mustUnit(createUnit(scope, { slug: 'company', name: 'Company' }))
    await mustUnit(
      createUnit(scope, { parentUnitId: root.id, slug: 'engineering', name: 'Engineering' }),
    )
    const conflict = await createUnit(scope, {
      parentUnitId: root.id,
      slug: 'engineering',
      name: 'Engineering 2',
    })
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) expect(conflict.error.code).toBe('already_exists')

    const other = await mustUnit(
      createUnit(scope, { parentUnitId: root.id, slug: 'sales', name: 'Sales' }),
    )
    const rename = await updateUnit(scope, other.id, { slug: 'engineering' })
    expect(rename.ok).toBe(false)
    if (!rename.ok) expect(rename.error.code).toBe('already_exists')
  })

  it('rewrites path and depth for the whole subtree on move', async () => {
    const scope = makeScope()
    const root = await mustUnit(createUnit(scope, { slug: 'company', name: 'Company' }))
    const a = await mustUnit(createUnit(scope, { parentUnitId: root.id, slug: 'a', name: 'A' }))
    const b = await mustUnit(createUnit(scope, { parentUnitId: a.id, slug: 'b', name: 'B' }))
    const c = await mustUnit(createUnit(scope, { parentUnitId: b.id, slug: 'c', name: 'C' }))
    const x = await mustUnit(createUnit(scope, { parentUnitId: root.id, slug: 'x', name: 'X' }))

    const moved = await moveUnit(scope, a.id, x.id)
    expect(moved.ok).toBe(true)

    const tree = await listTree(scope)
    const byId = new Map(tree.map((row) => [row.id, row]))
    const aAfter = byId.get(a.id) as OrgUnitRow
    const bAfter = byId.get(b.id) as OrgUnitRow
    const cAfter = byId.get(c.id) as OrgUnitRow
    expect(aAfter.parentUnitId).toBe(x.id)
    expect(aAfter.path).toBe(`${x.path}/${a.id}`)
    expect(aAfter.depth).toBe(3)
    expect(bAfter.parentUnitId).toBe(a.id)
    expect(bAfter.path).toBe(`${x.path}/${a.id}/${b.id}`)
    expect(bAfter.depth).toBe(4)
    expect(cAfter.path).toBe(`${x.path}/${a.id}/${b.id}/${c.id}`)
    expect(cAfter.depth).toBe(5)
  })

  it('rejects moving a unit into itself or its descendant', async () => {
    const scope = makeScope()
    const chain = await buildChain(scope, 3)
    const [root, mid, leaf] = chain as [OrgUnitRow, OrgUnitRow, OrgUnitRow]
    const intoItself = await moveUnit(scope, root.id, root.id)
    expect(intoItself.ok).toBe(false)
    if (!intoItself.ok) expect(intoItself.error.code).toBe('conflict')
    const intoDescendant = await moveUnit(scope, root.id, leaf.id)
    expect(intoDescendant.ok).toBe(false)
    if (!intoDescendant.ok) expect(intoDescendant.error.code).toBe('conflict')
    expect(mid.parentUnitId).toBe(root.id)
  })

  it('rejects a move that would exceed the depth limit', async () => {
    const scope = makeScope()
    const deepChain = await buildChain(scope, 8)
    const deepest = deepChain[deepChain.length - 1] as OrgUnitRow
    const [sub] = await buildChain(scope, 2)
    const subtree = sub as OrgUnitRow
    // 高 2 子树挂到 depth 8 下会超限。
    const result = await moveUnit(scope, subtree.id, deepest.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('unprocessable_entity')
  })

  it('keeps exactly one primary unit per user across set operations', async () => {
    const scope = makeScope()
    seedMembership(scope.sqlite, { id: 'mem_u1', userId: 'user_1' })
    const unitA = await mustUnit(createUnit(scope, { slug: 'a', name: 'A' }))
    const unitB = await mustUnit(createUnit(scope, { slug: 'b', name: 'B' }))

    const first = await addUnitMember(scope, unitA.id, 'user_1', { isPrimary: true })
    expect(first.ok).toBe(true)
    const second = await addUnitMember(scope, unitB.id, 'user_1', { isPrimary: true })
    expect(second.ok).toBe(true)

    const primaries = (): number => {
      const row = scope.sqlite.database
        .prepare(
          `SELECT count(*) AS n FROM org_unit_members
            WHERE tenant_id = ? AND org_id = ? AND user_id = ? AND is_primary = 1`,
        )
        .get(TENANT, ORG, 'user_1') as { n: number }
      return row.n
    }
    const flagOf = (unitId: string): number => {
      const row = scope.sqlite.database
        .prepare(`SELECT is_primary AS p FROM org_unit_members WHERE unit_id = ? AND user_id = ?`)
        .get(unitId, 'user_1') as { p: number }
      return row.p
    }
    expect(primaries()).toBe(1)
    expect(flagOf(unitA.id)).toBe(0)
    expect(flagOf(unitB.id)).toBe(1)

    const back = await setPrimaryUnit(scope, unitA.id, 'user_1')
    expect(back.ok).toBe(true)
    expect(primaries()).toBe(1)
    expect(flagOf(unitA.id)).toBe(1)
    expect(flagOf(unitB.id)).toBe(0)

    // partial unique 兜底:直接双主岗 INSERT 必须失败。
    expect(() =>
      scope.sqlite.database
        .prepare(
          `INSERT INTO org_unit_members
             (id, tenant_id, org_id, unit_id, user_id, is_primary, created_at, updated_at)
           VALUES ('oum_dup', ?, ?, ?, 'user_1', 1, 1000, 1000)`,
        )
        .run(TENANT, ORG, unitB.id),
    ).toThrow(/UNIQUE constraint failed/)
  })

  it('resolves the nearest manager up the primary unit chain', async () => {
    const scope = makeScope()
    seedMembership(scope.sqlite, { id: 'mem_u2', userId: 'user_2' })
    const root = await mustUnit(
      createUnit(scope, { slug: 'company', name: 'Company', managerUserId: 'mgr_root' }),
    )
    const mid = await mustUnit(
      createUnit(scope, {
        parentUnitId: root.id,
        slug: 'eng',
        name: 'Engineering',
        managerUserId: 'mgr_mid',
      }),
    )
    const leaf = await mustUnit(
      createUnit(scope, { parentUnitId: mid.id, slug: 'fe', name: 'Frontend' }),
    )
    const added = await addUnitMember(scope, leaf.id, 'user_2', { isPrimary: true })
    expect(added.ok).toBe(true)

    expect(await resolveApproverChain(scope, 'user_2')).toEqual({
      managerUserId: 'mgr_mid',
      viaUnitId: mid.id,
      depth: 2,
    })

    const cleared = await updateUnit(scope, mid.id, { managerUserId: null })
    expect(cleared.ok).toBe(true)
    expect(await resolveApproverChain(scope, 'user_2')).toEqual({
      managerUserId: 'mgr_root',
      viaUnitId: root.id,
      depth: 1,
    })

    // archived 节点跳过,解析落到 root。
    const withManager = await updateUnit(scope, leaf.id, { managerUserId: 'mgr_leaf' })
    expect(withManager.ok).toBe(true)
    expect((await resolveApproverChain(scope, 'user_2'))?.managerUserId).toBe('mgr_leaf')
    const archived = await archiveUnit(scope, leaf.id)
    expect(archived.ok).toBe(true)
    expect((await resolveApproverChain(scope, 'user_2'))?.managerUserId).toBe('mgr_root')
  })

  it('returns null when the whole chain has no manager or no primary unit', async () => {
    const scope = makeScope()
    seedMembership(scope.sqlite, { id: 'mem_u3', userId: 'user_3' })
    const [root, leaf] = (await buildChain(scope, 2)) as [OrgUnitRow, OrgUnitRow]
    expect(await resolveApproverChain(scope, 'user_3')).toBeNull()
    const added = await addUnitMember(scope, leaf.id, 'user_3', { isPrimary: true })
    expect(added.ok).toBe(true)
    expect(root.managerUserId).toBeNull()
    expect(await resolveApproverChain(scope, 'user_3')).toBeNull()
  })

  it('rejects adding a user without an active membership to a unit', async () => {
    const scope = makeScope()
    seedMembership(scope.sqlite, { id: 'mem_u4', userId: 'user_4' })
    seedMembership(scope.sqlite, { id: 'mem_u5', userId: 'user_5', status: 'suspended' })
    const unit = await mustUnit(createUnit(scope, { slug: 'a', name: 'A' }))

    const noMembership = await addUnitMember(scope, unit.id, 'user_ghost')
    expect(noMembership.ok).toBe(false)
    if (!noMembership.ok) expect(noMembership.error.code).toBe('membership_not_found')

    const suspended = await addUnitMember(scope, unit.id, 'user_5')
    expect(suspended.ok).toBe(false)
    if (!suspended.ok) expect(suspended.error.code).toBe('membership_not_found')

    const active = await addUnitMember(scope, unit.id, 'user_4')
    expect(active.ok).toBe(true)
  })

  it('lists subtree members with active membership only and excludes archived units', async () => {
    const scope = makeScope()
    seedMembership(scope.sqlite, { id: 'mem_u6', userId: 'user_6' })
    seedMembership(scope.sqlite, { id: 'mem_u7', userId: 'user_7' })
    seedMembership(scope.sqlite, { id: 'mem_u8', userId: 'user_8', status: 'suspended' })
    const [root, leaf] = (await buildChain(scope, 2)) as [OrgUnitRow, OrgUnitRow]
    expect((await addUnitMember(scope, root.id, 'user_6')).ok).toBe(true)
    expect((await addUnitMember(scope, leaf.id, 'user_7', { isPrimary: true })).ok).toBe(true)

    const members = await listSubtreeMembers(scope, root.id)
    expect(members.ok).toBe(true)
    if (members.ok) {
      expect(members.value.map((row) => row.userId).sort()).toEqual(['user_6', 'user_7'])
    }

    // 悬挂成员行(无 active membership)经 join 过滤不可见。
    scope.sqlite.database
      .prepare(
        `INSERT INTO org_unit_members
           (id, tenant_id, org_id, unit_id, user_id, is_primary, created_at, updated_at)
         VALUES ('oum_dangling', ?, ?, ?, 'user_8', 0, 1000, 1000)`,
      )
      .run(TENANT, ORG, leaf.id)
    const withDangling = await listSubtreeMembers(scope, root.id)
    expect(withDangling.ok).toBe(true)
    if (withDangling.ok) {
      expect(withDangling.value.map((row) => row.userId).sort()).toEqual(['user_6', 'user_7'])
    }

    expect((await archiveUnit(scope, leaf.id)).ok).toBe(true)
    const afterArchive = await listSubtreeMembers(scope, root.id)
    expect(afterArchive.ok).toBe(true)
    if (afterArchive.ok) {
      expect(afterArchive.value.map((row) => row.userId)).toEqual(['user_6'])
    }
  })

  // 包装 d1 在 batch 前改 path,验证 TOCTOU 守卫返回 409 且不半重写。
  it('returns conflict when the node path changes concurrently during move (TOCTOU guard)', async () => {
    const scope = makeScope()
    const root = await mustUnit(createUnit(scope, { slug: 'company', name: 'Company' }))
    const a = await mustUnit(createUnit(scope, { parentUnitId: root.id, slug: 'a', name: 'A' }))
    const b = await mustUnit(createUnit(scope, { parentUnitId: a.id, slug: 'b', name: 'B' }))
    const x = await mustUnit(createUnit(scope, { parentUnitId: root.id, slug: 'x', name: 'X' }))

    const concurrentD1 = {
      prepare: (query: string) => scope.d1.prepare(query),
      batch: async (statements: D1PreparedStatement[]) => {
        scope.sqlite.database
          .prepare(`UPDATE org_units SET path = ? WHERE tenant_id = ? AND id = ?`)
          .run(`${a.path}/concurrent`, TENANT, a.id)
        return scope.d1.batch(statements)
      },
    } as unknown as D1Database

    const result = await moveUnit({ ...scope, d1: concurrentD1 }, a.id, x.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('conflict')

    const tree = await listTree(scope)
    const byId = new Map(tree.map((row) => [row.id, row]))
    const aAfter = byId.get(a.id) as OrgUnitRow
    const bAfter = byId.get(b.id) as OrgUnitRow
    expect(aAfter.parentUnitId).toBe(root.id)
    expect(aAfter.path).toBe(`${a.path}/concurrent`)
    expect(bAfter.path).toBe(b.path)
  })

  // create 的 EXISTS 守卫:parent path 并发变更 -> 409,无孤儿节点。
  it('returns conflict when the parent path changes concurrently during create (TOCTOU guard)', async () => {
    const scope = makeScope()
    const root = await mustUnit(createUnit(scope, { slug: 'company', name: 'Company' }))

    const concurrentD1 = {
      prepare: (query: string) => {
        const statement = scope.d1.prepare(query)
        if (!query.startsWith('INSERT INTO org_units')) return statement
        return {
          bind: (...bindings: unknown[]) => {
            const bound = statement.bind(...bindings)
            return {
              run: async () => {
                scope.sqlite.database
                  .prepare(`UPDATE org_units SET path = ? WHERE tenant_id = ? AND id = ?`)
                  .run(`${root.path}/concurrent`, TENANT, root.id)
                return bound.run()
              },
              all: () => bound.all(),
              first: () => bound.first(),
              raw: () => bound.raw(),
            }
          },
        }
      },
    } as unknown as D1Database

    const result = await createUnit(
      { ...scope, d1: concurrentD1 },
      { parentUnitId: root.id, slug: 'eng', name: 'Engineering' },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('conflict')

    const tree = await listTree(scope)
    expect(tree.map((row) => row.id)).toEqual([root.id])
  })

  it('isolates units and members across tenants', async () => {
    const scope = makeScope()
    const scopeB = makeScopeIn(scope.sqlite, 'tenant_b', ORG)
    const root = await mustUnit(createUnit(scope, { slug: 'company', name: 'Company' }))
    const eng = await mustUnit(
      createUnit(scope, { parentUnitId: root.id, slug: 'eng', name: 'Engineering' }),
    )
    seedMembership(scope.sqlite, { id: 'mem_a', userId: 'user_a' })
    seedMembership(scope.sqlite, { id: 'mem_b', userId: 'user_b', tenantId: 'tenant_b' })
    expect((await addUnitMember(scope, eng.id, 'user_a')).ok).toBe(true)

    expect(await listTree(scopeB)).toEqual([])
    const subtreeB = await listSubtreeMembers(scopeB, eng.id)
    expect(subtreeB.ok).toBe(false)

    const createB = await createUnit(scopeB, { parentUnitId: root.id, slug: 'x', name: 'X' })
    expect(createB.ok).toBe(false)
    if (!createB.ok) expect(createB.error.code).toBe('not_found')
    const updateB = await updateUnit(scopeB, eng.id, { name: 'hijack' })
    expect(updateB.ok).toBe(false)
    const moveB = await moveUnit(scopeB, eng.id, root.id)
    expect(moveB.ok).toBe(false)
    const addB = await addUnitMember(scopeB, eng.id, 'user_b')
    expect(addB.ok).toBe(false)

    const engAfter = (await listTree(scope)).find((row) => row.id === eng.id) as OrgUnitRow
    expect(engAfter.name).toBe('Engineering')
    const membersA = await listSubtreeMembers(scope, root.id)
    expect(membersA.ok).toBe(true)
    if (membersA.ok) expect(membersA.value.map((row) => row.userId)).toEqual(['user_a'])
  })
})
