import { describe, expect, it, vi } from 'vitest'
import { enqueueScheduledScimTargetSyncs } from '../scim-targets'

function asType<T>(value: unknown): T {
  return value as T
}

describe('daily outbound SCIM sync fallback', () => {
  it('enqueues every token-configured active target with its instance issuer, page by page', async () => {
    const now = Date.parse('2026-10-06T02:00:00.000Z')
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `st_${String(index).padStart(3, '0')}`,
      tenantId: 't_1',
      orgId: 'org_1',
      primaryDomain: 'xid.example',
    }))
    const secondPage = [
      { id: 'st_200', tenantId: 't_2', orgId: 'org_2', primaryDomain: 'id.other' },
    ]
    const queries: { sql: string; params: unknown[] }[] = []
    const send = vi.fn().mockResolvedValue(undefined)
    const env = asType<Env>({
      DB: {
        prepare: (sql: string) => ({
          bind: (...params: unknown[]) => ({
            all: async () => {
              queries.push({ sql, params })
              return { results: queries.length === 1 ? firstPage : secondPage }
            },
          }),
        }),
      },
      SCIM_QUEUE: { send },
    })

    const total = await enqueueScheduledScimTargetSyncs(env, now)

    expect(total).toBe(101)
    expect(queries[0]?.sql).toContain('token_ciphertext IS NOT NULL')
    expect(queries[1]?.params[0]).toBe('st_099')
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tenantId: 't_2',
        orgId: 'org_2',
        targetId: 'st_200',
        issuer: 'https://id.other',
        requestedAt: now,
      }),
    )
  })
})
