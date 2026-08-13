// guest GC cron 单测:不活跃满 30 天的 anonymous 用户按租户软删，空顶级 Tenant 一并软删。
// raw SQL 必须显式绑 tenant_id(cron 无 TenantContext,tenant-isolation rule 允许场景)。

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/session', () => ({
  sessionDoRevokeAll: vi.fn().mockResolvedValue(undefined),
}))

import { gcInactiveGuests } from '../daily'
import { GUEST_GC_INACTIVE_DAYS } from '../../lib/ttl'
import { sessionDoRevokeAll } from '../../lib/session'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-02-15T00:00:00Z')

type CapturedStatement = { sql: string; params: unknown[] }
type BoundStatement = {
  sql: string
  params: unknown[]
  all: () => Promise<{ results: unknown[] }>
  run: () => Promise<{ success: boolean }>
}

// fake D1:organizations 翻页返回两个 tenant;users SELECT 首轮返回预置 guest,次轮空(终止翻页)。
function makeEnv(
  guestRows: Record<string, Array<{ id: string; delete_tenant?: number }>>,
  options: { claimChanges?: Record<string, number> } = {},
) {
  const updates: CapturedStatement[] = []
  const selects: CapturedStatement[] = []
  const batches: BoundStatement[][] = []
  const selectCount: Record<string, number> = {}
  const auditSend = vi.fn().mockResolvedValue(undefined)

  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            sql,
            params,
            all: async () => {
              if (sql.includes('FROM users u')) {
                selects.push({ sql, params })
                const tenantId = String(params[0])
                const seen = (selectCount[tenantId] = (selectCount[tenantId] ?? 0) + 1)
                return { results: seen === 1 ? (guestRows[tenantId] ?? []) : [] }
              }
              if (sql.includes('FROM organizations')) {
                return { results: [{ tenant_id: 't_1' }, { tenant_id: 't_2' }] }
              }
              return { results: [] }
            },
            run: async () => {
              if (sql.startsWith('UPDATE users')) updates.push({ sql, params })
              return { success: true }
            },
          } as BoundStatement
        },
      }
    },
    async batch(statements: BoundStatement[]) {
      batches.push(statements)
      for (const statement of statements) {
        if (statement.sql.startsWith('UPDATE users')) {
          updates.push({ sql: statement.sql, params: statement.params })
        }
      }
      const tenantId = String(statements[0]?.params[2])
      const claimChanges = options.claimChanges?.[tenantId] ?? 1
      return statements.map((_, index) => ({
        success: true,
        meta: { changes: index === 0 ? claimChanges : claimChanges === 1 ? 1 : 0 },
        results: [],
      }))
    },
  } as unknown as D1Database

  return {
    env: { DB: db, AUDIT_QUEUE: { send: auditSend } } as unknown as Env,
    updates,
    selects,
    batches,
    auditSend,
  }
}

describe('gcInactiveGuests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('超窗 guest 软删:UPDATE 显式绑 tenant_id + user id + anonymous 条件,审计 guest.gc_deleted', async () => {
    const { env, updates, selects, auditSend } = makeEnv({ t_1: [{ id: 'u_old' }] })

    await gcInactiveGuests(env, NOW)

    expect(updates).toHaveLength(1)
    const update = updates[0]
    expect(update?.sql).toContain('provisioned_by = ?')
    expect(update?.sql).toContain('deleted_at IS NULL')
    expect(update?.sql).toContain('verified_email.verified = 1')
    expect(update?.sql).toContain('MAX(active_session.last_active_at)')
    expect(update?.sql).toContain('SELECT 1 FROM refresh_tokens')
    expect(update?.sql).toContain('SELECT 1 FROM invitations')
    expect(update?.params).toEqual([
      NOW.getTime(),
      NOW.getTime(),
      't_1',
      'u_old',
      'anonymous',
      NOW.getTime() - GUEST_GC_INACTIVE_DAYS * DAY_MS,
    ])

    expect(auditSend).toHaveBeenCalledTimes(1)
    expect(sessionDoRevokeAll).toHaveBeenCalledWith(env, 'u_old')
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't_1',
        action: 'guest.gc_deleted',
        ts: NOW.getTime(),
        payload: { targetType: 'user', targetId: 'u_old' },
      }),
    )

    // 活跃窗口:cutoff = now - GUEST_GC_INACTIVE_DAYS,SELECT 显式绑 tenant_id 与 anonymous。
    const select = selects[0]
    expect(select?.params[0]).toBe('t_1')
    expect(select?.params[1]).toBe('anonymous')
    expect(select?.params[2]).toBe(NOW.getTime() - GUEST_GC_INACTIVE_DAYS * DAY_MS)
    // 最后活跃基准:有 session 按 MAX(last_active_at),无 session 回落 created_at。
    expect(select?.sql).toContain('MAX(active_session.last_active_at)')
    expect(select?.sql).toContain('u.created_at')
  })

  it('无超窗 guest 的租户:不软删、不审计', async () => {
    const { env, updates, auditSend } = makeEnv({})

    await gcInactiveGuests(env, NOW)

    expect(updates).toHaveLength(0)
    expect(auditSend).not.toHaveBeenCalled()
    expect(sessionDoRevokeAll).not.toHaveBeenCalled()
  })

  it('多租户:每个 tenant 独立软删,互不串租户', async () => {
    const { env, updates } = makeEnv({ t_1: [{ id: 'u_a' }], t_2: [{ id: 'u_b' }] })

    await gcInactiveGuests(env, NOW)

    expect(updates).toHaveLength(2)
    expect(updates[0]?.params.slice(2, 5)).toEqual(['t_1', 'u_a', 'anonymous'])
    expect(updates[1]?.params.slice(2, 5)).toEqual(['t_2', 'u_b', 'anonymous'])
  })

  it('空顶级 Tenant 随未转正 owner 一并软删', async () => {
    const { env, batches } = makeEnv({ t_1: [{ id: 'u_owner', delete_tenant: 1 }] })

    await gcInactiveGuests(env, NOW)

    const statements = batches[0]
    const orgUpdate = statements.find((statement) =>
      statement.sql.startsWith('UPDATE organizations'),
    )
    expect(orgUpdate?.params.slice(0, 4)).toEqual([NOW.getTime(), NOW.getTime(), 't_1', 't_1'])
    expect(statements[0]?.sql).toContain('SELECT 1 FROM organizations child')
    expect(statements[0]?.sql).toContain('SELECT 1 FROM resource_servers')
    expect(statements[0]?.sql).toContain('SELECT 1 FROM manager_assignments')
  })

  it('SELECT 后目标状态或 Tenant 资源变化时最终原子 claim 跳过清理', async () => {
    const { env, batches, auditSend } = makeEnv(
      { t_1: [{ id: 'u_raced', delete_tenant: 1 }] },
      { claimChanges: { t_1: 0 } },
    )

    await gcInactiveGuests(env, NOW)

    expect(batches[0]?.[0]?.sql).toContain('status =')
    expect(batches[0]?.[0]?.sql).toContain('SELECT 1 FROM applications')
    expect(batches[0]?.[0]?.sql).toContain('SELECT 1 FROM users other_user')
    expect(sessionDoRevokeAll).not.toHaveBeenCalled()
    expect(auditSend).not.toHaveBeenCalled()
  })

  it('软删除 closure 只撤销 user-owned 行，不物理删除保留数据', async () => {
    const { env, batches } = makeEnv({ t_1: [{ id: 'u_owner', delete_tenant: 1 }] })

    await gcInactiveGuests(env, NOW)

    const statements = batches[0] ?? []
    expect(
      statements.some((statement) => statement.sql.startsWith('UPDATE verification_tokens')),
    ).toBe(true)
    expect(
      statements.some((statement) => statement.sql.startsWith('UPDATE magic_link_tokens')),
    ).toBe(true)
    expect(
      statements.some((statement) => statement.sql.startsWith('UPDATE passkey_credentials')),
    ).toBe(true)
    expect(statements.some((statement) => statement.sql.startsWith('UPDATE trusted_devices'))).toBe(
      true,
    )
    expect(statements.every((statement) => !statement.sql.trimStart().startsWith('DELETE'))).toBe(
      true,
    )
  })
})
