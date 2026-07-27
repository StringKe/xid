// guest GC cron 单测:不活跃满 30 天的 anonymous 用户按租户软删 + guest.gc_deleted 审计。
// raw SQL 必须显式绑 tenant_id(cron 无 TenantContext,tenant-isolation rule 允许场景)。

import { describe, expect, it, vi } from 'vitest'
import { gcInactiveGuests } from '../daily'
import { GUEST_GC_INACTIVE_DAYS } from '../../lib/ttl'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-02-15T00:00:00Z')

type CapturedStatement = { sql: string; params: unknown[] }

// fake D1:organizations 翻页返回两个 tenant;users SELECT 首轮返回预置 guest,次轮空(终止翻页)。
function makeEnv(guestRows: Record<string, Array<{ id: string }>>) {
  const updates: CapturedStatement[] = []
  const selects: CapturedStatement[] = []
  const selectCount: Record<string, number> = {}
  const auditSend = vi.fn().mockResolvedValue(undefined)

  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            all: async () => {
              if (sql.includes('FROM organizations')) {
                return { results: [{ tenant_id: 't_1' }, { tenant_id: 't_2' }] }
              }
              if (sql.includes('FROM users u')) {
                selects.push({ sql, params })
                const tenantId = String(params[0])
                const seen = (selectCount[tenantId] = (selectCount[tenantId] ?? 0) + 1)
                return { results: seen === 1 ? (guestRows[tenantId] ?? []) : [] }
              }
              return { results: [] }
            },
            run: async () => {
              if (sql.startsWith('UPDATE users')) updates.push({ sql, params })
              return { success: true }
            },
          }
        },
      }
    },
  } as unknown as D1Database

  return {
    env: { DB: db, AUDIT_QUEUE: { send: auditSend } } as unknown as Env,
    updates,
    selects,
    auditSend,
  }
}

describe('gcInactiveGuests', () => {
  it('超窗 guest 软删:UPDATE 显式绑 tenant_id + user id + anonymous 条件,审计 guest.gc_deleted', async () => {
    const { env, updates, selects, auditSend } = makeEnv({ t_1: [{ id: 'u_old' }] })

    await gcInactiveGuests(env, NOW)

    expect(updates).toHaveLength(1)
    const update = updates[0]
    expect(update?.sql).toContain('provisioned_by = ?')
    expect(update?.sql).toContain('deleted_at IS NULL')
    expect(update?.params).toEqual([NOW.getTime(), NOW.getTime(), 't_1', 'u_old', 'anonymous'])

    expect(auditSend).toHaveBeenCalledTimes(1)
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
    expect(select?.params[3]).toBe(NOW.getTime() - GUEST_GC_INACTIVE_DAYS * DAY_MS)
    // 最后活跃基准:有 session 按 MAX(last_active_at),无 session 回落 created_at。
    expect(select?.sql).toContain('MAX(s.last_active_at)')
    expect(select?.sql).toContain('u.created_at')
  })

  it('无超窗 guest 的租户:不软删、不审计', async () => {
    const { env, updates, auditSend } = makeEnv({})

    await gcInactiveGuests(env, NOW)

    expect(updates).toHaveLength(0)
    expect(auditSend).not.toHaveBeenCalled()
  })

  it('多租户:每个 tenant 独立软删,互不串租户', async () => {
    const { env, updates } = makeEnv({ t_1: [{ id: 'u_a' }], t_2: [{ id: 'u_b' }] })

    await gcInactiveGuests(env, NOW)

    expect(updates).toHaveLength(2)
    expect(updates[0]?.params.slice(2, 5)).toEqual(['t_1', 'u_a', 'anonymous'])
    expect(updates[1]?.params.slice(2, 5)).toEqual(['t_2', 'u_b', 'anonymous'])
  })
})
