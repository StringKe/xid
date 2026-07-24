import { afterEach, describe, it, expect, vi } from 'vitest'

import { pollCertificateStatus, pollDomainVerification, verifyDomainDnsTxt } from '../daily'

type CertRow = { id: string; status: string; not_after: number | null; updated_at: number }

class CertStoreD1 {
  certs: CertRow[] = []
  readonly runs: Array<{ sql: string; args: unknown[] }> = []

  prepare = (sql: string) => {
    const stmt = {
      bind: (...args: unknown[]) => ({
        run: async () => {
          this.runs.push({ sql, args })
          const normalized = sql.toLowerCase()
          if (normalized.includes("set status = 'expiring'")) {
            const soon = Number(args[1])
            const now = Number(args[0])
            for (const row of this.certs) {
              if (row.status === 'active' && row.not_after !== null && row.not_after < soon) {
                row.status = 'expiring'
                row.updated_at = now
              }
            }
          }
          return { success: true }
        },
      }),
    }
    return stmt
  }
}

describe('verifyDomainDnsTxt', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns true when TXT record matches xid-verify token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          Answer: [{ data: '"xid-verify=token_abc"' }],
        }),
      ),
    )
    expect(await verifyDomainDnsTxt('acme.com', 'token_abc')).toBe(true)
  })

  it('returns false when DNS response has no matching record', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ Answer: [{ data: '"other=value"' }] })),
    )
    expect(await verifyDomainDnsTxt('acme.com', 'token_abc')).toBe(false)
  })

  it('returns false when DNS query fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 500 })),
    )
    expect(await verifyDomainDnsTxt('acme.com', 'token_abc')).toBe(false)
  })
})

type DomainRow = {
  id: string
  domain: string
  verification_token: string
  verification_status: string
  status: string
}

class DomainPollD1 {
  domains: DomainRow[] = []
  prepare = (sql: string) => {
    return {
      bind: (...args: unknown[]) => ({
        all: async <T>() => {
          if (sql.toLowerCase().includes("verification_status = 'pending'")) {
            return {
              results: this.domains.filter(
                (row) => row.verification_status === 'pending' && row.status === 'active',
              ) as T[],
            }
          }
          return { results: [] as T[] }
        },
        run: async () => {
          if (sql.toLowerCase().includes("verification_status = 'verified'")) {
            const id = String(args[2])
            const row = this.domains.find((d) => d.id === id)
            if (row) row.verification_status = 'verified'
          }
          return { success: true }
        },
      }),
    }
  }
}

describe('pollDomainVerification', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('leaves domain pending when DNS TXT does not match', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ Answer: [{ data: '"other=value"' }] })),
    )
    const db = new DomainPollD1()
    db.domains.push({
      id: 'dom_1',
      domain: 'acme.com',
      verification_token: 'abc123',
      verification_status: 'pending',
      status: 'active',
    })
    await pollDomainVerification({ DB: db } as unknown as Env)
    expect(db.domains[0]?.verification_status).toBe('pending')
  })

  it('marks domain verified when DNS TXT matches token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ Answer: [{ data: '"xid-verify=abc123"' }] })),
    )
    const db = new DomainPollD1()
    db.domains.push({
      id: 'dom_1',
      domain: 'acme.com',
      verification_token: 'abc123',
      verification_status: 'pending',
      status: 'active',
    })
    await pollDomainVerification({ DB: db } as unknown as Env)
    expect(db.domains[0]?.verification_status).toBe('verified')
  })
})

describe('pollCertificateStatus', () => {
  it('no-ops when no active certs are within the 30-day window', async () => {
    const db = new CertStoreD1()
    const now = Date.now()
    db.certs.push({
      id: 'c_far',
      status: 'active',
      not_after: now + 60 * 24 * 60 * 60 * 1000,
      updated_at: now,
    })
    await pollCertificateStatus({ DB: db } as unknown as Env)
    expect(db.certs[0]?.status).toBe('active')
    expect(db.runs).toHaveLength(1)
  })

  it('marks active certs expiring within 30 days', async () => {
    const db = new CertStoreD1()
    const now = Date.now()
    db.certs.push(
      { id: 'c1', status: 'active', not_after: now + 1_000, updated_at: now },
      { id: 'c2', status: 'active', not_after: now + 40 * 24 * 60 * 60 * 1000, updated_at: now },
    )
    const env = { DB: db } as unknown as Env
    await pollCertificateStatus(env)
    expect(db.certs.find((c) => c.id === 'c1')?.status).toBe('expiring')
    expect(db.certs.find((c) => c.id === 'c2')?.status).toBe('active')
  })
})
