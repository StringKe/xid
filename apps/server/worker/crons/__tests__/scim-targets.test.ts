import { describe, expect, it, vi } from 'vitest'
import { enqueueScheduledScimTargetSyncs } from '../scim-targets'

function asType<T>(value: unknown): T {
  return value as T
}

const ENCRYPTED = { tokenIv: 'iv', tokenCiphertext: 'ct', tokenTag: 'tag' }
const NO_TOKEN = { tokenIv: null, tokenCiphertext: null, tokenTag: null }

function pagedEnv(pages: unknown[][], extra: Record<string, unknown> = {}) {
  const queries: { sql: string; params: unknown[] }[] = []
  const send = vi.fn().mockResolvedValue(undefined)
  const env = asType<Env>({
    DB: {
      prepare: (sql: string) => ({
        bind: (...params: unknown[]) => ({
          all: async () => {
            queries.push({ sql, params })
            return { results: pages[queries.length - 1] ?? [] }
          },
        }),
      }),
    },
    SCIM_QUEUE: { send },
    ...extra,
  })
  return { env, queries, send }
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
