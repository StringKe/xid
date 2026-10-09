import { describe, expect, it, vi } from 'vitest'
import { enqueueScheduledScimTargetSyncs } from '../scim-targets'
import { SCIM_FULL_SYNC_DEDUPE_WINDOW_MS } from '../../lib/ttl'

function asType<T>(value: unknown): T {
  return value as T
}

const ENCRYPTED = { tokenIv: 'iv', tokenCiphertext: 'ct', tokenTag: 'tag' }
const NO_TOKEN = { tokenIv: null, tokenCiphertext: null, tokenTag: null }

// claimed 列出已有未开始全量的 target id,条件 UPDATE 对它们返回 changes=0。
function pagedEnv(
  pages: unknown[][],
  extra: Record<string, unknown> = {},
  claimed: ReadonlySet<string> = new Set(),
) {
  const queries: { sql: string; params: unknown[] }[] = []
  const claims: unknown[][] = []
  const send = vi.fn().mockResolvedValue(undefined)
  const env = asType<Env>({
    DB: {
      prepare: (sql: string) => ({
        bind: (...params: unknown[]) => ({
          all: async () => {
            queries.push({ sql, params })
            return { results: pages[queries.length - 1] ?? [] }
          },
          run: async () => {
            claims.push(params)
            return { meta: { changes: claimed.has(String(params[3])) ? 0 : 1 } }
          },
        }),
      }),
    },
    SCIM_QUEUE: { send },
    ...extra,
  })
  return { env, queries, claims, send }
}

describe('daily outbound SCIM sync fallback', () => {
  it('enqueues every token-configured active target with its instance issuer, page by page', async () => {
    const now = Date.parse('2026-10-06T02:00:00.000Z')
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `st_${String(index).padStart(3, '0')}`,
      tenantId: 't_1',
      orgId: 'org_1',
      primaryDomain: 'xid.example',
      ...ENCRYPTED,
    }))
    const secondPage = [
      { id: 'st_200', tenantId: 't_2', orgId: 'org_2', primaryDomain: 'id.other', ...ENCRYPTED },
    ]
    const { env, queries, send } = pagedEnv([firstPage, secondPage])

    const total = await enqueueScheduledScimTargetSyncs(env, now)

    expect(total).toBe(101)
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

  it('skips a target whose automatic full sync is still pending and claims the others', async () => {
    const now = Date.parse('2026-10-06T02:00:00.000Z')
    const page = [
      {
        id: 'st_pending',
        tenantId: 't_1',
        orgId: 'org_1',
        primaryDomain: 'xid.example',
        ...ENCRYPTED,
      },
      {
        id: 'st_free',
        tenantId: 't_1',
        orgId: 'org_2',
        primaryDomain: 'xid.example',
        ...ENCRYPTED,
      },
    ]
    const { env, claims, send } = pagedEnv([page], {}, new Set(['st_pending']))

    const total = await enqueueScheduledScimTargetSyncs(env, now)

    expect(total).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'st_free' }))
    expect(claims).toEqual([
      [now, 't_1', 'org_1', 'st_pending', now - SCIM_FULL_SYNC_DEDUPE_WINDOW_MS],
      [now, 't_1', 'org_2', 'st_free', now - SCIM_FULL_SYNC_DEDUPE_WINDOW_MS],
    ])
  })

  it('enqueues legacy secret-backed targets and skips targets without any token', async () => {
    const page = [
      {
        id: 'st_legacy',
        tenantId: 't_1',
        orgId: 'org_1',
        primaryDomain: 'xid.example',
        ...NO_TOKEN,
      },
      {
        id: 'st_empty',
        tenantId: 't_1',
        orgId: 'org_1',
        primaryDomain: 'xid.example',
        ...NO_TOKEN,
      },
    ]
    const { env, send } = pagedEnv([page], { SCIM_TARGET_TOKEN_st_legacy: 'legacy-token' })

    const total = await enqueueScheduledScimTargetSyncs(env)

    expect(total).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'st_legacy' }))
  })
})
