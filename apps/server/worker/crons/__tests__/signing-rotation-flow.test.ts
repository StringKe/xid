// Cron 在四步密钥轮换中的职责边界:第 1 步 publish next + 第 4 步 retire;
// 第 2-3 步(promote_active)必须由显式管理流程触发,不得由 Cron 擅自切签名 kid。
import { describe, expect, it } from 'vitest'
import { planRotation } from '@xid-kit/crypto'
import { backfillRetiringKeyRetireAfter, rotateSigningKeysCheck } from '../daily'

type KeyRow = {
  id: string
  instance_id: string
  kid: string
  alg: string
  status: string
  activated_at: number | null
  retire_after: number | null
}

function makeKekB64(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  let s = ''
  for (const b of raw) s += String.fromCharCode(b)
  return btoa(s)
}

class SigningFlowD1 {
  keys: KeyRow[] = []
  readonly runs: Array<{ sql: string; args: unknown[] }> = []

  prepare = (sql: string) => {
    const stmt = {
      bind: (...args: unknown[]) => ({
        run: async () => {
          this.runs.push({ sql, args })
          const normalized = sql.toLowerCase()
          if (
            normalized.includes("set status = 'retired'") &&
            normalized.includes("status = 'retiring'")
          ) {
            const now = Number(args[1])
            for (const row of this.keys) {
              if (
                row.status === 'retiring' &&
                row.retire_after !== null &&
                row.retire_after < now
              ) {
                row.status = 'retired'
              }
            }
          }
          if (
            normalized.includes('set retire_after = ?') &&
            normalized.includes('retire_after is null')
          ) {
            const fallback = Number(args[0])
            for (const row of this.keys) {
              if (row.status === 'retiring' && row.retire_after === null) {
                row.retire_after = fallback
              }
            }
          }
          if (normalized.includes('insert into instance_signing_keys')) {
            const [, instanceId, kid, alg] = args as [string, string, string, string]
            this.keys.push({
              id: `sk_${kid}`,
              instance_id: instanceId,
              kid,
              alg,
              status: 'next',
              activated_at: null,
              retire_after: null,
            })
          }
          return { success: true }
        },
        all: async <T>() => {
          this.runs.push({ sql, args })
          const normalized = sql.toLowerCase()
          if (
            normalized.includes("status = 'active'") &&
            normalized.includes('not exists') &&
            normalized.includes("status = 'next'")
          ) {
            const cutoff = Number(args[0])
            const results = this.keys
              .filter(
                (row) =>
                  row.status === 'active' &&
                  row.activated_at !== null &&
                  row.activated_at < cutoff &&
                  !this.keys.some(
                    (next) => next.instance_id === row.instance_id && next.status === 'next',
                  ),
              )
              .map((row) => ({ instance_id: row.instance_id, alg: row.alg }))
            return { results: results as T[] }
          }
          return { results: [] as T[] }
        },
      }),
      run: async () => stmt.bind().run(),
      all: async <T>() => stmt.bind().all<T>(),
    }
    return stmt
  }
}

function cronForbiddenSql(sql: string): boolean {
  const normalized = sql.toLowerCase()
  if (!normalized.startsWith('update')) return false
  if (normalized.includes("set status = 'active'")) return true
  if (normalized.includes("set status = 'retiring'") && !normalized.includes('retired')) {
    return true
  }
  return false
}

describe('signing rotation four-step: cron vs management API', () => {
  it('rotateSigningKeysCheck publish_next matches planRotation publish_next', async () => {
    const now = Date.now()
    const db = new SigningFlowD1()
    db.keys.push({
      id: 'sk_active',
      instance_id: 'inst_1',
      kid: 'active-kid',
      alg: 'ES256',
      status: 'active',
      activated_at: now - 91 * 24 * 60 * 60 * 1000,
      retire_after: null,
    })

    const env = { DB: db, KEK: makeKekB64() } as unknown as Env
    await rotateSigningKeysCheck(env)

    const next = db.keys.find((k) => k.status === 'next')
    expect(next).toBeDefined()
    const staleActiveQuery = db.runs.find((run) =>
      run.sql.includes('FROM instance_signing_keys active'),
    )
    expect(staleActiveQuery?.sql).toContain(
      'ORDER BY active.activated_at ASC, active.instance_id ASC',
    )

    const planned = planRotation(
      [{ kid: 'active-kid', status: 'active' }],
      'publish_next',
      next?.kid ?? 'missing',
    )
    expect(planned).toEqual([
      { kid: 'active-kid', status: 'active' },
      { kid: next?.kid, status: 'next' },
    ])
  })

  it('daily signing cron never performs promote_active transitions', async () => {
    const now = Date.now()
    const db = new SigningFlowD1()
    db.keys.push(
      {
        id: 'sk_active',
        instance_id: 'inst_1',
        kid: 'active-kid',
        alg: 'ES256',
        status: 'active',
        activated_at: now - 91 * 24 * 60 * 60 * 1000,
        retire_after: null,
      },
      {
        id: 'sk_retiring',
        instance_id: 'inst_1',
        kid: 'retiring-kid',
        alg: 'ES256',
        status: 'retiring',
        activated_at: now - 200_000,
        retire_after: null,
      },
    )

    const env = { DB: db, KEK: makeKekB64() } as unknown as Env
    await backfillRetiringKeyRetireAfter(env)
    await rotateSigningKeysCheck(env)

    expect(db.runs.some((run) => cronForbiddenSql(run.sql))).toBe(false)
    expect(db.keys.find((k) => k.kid === 'active-kid')?.status).toBe('active')
    expect(db.keys.some((k) => k.status === 'next')).toBe(true)
  })

  it('step 4 retires only retiring keys past retire_after', async () => {
    const now = Date.now()
    const db = new SigningFlowD1()
    db.keys.push(
      {
        id: 'sk_past',
        instance_id: 'inst_1',
        kid: 'past-kid',
        alg: 'ES256',
        status: 'retiring',
        activated_at: now - 500_000,
        retire_after: now - 1_000,
      },
      {
        id: 'sk_future',
        instance_id: 'inst_1',
        kid: 'future-kid',
        alg: 'ES256',
        status: 'retiring',
        activated_at: now - 500_000,
        retire_after: now + 60 * 60 * 1000,
      },
    )

    const env = { DB: db, KEK: makeKekB64() } as unknown as Env
    await rotateSigningKeysCheck(env)

    expect(db.keys.find((k) => k.kid === 'past-kid')?.status).toBe('retired')
    expect(db.keys.find((k) => k.kid === 'future-kid')?.status).toBe('retiring')
  })

  it('backfillRetiringKeyRetireAfter applies 1h JWKS grace before step-4 retirement', async () => {
    const before = Date.now()
    const db = new SigningFlowD1()
    db.keys.push({
      id: 'sk_retiring',
      instance_id: 'inst_1',
      kid: 'retiring-kid',
      alg: 'ES256',
      status: 'retiring',
      activated_at: before - 100_000,
      retire_after: null,
    })

    const env = { DB: db, KEK: makeKekB64() } as unknown as Env
    await backfillRetiringKeyRetireAfter(env)

    const row = db.keys[0]
    expect(row?.retire_after).not.toBeNull()
    const graceMs = (row?.retire_after ?? 0) - before
    expect(graceMs).toBeGreaterThanOrEqual(3_599_000)
    expect(graceMs).toBeLessThanOrEqual(3_601_000)
  })
})
