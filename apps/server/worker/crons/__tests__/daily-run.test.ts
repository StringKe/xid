// daily cron 编排单元测试:runDaily 各阶段触达与 MAU 归档窗口门控。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportMonthlyMau, runDaily } from '../daily'

function makeDailyD1(): { db: D1Database; sqlLog: string[] } {
  const sqlLog: string[] = []
  const db = {
    prepare: (sql: string) => {
      const statement = {
        bind: (..._args: unknown[]) => ({
          run: async () => {
            sqlLog.push(sql)
            return { success: true }
          },
          all: async () => {
            sqlLog.push(sql)
            return { results: [] }
          },
        }),
        run: async () => {
          sqlLog.push(sql)
          return { success: true }
        },
        all: async () => {
          sqlLog.push(sql)
          return { results: [] }
        },
      }
      return statement
    },
  } as unknown as D1Database
  return { db, sqlLog }
}

describe('reportMonthlyMau archive window', () => {
  it('no-ops when not the first UTC day of the month', async () => {
    const getMau = vi.fn()
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => ({ results: [{ tenant_id: 'org_01' }] }),
          }),
        }),
      },
      METERING: {
        idFromName: () => 'metering:org_01',
        get: () => ({ getMau, evictMonth: vi.fn() }),
      },
    } as unknown as Env

    await reportMonthlyMau(env, new Date(Date.UTC(2026, 5, 15)))

    expect(getMau).not.toHaveBeenCalled()
  })
})

describe('runDaily', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('touches signing keys, certificates, domains, SAML metadata, and usage maintenance', async () => {
    const { db, sqlLog } = makeDailyD1()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))

    const env = {
      DB: db,
      KEK: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      METERING: {
        idFromName: () => 'metering:org_01',
        get: () => ({
          getMau: vi.fn().mockResolvedValue(0),
          evictMonth: vi.fn().mockResolvedValue(undefined),
        }),
      },
      WEBHOOK_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Env

    await runDaily(env)

    const joined = sqlLog.join('\n')
    expect(joined).toContain('instance_signing_keys')
    expect(joined).toContain('cert_store')
    expect(joined).toContain('organization_domains')
    expect(joined).toContain('sso_connections')
    expect(joined).toMatch(/usage_monthly|organizations/)
  })

  it('runs signing backfill before rotation and usage maintenance last', async () => {
    const { db, sqlLog } = makeDailyD1()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))

    const env = {
      DB: db,
      KEK: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      METERING: {
        idFromName: () => 'metering:org_01',
        get: () => ({
          getMau: vi.fn().mockResolvedValue(0),
          evictMonth: vi.fn().mockResolvedValue(undefined),
        }),
      },
      WEBHOOK_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Env

    await runDaily(env)

    const backfillIdx = sqlLog.findIndex((sql) => sql.includes('retire_after IS NULL'))
    const rotateIdx = sqlLog.findIndex((sql) => sql.includes("status = 'retired'"))
    const usageIdx = sqlLog.findIndex(
      (sql) => sql.includes('usage_monthly') || sql.toLowerCase().includes('from organizations'),
    )
    const certIdx = sqlLog.findIndex((sql) => sql.includes('cert_store'))
    expect(backfillIdx).toBeGreaterThanOrEqual(0)
    expect(rotateIdx).toBeGreaterThan(backfillIdx)
    expect(certIdx).toBeGreaterThan(rotateIdx)
    expect(usageIdx).toBeGreaterThan(certIdx)
  })
})
