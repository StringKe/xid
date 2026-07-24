import { describe, it, expect } from 'vitest'

import {
  backfillRetiringKeyRetireAfter,
  getPrevYearMonth,
  rotateSigningKeysCheck,
  shouldArchivePrevMonth,
} from '../daily'

type KeyRow = {
  id: string
  instance_id: string
  kid: string
  alg: string
  status: string
  activated_at: number | null
  retire_after: number | null
  public_key_jwk: string
  private_key_iv: string
  private_key_ciphertext: string
  private_key_tag: string
  kek_version: number
  created_at: number
  updated_at: number
}

function makeKekB64(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  let s = ''
  for (const b of raw) s += String.fromCharCode(b)
  return btoa(s)
}

class SigningKeysD1 {
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
                row.updated_at = Number(args[0])
              }
            }
          }
          if (
            normalized.includes('set retire_after = ?') &&
            normalized.includes('retire_after is null')
          ) {
            const fallback = Number(args[0])
            const now = Number(args[1])
            for (const row of this.keys) {
              if (row.status === 'retiring' && row.retire_after === null) {
                row.retire_after = fallback
                row.updated_at = now
              }
            }
          }
          if (normalized.includes('insert into instance_signing_keys')) {
            const [
              id,
              instanceId,
              kid,
              alg,
              publicKeyJwk,
              iv,
              ciphertext,
              tag,
              kekVersion,
              createdAt,
              updatedAt,
            ] = args as [
              string,
              string,
              string,
              string,
              string,
              unknown,
              unknown,
              unknown,
              number,
              number,
              number,
            ]
            this.keys.push({
              id,
              instance_id: instanceId,
              kid,
              alg,
              status: 'next',
              activated_at: null,
              retire_after: null,
              public_key_jwk: publicKeyJwk,
              private_key_iv: String(iv),
              private_key_ciphertext: String(ciphertext),
              private_key_tag: String(tag),
              kek_version: kekVersion,
              created_at: createdAt,
              updated_at: updatedAt,
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

describe('getPrevYearMonth', () => {
  it('returns previous month in UTC', () => {
    expect(getPrevYearMonth(new Date('2026-03-15T12:00:00Z'))).toBe('2026-02')
    expect(getPrevYearMonth(new Date('2026-01-10T00:00:00Z'))).toBe('2025-12')
  })
})

describe('shouldArchivePrevMonth', () => {
  it('is true only on the first UTC day of month', () => {
    expect(shouldArchivePrevMonth(new Date('2026-06-01T00:00:01Z'))).toBe(true)
    expect(shouldArchivePrevMonth(new Date('2026-06-02T00:00:00Z'))).toBe(false)
  })
})

describe('backfillRetiringKeyRetireAfter', () => {
  it('sets retire_after on retiring keys missing the field', async () => {
    const db = new SigningKeysD1()
    db.keys.push({
      id: 'sk_1',
      instance_id: 'inst_1',
      kid: 'old',
      alg: 'ES256',
      status: 'retiring',
      activated_at: 1,
      retire_after: null,
      public_key_jwk: '{}',
      private_key_iv: '',
      private_key_ciphertext: '',
      private_key_tag: '',
      kek_version: 1,
      created_at: 1,
      updated_at: 1,
    })
    const env = { DB: db, KEK: makeKekB64() } as unknown as Env
    await backfillRetiringKeyRetireAfter(env)
    expect(db.keys[0]?.retire_after).not.toBeNull()
  })
})

describe('rotateSigningKeysCheck', () => {
  it('retires keys past retire_after and publishes next key for stale active', async () => {
    const now = Date.now()
    const db = new SigningKeysD1()
    db.keys.push(
      {
        id: 'sk_retiring',
        instance_id: 'inst_1',
        kid: 'retiring-kid',
        alg: 'ES256',
        status: 'retiring',
        activated_at: now - 200_000,
        retire_after: now - 1_000,
        public_key_jwk: '{}',
        private_key_iv: '',
        private_key_ciphertext: '',
        private_key_tag: '',
        kek_version: 1,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'sk_active',
        instance_id: 'inst_1',
        kid: 'active-kid',
        alg: 'ES256',
        status: 'active',
        activated_at: now - 91 * 24 * 60 * 60 * 1000,
        retire_after: null,
        public_key_jwk: '{}',
        private_key_iv: '',
        private_key_ciphertext: '',
        private_key_tag: '',
        kek_version: 1,
        created_at: now,
        updated_at: now,
      },
    )

    const env = { DB: db, KEK: makeKekB64() } as unknown as Env
    await rotateSigningKeysCheck(env)

    expect(db.keys.find((k) => k.kid === 'retiring-kid')?.status).toBe('retired')
    const next = db.keys.find((k) => k.status === 'next' && k.instance_id === 'inst_1')
    expect(next).toBeDefined()
    expect(next?.public_key_jwk).toContain('crv')
  })

  it('does not publish next key when active key is still within the age window', async () => {
    const now = Date.now()
    const db = new SigningKeysD1()
    db.keys.push({
      id: 'sk_active',
      instance_id: 'inst_1',
      kid: 'active-kid',
      alg: 'ES256',
      status: 'active',
      activated_at: now - 30 * 24 * 60 * 60 * 1000,
      retire_after: null,
      public_key_jwk: '{}',
      private_key_iv: '',
      private_key_ciphertext: '',
      private_key_tag: '',
      kek_version: 1,
      created_at: now,
      updated_at: now,
    })

    const env = { DB: db, KEK: makeKekB64() } as unknown as Env
    await rotateSigningKeysCheck(env)

    expect(db.keys.some((k) => k.status === 'next')).toBe(false)
    expect(
      db.runs.some((run) => run.sql.toLowerCase().includes('insert into instance_signing_keys')),
    ).toBe(false)
  })

  it('does not publish next key when instance already has a next key queued', async () => {
    const now = Date.now()
    const db = new SigningKeysD1()
    db.keys.push(
      {
        id: 'sk_active',
        instance_id: 'inst_1',
        kid: 'active-kid',
        alg: 'ES256',
        status: 'active',
        activated_at: now - 91 * 24 * 60 * 60 * 1000,
        retire_after: null,
        public_key_jwk: '{}',
        private_key_iv: '',
        private_key_ciphertext: '',
        private_key_tag: '',
        kek_version: 1,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'sk_next',
        instance_id: 'inst_1',
        kid: 'next-kid',
        alg: 'ES256',
        status: 'next',
        activated_at: null,
        retire_after: null,
        public_key_jwk: '{}',
        private_key_iv: '',
        private_key_ciphertext: '',
        private_key_tag: '',
        kek_version: 1,
        created_at: now,
        updated_at: now,
      },
    )

    const env = { DB: db, KEK: makeKekB64() } as unknown as Env
    await rotateSigningKeysCheck(env)

    expect(db.keys.filter((k) => k.status === 'next')).toHaveLength(1)
    expect(db.keys.find((k) => k.kid === 'next-kid')?.status).toBe('next')
    expect(
      db.runs.some((run) => run.sql.toLowerCase().includes('insert into instance_signing_keys')),
    ).toBe(false)
  })
})
