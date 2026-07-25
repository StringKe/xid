import { beforeAll, describe, expect, it } from 'vitest'

// harness 模块在 import 时就要求真实收件人与口令(公开仓库不留默认值),单测只需要它的纯函数,
// 因此先注入占位值再动态 import。这些值不参与任何 SQL,也不发往 https://xid.dev。
const DEFAULT_ORG_ID = 'org_11111111-2222-3333-4444-555555555555'
const SMOKE_ORG_ID = 'org_smoke_pwreset_11111111-2222-3333-4444-555555555555'

let harness

beforeAll(async () => {
  process.env['XID_PRODUCTION_EMAIL'] = 'unit-test@example.com'
  process.env['XID_PRODUCTION_PASSWORD_RESET_OLD_PASSWORD'] = 'unit-test-old-password'
  process.env['XID_PRODUCTION_PASSWORD_RESET_NEW_PASSWORD'] = 'unit-test-new-password'
  harness = await import('./harness/smoke-production-password-reset.mjs')
})

function recordingExec(rowsByCall = []) {
  const calls = []
  let index = 0
  const exec = async (sql, name) => {
    calls.push({ sql, name })
    const rows = rowsByCall[index] ?? []
    index += 1
    return rows
  }
  return { calls, exec, log: () => {} }
}

describe('password reset smoke organization guard', () => {
  it('rejects the production default organization', () => {
    expect(() => harness.assertPasswordResetSmokeOrg(DEFAULT_ORG_ID)).toThrow(
      /refusing to touch a non-smoke organization/,
    )
  })

  it('rejects a real organization id carried by a pasted reset link', () => {
    expect(() => harness.assertPasswordResetSmokeOrg('org_9f2c4a11-real-customer')).toThrow(
      /refusing to touch a non-smoke organization/,
    )
  })

  it('rejects a non-string organization id', () => {
    expect(() => harness.assertPasswordResetSmokeOrg(null)).toThrow(
      /refusing to touch a non-smoke organization/,
    )
  })

  it('rejects an id that only contains the smoke prefix in the middle', () => {
    expect(() => harness.assertPasswordResetSmokeOrg(`real_${SMOKE_ORG_ID}`)).toThrow(
      /refusing to touch a non-smoke organization/,
    )
  })

  it('accepts an id created by this harness', () => {
    expect(harness.assertPasswordResetSmokeOrg(SMOKE_ORG_ID)).toBe(SMOKE_ORG_ID)
  })
})

describe('password reset smoke cleanup sql', () => {
  it('anchors every statement on the exact smoke tenant id', () => {
    const statements = harness
      .passwordResetCleanupSql(SMOKE_ORG_ID)
      .split('\n')
      .filter((line) => line.trim().length > 0)

    expect(statements.length).toBeGreaterThan(0)
    for (const statement of statements) {
      expect(statement).toContain(`'${SMOKE_ORG_ID}'`)
      expect(statement).not.toContain('LIKE')
    }
  })

  it('covers the tables this harness creates rows in', () => {
    const sql = harness.passwordResetCleanupSql(SMOKE_ORG_ID)

    for (const table of [
      'organizations',
      'users',
      'user_emails',
      'memberships',
      'manager_assignments',
      'passwords',
      'password_history',
      'password_reset_tokens',
      'sessions',
      'metering_outbox',
      'backup_codes',
      'refresh_tokens',
    ]) {
      expect(sql).toContain(`DELETE FROM ${table} `)
    }
  })

  it('deletes principals after the rows that grant them access', () => {
    const sql = harness.passwordResetCleanupSql(SMOKE_ORG_ID)

    expect(sql.indexOf('DELETE FROM manager_assignments ')).toBeLessThan(
      sql.indexOf('DELETE FROM users '),
    )
    expect(sql.indexOf('DELETE FROM memberships ')).toBeLessThan(sql.indexOf('DELETE FROM users '))
    expect(sql.indexOf('DELETE FROM users ')).toBeLessThan(
      sql.indexOf('DELETE FROM organizations '),
    )
  })
})

describe('password reset smoke cleanup execution', () => {
  it('never reaches the database for a non-smoke organization', async () => {
    const { calls, exec, log } = recordingExec()

    await expect(
      harness.cleanupPasswordResetSmokeOrganization(DEFAULT_ORG_ID, { exec, log }),
    ).rejects.toThrow(/refusing to touch a non-smoke organization/)

    expect(calls).toHaveLength(0)
  })

  it('is a no-op when no organization is owned', async () => {
    const { calls, exec, log } = recordingExec()

    await harness.cleanupPasswordResetSmokeOrganization(null, { exec, log })

    expect(calls).toHaveLength(0)
  })
})

describe('password reset smoke orphan sweep', () => {
  it('reports a clean sweep without issuing deletes', async () => {
    const { calls, exec, log } = recordingExec([[]])

    await harness.sweepPasswordResetSmokeOrphans({ exec, log })

    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toContain("id LIKE 'org\\_smoke\\_pwreset\\_%' ESCAPE '\\'")
  })

  it('cleans every orphan left behind by an earlier send-only run', async () => {
    const orphanA = 'org_smoke_pwreset_aaaaaaaa-0000-0000-0000-000000000000'
    const orphanB = 'org_smoke_pwreset_bbbbbbbb-0000-0000-0000-000000000000'
    const { calls, exec, log } = recordingExec([[{ id: orphanA }, { id: orphanB }]])

    await harness.sweepPasswordResetSmokeOrphans({ exec, log })

    const deletes = calls.filter((call) => call.sql.includes('DELETE FROM'))
    expect(deletes).toHaveLength(2)
    expect(deletes[0].sql).toContain(`'${orphanA}'`)
    expect(deletes[1].sql).toContain(`'${orphanB}'`)
  })

  it('drops a row the prefix filter should never have returned', async () => {
    const { calls, exec, log } = recordingExec([
      [{ id: DEFAULT_ORG_ID }, { id: 'org_real_tenant' }],
    ])

    await harness.sweepPasswordResetSmokeOrphans({ exec, log })

    expect(calls.filter((call) => call.sql.includes('DELETE FROM'))).toHaveLength(0)
  })

  it('fails loudly when an orphan cannot be cleaned', async () => {
    const orphan = 'org_smoke_pwreset_cccccccc-0000-0000-0000-000000000000'
    let call = 0
    const exec = async (sql) => {
      call += 1
      if (call === 1) return [{ id: orphan }]
      throw new Error(`d1 unavailable: ${sql.slice(0, 12)}`)
    }

    await expect(harness.sweepPasswordResetSmokeOrphans({ exec, log: () => {} })).rejects.toThrow(
      /orphan sweep failed/,
    )
  })
})
