// Cron dispatch 与 daily/hourly 任务测试。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { dispatchScheduled, CRON_HOURLY, CRON_DAILY } from '../index'
import {
  cleanupOldMonthlyUsage,
  getPrevYearMonth,
  hardDeleteOldMonthlyUsage,
  pollDomainVerification,
  pollSamlIdpMetadata,
  reportMonthlyMau,
  runMonthlyUsageMaintenance,
  shouldArchivePrevMonth,
  snapshotCurrentMonthMau,
  verifyDomainDnsTxt,
} from '../daily'
import {
  aggregateDau,
  cleanupExpiredAccessTokenRevocations,
  hardDeleteExpiredSessions,
} from '../hourly'

type Row = Record<string, unknown>

type Prepared = {
  sql: string
  args: unknown[]
}

function makeStatement(sql: string, env: FakeD1) {
  return {
    bind: (...args: unknown[]) => ({
      all: <T>() => env.all<T>(sql, args),
      run: () => env.run(sql, args),
    }),
    all: <T>() => env.all<T>(sql, []),
    run: () => env.run(sql, []),
  }
}

class FakeD1 {
  readonly prepared: Prepared[] = []
  readonly runs: Prepared[] = []
  readonly batches: Prepared[][] = []

  constructor(
    private readonly data: {
      tenants?: Row[]
      domains?: Row[]
      connections?: Row[]
    } = {},
  ) {}

  prepare(sql: string) {
    this.prepared.push({ sql, args: [] })
    return makeStatement(sql, this)
  }

  batch(statements: unknown[]) {
    this.batches.push(statements as Prepared[])
    return Promise.resolve([])
  }

  all<T>(sql: string, args: unknown[]) {
    const normalized = sql.toLowerCase()
    if (normalized.includes('from organization_domains')) {
      return Promise.resolve({ results: (this.data.domains ?? []) as T[] })
    }
    if (normalized.includes('from sso_connections')) {
      const limit = Number(args[args.length - 1] ?? 50)
      const cursor = typeof args[0] === 'string' && args.length > 1 ? args[0] : null
      const rows = (this.data.connections ?? []).filter(
        (row) => cursor === null || String(row['id']) > cursor,
      )
      return Promise.resolve({ results: rows.slice(0, limit) as T[] })
    }
    if (normalized.includes('from organizations')) {
      const limit = Number(args[args.length - 1] ?? 50)
      const cursor = typeof args[0] === 'string' && args.length > 1 ? args[0] : null
      const rows = (this.data.tenants ?? []).filter(
        (row) => cursor === null || String(row['tenant_id'] ?? row['id']) > cursor,
      )
      return Promise.resolve({ results: rows.slice(0, limit) as T[] })
    }
    return Promise.resolve({ results: [] as T[] })
  }

  run(sql: string, args: unknown[]) {
    this.runs.push({ sql, args })
    return Promise.resolve({ success: true })
  }
}

function makeMetering(mau: Record<string, number>) {
  const evicted: string[] = []
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => {
      const tenantId = id.replace('metering:', '')
      return {
        getMau: vi.fn((_tenantId: string, _yearMonth: string) =>
          Promise.resolve(mau[tenantId] ?? 0),
        ),
        evictMonth: vi.fn((yearMonth: string) => {
          evicted.push(`${tenantId}:${yearMonth}`)
          return Promise.resolve()
        }),
      }
    },
  }
  return { namespace, evicted }
}

function idpMetadataXml(cert: string): string {
  return [
    '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="https://idp.example.com/metadata">',
    '<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">',
    '<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>',
    cert,
    '</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>',
    '<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>',
    '</md:IDPSSODescriptor>',
    '</md:EntityDescriptor>',
  ].join('')
}

describe('CRON 常量与 wrangler.jsonc 一致', () => {
  it('每小时 0 * * * *,每天 0 2 * * *', () => {
    expect(CRON_HOURLY).toBe('0 * * * *')
    expect(CRON_DAILY).toBe('0 2 * * *')
  })
})

describe('dispatchScheduled:未知 cron no-op', () => {
  it('未知表达式不抛错且不访问 env', async () => {
    const env = {} as Env
    await expect(dispatchScheduled('5 5 5 5 5', env)).resolves.toBeUndefined()
  })
})

describe('getPrevYearMonth:上月计算', () => {
  it('月中返回上一月', () => {
    expect(getPrevYearMonth(new Date(Date.UTC(2025, 5, 15)))).toBe('2025-05')
  })

  it('1 月跨年返回上一年 12 月', () => {
    expect(getPrevYearMonth(new Date(Date.UTC(2025, 0, 1)))).toBe('2024-12')
  })

  it('零填充月份', () => {
    expect(getPrevYearMonth(new Date(Date.UTC(2025, 2, 10)))).toBe('2025-02')
  })
})

describe('shouldArchivePrevMonth', () => {
  it('仅 UTC 每月 1 日归档上月', () => {
    expect(shouldArchivePrevMonth(new Date(Date.UTC(2025, 5, 1)))).toBe(true)
    expect(shouldArchivePrevMonth(new Date(Date.UTC(2025, 5, 2)))).toBe(false)
  })
})

describe('verifyDomainDnsTxt', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('查询 _xid 子域 TXT 并匹配 xid-verify token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ Answer: [{ data: '"xid-verify=tok_1"' }] }),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await expect(verifyDomainDnsTxt('example.com', 'tok_1')).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloudflare-dns.com/dns-query?name=_xid.example.com&type=TXT',
      { headers: { accept: 'application/dns-json' } },
    )
  })
})

describe('pollDomainVerification', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('pending domain DNS TXT 命中后更新 verified_at', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ Answer: [{ data: '"xid-verify=tok"' }] }),
    }) as unknown as typeof fetch
    const db = new FakeD1({
      domains: [{ id: 'dom_1', domain: 'example.com', verification_token: 'tok' }],
    })
    await pollDomainVerification({ DB: db } as unknown as Env)
    expect(db.runs.some((run) => run.sql.includes('SET verification_status ='))).toBe(true)
    expect(db.runs[0]?.args[2]).toBe('dom_1')
  })
})

describe('pollSamlIdpMetadata', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('拉取 metadata URL 并更新 SAML IdP 配置', async () => {
    const cert = 'CERT_NEW'
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(idpMetadataXml(cert))) as unknown as typeof fetch
    const sent: Row[] = []
    const db = new FakeD1({
      connections: [
        {
          id: 'conn_1',
          tenant_id: 'tenant_1',
          org_id: 'org_1',
          idp_metadata_url: 'https://idp.example.com/metadata.xml',
          idp_certificates: JSON.stringify(['CERT_OLD']),
        },
      ],
    })
    const env = {
      DB: db,
      WEBHOOK_QUEUE: {
        send: (msg: Row) => {
          sent.push(msg)
          return Promise.resolve()
        },
      },
    } as unknown as Env

    await pollSamlIdpMetadata(env)

    const update = db.runs.find((run) => run.sql.includes('UPDATE sso_connections'))
    expect(update?.args.slice(0, 3)).toEqual([
      'https://idp.example.com/metadata',
      'https://idp.example.com/sso',
      JSON.stringify([cert]),
    ])
    expect(sent[0]?.['event']).toBe('connection.saml_certificate_renewed')
  })

  it('证书未变化时不发送 certificate renewed webhook', async () => {
    const cert = 'CERT_SAME'
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(idpMetadataXml(cert))) as unknown as typeof fetch
    const sent: Row[] = []
    const db = new FakeD1({
      connections: [
        {
          id: 'conn_1',
          tenant_id: 'tenant_1',
          org_id: 'org_1',
          idp_metadata_url: 'https://idp.example.com/metadata.xml',
          idp_certificates: JSON.stringify([cert]),
        },
      ],
    })
    const env = {
      DB: db,
      WEBHOOK_QUEUE: {
        send: (msg: Row) => {
          sent.push(msg)
          return Promise.resolve()
        },
      },
    } as unknown as Env

    await pollSamlIdpMetadata(env)

    expect(db.runs.some((run) => run.sql.includes('UPDATE sso_connections'))).toBe(true)
    expect(sent).toHaveLength(0)
  })
})

describe('usage maintenance', () => {
  it('reportMonthlyMau 月初分页归档上月并 evict DO 月份', async () => {
    const tenants = Array.from({ length: 51 }, (_, i) => ({
      tenant_id: `org_${String(i + 1).padStart(2, '0')}`,
    }))
    const db = new FakeD1({ tenants })
    const metering = makeMetering({ org_01: 7, org_51: 3 })
    const env = { DB: db, METERING: metering.namespace } as unknown as Env
    await reportMonthlyMau(env, new Date(Date.UTC(2025, 5, 1)))
    const upserts = db.runs.filter((run) => run.sql.includes('INSERT INTO usage_monthly'))
    expect(upserts).toHaveLength(51)
    expect(upserts[0]?.args.slice(0, 3)).toEqual(['org_01', '2025-05', 7])
    expect(metering.evicted).toContain('org_01:2025-05')
    expect(metering.evicted).toContain('org_51:2025-05')
  })

  it('snapshotCurrentMonthMau 写当前月但不 evict', async () => {
    const db = new FakeD1({ tenants: [{ tenant_id: 'org_01' }] })
    const metering = makeMetering({ org_01: 9 })
    const env = { DB: db, METERING: metering.namespace } as unknown as Env
    await snapshotCurrentMonthMau(env, new Date(Date.UTC(2025, 5, 15)))
    const upsert = db.runs.find((run) => run.sql.includes('INSERT INTO usage_monthly'))
    expect(upsert?.args.slice(0, 3)).toEqual(['org_01', '2025-06', 9])
    expect(metering.evicted).toHaveLength(0)
  })

  it('hardDeleteOldMonthlyUsage 只按保留期物理删除旧 monthly usage', async () => {
    const db = new FakeD1()
    await hardDeleteOldMonthlyUsage({ DB: db } as unknown as Env, '2024-05')
    expect(db.runs).toHaveLength(1)
    expect(db.runs[0]?.sql).toContain('DELETE FROM usage_monthly WHERE year_month < ?')
    expect(db.runs[0]?.args).toEqual(['2024-05'])
  })

  it('cleanupOldMonthlyUsage 删除 13 个月前的 usage_monthly 行', async () => {
    const db = new FakeD1()
    await cleanupOldMonthlyUsage({ DB: db } as unknown as Env, new Date(Date.UTC(2026, 5, 15)))
    expect(db.runs).toHaveLength(1)
    expect(db.runs[0]?.args).toEqual(['2025-05'])
  })

  it('runMonthlyUsageMaintenance 月初归档上月并清理过期行', async () => {
    const tenants = [{ tenant_id: 'org_01' }]
    const db = new FakeD1({ tenants })
    const metering = makeMetering({ org_01: 4 })
    const env = { DB: db, METERING: metering.namespace } as unknown as Env
    await runMonthlyUsageMaintenance(env, new Date(Date.UTC(2026, 5, 1)))
    const upserts = db.runs.filter((run) => run.sql.includes('INSERT INTO usage_monthly'))
    expect(upserts.length).toBeGreaterThanOrEqual(2)
    expect(db.runs.some((run) => run.sql.includes('DELETE FROM usage_monthly'))).toBe(true)
    expect(metering.evicted).toContain('org_01:2026-05')
  })

  it('runMonthlyUsageMaintenance 非月初只写当月快照', async () => {
    const db = new FakeD1({ tenants: [{ tenant_id: 'org_01' }] })
    const metering = makeMetering({ org_01: 2 })
    const env = { DB: db, METERING: metering.namespace } as unknown as Env
    await runMonthlyUsageMaintenance(env, new Date(Date.UTC(2026, 5, 15)))
    const upserts = db.runs.filter((run) => run.sql.includes('INSERT INTO usage_monthly'))
    expect(upserts).toHaveLength(1)
    expect(upserts[0]?.args[1]).toBe('2026-06')
    expect(metering.evicted).toHaveLength(0)
    expect(db.runs.some((run) => run.sql.includes('DELETE FROM usage_monthly'))).toBe(false)
  })
})

describe('aggregateDau', () => {
  it('补齐 active tenant 当日 usage_daily 空行', async () => {
    const db = new FakeD1({ tenants: [{ tenant_id: 'org_01' }, { tenant_id: 'org_02' }] })
    await aggregateDau({ DB: db } as unknown as Env)
    expect(db.batches).toHaveLength(1)
    expect(db.batches[0]).toHaveLength(2)
  })
})

describe('session retention cleanup', () => {
  it('hardDeleteExpiredSessions 只物理删除已过期 session 行', async () => {
    const db = new FakeD1()
    await hardDeleteExpiredSessions({ DB: db } as unknown as Env, 123456)
    expect(db.runs).toHaveLength(1)
    expect(db.runs[0]?.sql).toContain(
      'DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < ?',
    )
    expect(db.runs[0]?.args).toEqual([123456])
  })

  it('cleanupExpiredAccessTokenRevocations 物理删除过期 access token denylist 行', async () => {
    const db = new FakeD1()
    await cleanupExpiredAccessTokenRevocations({ DB: db } as unknown as Env, 123456)
    expect(db.runs).toHaveLength(1)
    expect(db.runs[0]?.sql).toContain('DELETE FROM access_token_revocations WHERE expires_at < ?')
    expect(db.runs[0]?.args).toEqual([123456])
  })

  it('cleanupExpiredAccessTokenRevocations 在表未迁移时跳过而不抛错', async () => {
    const db = new FakeD1()
    const originalRun = db.run.bind(db)
    db.run = (sql, args) => {
      if (sql.includes('access_token_revocations')) {
        return Promise.reject(
          new Error('D1_ERROR: no such table: access_token_revocations: SQLITE_ERROR'),
        )
      }
      return originalRun(sql, args)
    }

    await expect(
      cleanupExpiredAccessTokenRevocations({ DB: db } as unknown as Env, 123456),
    ).resolves.toBeUndefined()
  })
})
