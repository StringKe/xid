import { afterEach, describe, it, expect, vi } from 'vitest'

import { pollDomainVerification, verifyDomainDnsTxt } from '../daily'

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
  tenant_id: string
  domain: string
  verification_token: string
  verification_status: string
  status: string
  last_check_result?: string
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
          if (sql.toLowerCase().includes('set last_checked_at')) {
            const [, result, status, , , tenantId, id] = args
            const row = this.domains.find((d) => d.id === id && d.tenant_id === tenantId)
            if (row) {
              row.verification_status = String(status)
              row.last_check_result = String(result)
            }
          }
          return { success: true }
        },
      }),
    }
  }
}

function pendingDomain(id: string, domain: string, token: string): DomainRow {
  return {
    id,
    tenant_id: 'org_a',
    domain,
    verification_token: token,
    verification_status: 'pending',
    status: 'active',
  }
}

describe('pollDomainVerification', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('leaves domain pending and records the miss when DNS TXT does not match', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ Answer: [{ data: '"other=value"' }] })),
    )
    const db = new DomainPollD1()
    db.domains.push(pendingDomain('dom_1', 'acme.com', 'abc123'))

    await pollDomainVerification({ DB: db } as unknown as Env)

    expect(db.domains[0]?.verification_status).toBe('pending')
    expect(db.domains[0]?.last_check_result).toBe('not_found')
  })

  it('marks domain verified and records the hit when DNS TXT matches token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ Answer: [{ data: '"xid-verify=abc123"' }] })),
    )
    const db = new DomainPollD1()
    db.domains.push(pendingDomain('dom_1', 'acme.com', 'abc123'))

    await pollDomainVerification({ DB: db } as unknown as Env)

    expect(db.domains[0]?.verification_status).toBe('verified')
    expect(db.domains[0]?.last_check_result).toBe('found')
  })

  it('bounds each DNS lookup and keeps polling remaining domains after a timeout', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url).includes('_xid.slow.com')) {
        throw new DOMException('The operation timed out.', 'TimeoutError')
      }
      return Response.json({ Answer: [{ data: '"xid-verify=fast_token"' }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const db = new DomainPollD1()
    db.domains.push(
      pendingDomain('dom_slow', 'slow.com', 'slow_token'),
      pendingDomain('dom_fast', 'fast.com', 'fast_token'),
    )

    await pollDomainVerification({ DB: db } as unknown as Env)

    expect(fetchMock.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true)
    expect(db.domains.map((row) => row.verification_status)).toEqual(['pending', 'verified'])
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cron.daily.domain_dns_lookup_failed' }),
    )
    consoleError.mockRestore()
  })
})
