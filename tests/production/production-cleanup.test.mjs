import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  assertNoSmokeResidue,
  assertSmokePrefix,
  CLEANUP_SIGNALS,
  registerCleanupSignalHandlers,
  runCleanupSteps,
  SMOKE_ID_PREFIXES,
  SMOKE_SWEEP_MAX_ROWS,
  smokePrefixPredicate,
  smokeResidueCountSql,
  smokeResidueDeleteSql,
  smokeResidueProbeSql,
  smokeSweepTables,
  sweepSmokeResidue,
} from './harness/production-auth.mjs'

function fakeStderr() {
  const lines = []
  return { lines, write: (line) => lines.push(line) }
}

function countRow(overrides = {}) {
  const row = {}
  for (const entry of smokeSweepTables()) row[entry.table] = 0
  row.smoke_instance_manager = 0
  return { ...row, ...overrides }
}

function fakeExec({ before, after, probe = [] } = {}) {
  const calls = []
  let countCalls = 0
  const exec = async (sql, name) => {
    calls.push({ sql, name })
    if (sql.includes('AS smoke_instance_manager')) {
      countCalls += 1
      return [countCalls === 1 ? (before ?? countRow()) : (after ?? countRow())]
    }
    if (sql.includes('AS source')) return probe
    return []
  }
  return { exec, calls }
}

function deletedTables(calls) {
  return calls
    .filter((call) => call.sql.startsWith('DELETE FROM'))
    .flatMap((call) => call.sql.split('\n'))
    .filter(Boolean)
}

describe('runCleanupSteps', () => {
  it('runs every remaining step after an earlier step throws', async () => {
    const order = []
    const stderr = fakeStderr()

    const result = await runCleanupSteps(
      [
        {
          name: 'sign out smoke user',
          run: async () => {
            order.push('sign out smoke user')
            throw new Error('sign out failed http=502')
          },
        },
        { name: 'cleanup smoke user', run: async () => void order.push('cleanup smoke user') },
        { name: 'cleanup password org', run: async () => void order.push('cleanup password org') },
        {
          name: 'cleanup password user',
          run: async () => void order.push('cleanup password user'),
        },
      ],
      { stderr },
    )

    expect(order).toEqual([
      'sign out smoke user',
      'cleanup smoke user',
      'cleanup password org',
      'cleanup password user',
    ])
    expect(result.failures).toEqual([
      { name: 'sign out smoke user', message: 'sign out failed http=502' },
    ])
  })

  it('collects every failure and reports each one on stderr', async () => {
    const stderr = fakeStderr()

    const result = await runCleanupSteps(
      [
        {
          name: 'first',
          run: async () => {
            throw new Error('boom one')
          },
        },
        { name: 'second', run: async () => undefined },
        {
          name: 'third',
          run: async () => {
            throw new Error('boom two')
          },
        },
      ],
      { stderr },
    )

    expect(result.failures.map((failure) => failure.name)).toEqual(['first', 'third'])
    expect(stderr.lines).toEqual([
      'cleanup step failed: first: boom one\n',
      'cleanup step failed: third: boom two\n',
    ])
  })

  it('reports no failures and writes nothing when every step succeeds', async () => {
    const stderr = fakeStderr()

    const result = await runCleanupSteps([{ name: 'only', run: async () => undefined }], { stderr })

    expect(result).toEqual({ failures: [] })
    expect(stderr.lines).toEqual([])
  })
})

describe('smoke prefix predicates', () => {
  it('escapes the SQLite single character wildcard inside smoke id prefixes', () => {
    expect(smokePrefixPredicate('id', SMOKE_ID_PREFIXES.user)).toBe(
      "id LIKE 'user\\_smoke\\_%' ESCAPE '\\'",
    )
    expect(smokePrefixPredicate('tenant_id', SMOKE_ID_PREFIXES.organization)).toBe(
      "tenant_id LIKE 'org\\_smoke\\_%' ESCAPE '\\'",
    )
  })

  it('rejects any prefix that is not a smoke prefix', () => {
    for (const prefix of ['users', 'user_', '', '%', "x' OR 1=1 --", null]) {
      expect(() => assertSmokePrefix(prefix)).toThrow(
        /refusing to build a sweep predicate from non-smoke prefix/,
      )
    }
  })

  it('matches only literal smoke ids once ESCAPE is applied', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE probe (id TEXT);
INSERT INTO probe (id) VALUES
  ('user_smoke_11111111-2222-3333-4444-555555555555'),
  ('userXsmokeY-real-account'),
  ('user_11111111-2222-3333-4444-555555555555'),
  ('org_smoke_password_aaaa'),
  ('orgZsmokeQreal'),
  ('org_11111111-2222-3333-4444-555555555555');`)

    const naive = db
      .prepare("SELECT id FROM probe WHERE id LIKE 'user_smoke_%'")
      .all()
      .map((row) => row.id)
    const escaped = db
      .prepare(`SELECT id FROM probe WHERE ${smokePrefixPredicate('id', SMOKE_ID_PREFIXES.user)}`)
      .all()
      .map((row) => row.id)
    const escapedOrg = db
      .prepare(
        `SELECT id FROM probe WHERE ${smokePrefixPredicate('id', SMOKE_ID_PREFIXES.organization)}`,
      )
      .all()
      .map((row) => row.id)

    expect(naive).toContain('userXsmokeY-real-account')
    expect(escaped).toEqual(['user_smoke_11111111-2222-3333-4444-555555555555'])
    expect(escapedOrg).toEqual(['org_smoke_password_aaaa'])
    db.close()
  })
})

describe('smoke residue sweep SQL', () => {
  it('anchors every DELETE on an escaped smoke prefix', () => {
    const statements = smokeResidueDeleteSql().split('\n').filter(Boolean)

    expect(statements).toHaveLength(smokeSweepTables().length)
    for (const statement of statements) {
      expect(statement).toMatch(/^DELETE FROM [a-z_]+ WHERE /)
      const where = statement.slice(statement.indexOf(' WHERE ') + 7)
      expect(where.length).toBeGreaterThan(0)
      for (const clause of where.replace(/;$/, '').split(' OR ')) {
        expect(clause).toMatch(/^(id|user_id|tenant_id) LIKE '[a-z\\_]+%' ESCAPE '\\'$/)
      }
    }
  })

  it('revokes privileges before it removes the principals they hang off', () => {
    const order = smokeSweepTables().map((entry) => entry.table)

    expect(order.indexOf('manager_assignments')).toBe(0)
    expect(order.indexOf('memberships')).toBeLessThan(order.indexOf('users'))
    expect(order.indexOf('user_emails')).toBeLessThan(order.indexOf('users'))
    expect(order.indexOf('users')).toBeLessThan(order.indexOf('organizations'))
  })

  it('covers every smoke id prefix produced by the harnesses', () => {
    const sql = smokeResidueCountSql()

    for (const prefix of Object.values(SMOKE_ID_PREFIXES)) {
      expect(sql).toContain(prefix.replaceAll('_', '\\_'))
    }
    expect(sql).toContain('AS smoke_instance_manager')
  })
})

describe('sweepSmokeResidue', () => {
  it('refuses to delete anything once the residue exceeds the safety threshold', async () => {
    const { exec, calls } = fakeExec({ before: countRow({ sessions: SMOKE_SWEEP_MAX_ROWS + 1 }) })

    await expect(sweepSmokeResidue({ exec, log: () => {} })).rejects.toThrow(
      `smoke residue sweep refused: ${SMOKE_SWEEP_MAX_ROWS + 1} rows exceed maxRows=${SMOKE_SWEEP_MAX_ROWS}`,
    )
    expect(deletedTables(calls)).toEqual([])
  })

  it('honours a lowered maxRows and names the offending tables', async () => {
    const { exec, calls } = fakeExec({ before: countRow({ users: 2, sessions: 3 }) })

    await expect(sweepSmokeResidue({ exec, maxRows: 4, log: () => {} })).rejects.toThrow(
      'smoke residue sweep refused: 5 rows exceed maxRows=4 (sessions=3 users=2)',
    )
    expect(deletedTables(calls)).toEqual([])
  })

  it('reports PASS and issues no DELETE when nothing is left behind', async () => {
    const logged = []
    const { exec, calls } = fakeExec({ before: countRow() })

    const result = await sweepSmokeResidue({
      exec,
      log: (status, name, detail) => logged.push([status, name, detail]),
    })

    expect(result).toMatchObject({ total: 0, deleted: false })
    expect(logged[0][0]).toBe('PASS')
    expect(logged[0][2]).toContain('residue=0')
    expect(deletedTables(calls)).toEqual([])
  })

  it('only counts when dryRun is set', async () => {
    const logged = []
    const { exec, calls } = fakeExec({ before: countRow({ users: 1, manager_assignments: 1 }) })

    const result = await sweepSmokeResidue({
      exec,
      dryRun: true,
      log: (status, name, detail) => logged.push([status, name, detail]),
    })

    expect(result).toMatchObject({ dryRun: true, total: 2, deleted: false })
    expect(logged[0][0]).toBe('SKIP')
    expect(deletedTables(calls)).toEqual([])
  })

  it('deletes and then re-counts to prove the sweep landed', async () => {
    const { exec, calls } = fakeExec({
      before: countRow({ users: 1, manager_assignments: 1, organizations: 1 }),
      after: countRow(),
      probe: [
        { source: 'users', id: 'user_smoke_abc' },
        { source: 'organizations', id: 'org_smoke_password_abc' },
      ],
    })

    const result = await sweepSmokeResidue({ exec, log: () => {} })

    expect(result).toMatchObject({ total: 3, deleted: true })
    expect(deletedTables(calls)).toHaveLength(smokeSweepTables().length)
    expect(calls.filter((call) => call.sql.includes('AS smoke_instance_manager'))).toHaveLength(2)
  })

  it('fails loudly when the post-sweep re-count still finds residue', async () => {
    const { exec } = fakeExec({
      before: countRow({ manager_assignments: 1 }),
      after: countRow({ manager_assignments: 1 }),
      probe: [{ source: 'manager_assignments', id: 'mgr_smoke_abc' }],
    })

    await expect(sweepSmokeResidue({ exec, log: () => {} })).rejects.toThrow(
      'smoke residue sweep left 1 rows: manager_assignments=1',
    )
  })

  it('refuses to delete when a probed id is not a smoke id', async () => {
    const { exec, calls } = fakeExec({
      before: countRow({ organizations: 1 }),
      probe: [{ source: 'organizations', id: 'org_11111111-2222-3333-4444-555555555555' }],
    })

    await expect(sweepSmokeResidue({ exec, log: () => {} })).rejects.toThrow(
      'smoke residue sweep refused: organizations row org_11111111-2222-3333-4444-555555555555 is not a org_smoke_ id',
    )
    expect(deletedTables(calls)).toEqual([])
  })
})

describe('assertNoSmokeResidue', () => {
  it('fails on a smoke instance_manager before anything else', async () => {
    const { exec } = fakeExec({
      before: countRow({ manager_assignments: 1, smoke_instance_manager: 1 }),
    })

    await expect(assertNoSmokeResidue({ exec, log: () => {} })).rejects.toThrow(
      'production smoke residue holds 1 instance_manager assignment(s)',
    )
  })

  it('fails on any other residue and names the tables', async () => {
    const { exec } = fakeExec({ before: countRow({ organizations: 2, user_emails: 1 }) })

    await expect(assertNoSmokeResidue({ exec, log: () => {} })).rejects.toThrow(
      'production smoke residue remains: user_emails=1 organizations=2',
    )
  })

  it('reports PASS when production is clean', async () => {
    const logged = []
    const { exec } = fakeExec({ before: countRow() })

    await expect(
      assertNoSmokeResidue({ exec, log: (status, name) => logged.push([status, name]) }),
    ).resolves.toMatchObject({ total: 0 })
    expect(logged).toEqual([['PASS', 'no smoke residue']])
  })
})

describe('registerCleanupSignalHandlers', () => {
  function fakeProcess() {
    const listeners = new Map()
    return {
      listeners,
      stderr: fakeStderr(),
      on: (signal, listener) => {
        if (!listeners.has(signal)) listeners.set(signal, [])
        listeners.get(signal).push(listener)
      },
      off: (signal, listener) => {
        const current = listeners.get(signal) ?? []
        listeners.set(
          signal,
          current.filter((item) => item !== listener),
        )
      },
      raise: (signal) => {
        for (const listener of [...(listeners.get(signal) ?? [])]) listener()
      },
    }
  }

  it('runs the cleanup once and exits with the signal exit code', async () => {
    const processRef = fakeProcess()
    const exits = []
    let runs = 0

    registerCleanupSignalHandlers(
      async () => {
        runs += 1
      },
      { processRef, exit: (code) => exits.push(code) },
    )
    processRef.raise('SIGINT')
    await new Promise((resolve) => setImmediate(resolve))

    expect(runs).toBe(1)
    expect(exits).toEqual([130])
  })

  it('ignores a repeated signal instead of re-entering the cleanup', async () => {
    const processRef = fakeProcess()
    const exits = []
    let runs = 0
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })

    registerCleanupSignalHandlers(
      async () => {
        runs += 1
        await gate
      },
      { processRef, exit: (code) => exits.push(code) },
    )
    processRef.raise('SIGINT')
    processRef.raise('SIGINT')
    release()
    await new Promise((resolve) => setImmediate(resolve))

    expect(runs).toBe(1)
    expect(exits).toEqual([130])
  })

  it('reports a cleanup failure on stderr and still exits', async () => {
    const processRef = fakeProcess()
    const exits = []

    registerCleanupSignalHandlers(
      async () => {
        throw new Error('sweep failed')
      },
      { processRef, exit: (code) => exits.push(code) },
    )
    processRef.raise('SIGTERM')
    await new Promise((resolve) => setImmediate(resolve))

    expect(processRef.stderr.lines).toEqual(['cleanup on SIGTERM failed: sweep failed\n'])
    expect(exits).toEqual([143])
  })

  it('unregisters every listener so harnesses do not stack handlers', async () => {
    const processRef = fakeProcess()
    let runs = 0

    const unregister = registerCleanupSignalHandlers(
      async () => {
        runs += 1
      },
      { processRef, exit: () => {} },
    )
    expect(CLEANUP_SIGNALS.every((signal) => processRef.listeners.get(signal).length === 1)).toBe(
      true,
    )

    unregister()
    unregister()
    processRef.raise('SIGINT')
    await new Promise((resolve) => setImmediate(resolve))

    expect(runs).toBe(0)
    expect(CLEANUP_SIGNALS.every((signal) => processRef.listeners.get(signal).length === 0)).toBe(
      true,
    )
  })
})

describe('generated sweep SQL against a real sqlite database', () => {
  function seedSweepSchema() {
    const db = new DatabaseSync(':memory:')
    for (const entry of smokeSweepTables()) {
      const columns = []
      if (entry.idPrefix) columns.push('id TEXT')
      if (entry.user) columns.push('user_id TEXT')
      if (entry.tenant) columns.push('tenant_id TEXT')
      if (entry.table === 'manager_assignments') columns.push('manager_role TEXT')
      db.exec(`CREATE TABLE ${entry.table} (${columns.join(', ')})`)
    }
    return db
  }

  it('removes only smoke rows and leaves the real default organization intact', () => {
    const db = seedSweepSchema()
    const realOrg = 'org_11111111-2222-3333-4444-555555555555'
    const realUser = 'user_11111111-2222-3333-4444-555555555555'
    db.exec(`
INSERT INTO users (id, tenant_id) VALUES
  ('${realUser}', '${realOrg}'),
  ('userXsmokeY-real-account', '${realOrg}'),
  ('user_smoke_aaaa', '${realOrg}'),
  ('user_regular', 'org_smoke_password_bbbb');
INSERT INTO organizations (id, tenant_id) VALUES
  ('${realOrg}', '${realOrg}'),
  ('orgZsmokeQreal', 'orgZsmokeQreal'),
  ('org_smoke_password_bbbb', 'org_smoke_password_bbbb'),
  ('org_smoke_pwreset_cccc', 'org_smoke_pwreset_cccc');
INSERT INTO manager_assignments (id, user_id, tenant_id, manager_role) VALUES
  ('mgr_real', '${realUser}', '${realOrg}', 'instance_manager'),
  ('mgr_smoke_dddd', 'user_smoke_aaaa', '${realOrg}', 'instance_manager');
INSERT INTO user_emails (id, user_id, tenant_id) VALUES
  ('eml_real', '${realUser}', '${realOrg}'),
  ('eml_smoke_eeee', 'user_smoke_aaaa', '${realOrg}');
INSERT INTO memberships (id, user_id, tenant_id) VALUES
  ('mem_real', '${realUser}', '${realOrg}'),
  ('mem_smoke_ffff', 'user_smoke_aaaa', '${realOrg}');
INSERT INTO metering_outbox (user_id, tenant_id) VALUES
  ('${realUser}', '${realOrg}'),
  ('user_smoke_aaaa', '${realOrg}');
`)

    const before = db.prepare(smokeResidueCountSql().replace(/;\s*$/, '')).get()
    const probe = db.prepare(smokeResidueProbeSql(200).replace(/;\s*$/, '')).all()
    db.exec(smokeResidueDeleteSql())
    const after = db.prepare(smokeResidueCountSql().replace(/;\s*$/, '')).get()

    expect(Number(before.smoke_instance_manager)).toBe(1)
    expect(Number(before.users)).toBe(2)
    expect(Number(before.organizations)).toBe(2)
    expect(probe.map((row) => row.id).sort()).toEqual([
      'eml_smoke_eeee',
      'mem_smoke_ffff',
      'mgr_smoke_dddd',
      'org_smoke_password_bbbb',
      'org_smoke_pwreset_cccc',
      'user_smoke_aaaa',
    ])
    expect(Number(after.smoke_instance_manager)).toBe(0)

    expect(
      db
        .prepare('SELECT id FROM users')
        .all()
        .map((row) => row.id)
        .sort(),
    ).toEqual([realUser, 'userXsmokeY-real-account'].sort())
    expect(
      db
        .prepare('SELECT id FROM organizations')
        .all()
        .map((row) => row.id)
        .sort(),
    ).toEqual([realOrg, 'orgZsmokeQreal'].sort())
    expect(
      db
        .prepare('SELECT id FROM manager_assignments')
        .all()
        .map((row) => row.id),
    ).toEqual(['mgr_real'])
    expect(db.prepare('SELECT COUNT(*) AS n FROM metering_outbox').get().n).toBe(1)
    db.close()
  })
})
