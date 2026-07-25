// backup-codes 测试:generateBackupCodes/verifyAndConsumeBackupCode/countRemainingBackupCodes。
// SHA-256 用 Node 全局真实 Web Crypto;D1 用最小 fake。

import { describe, it, expect } from 'vitest'
import {
  generateBackupCodes,
  verifyAndConsumeBackupCode,
  countRemainingBackupCodes,
} from '../backup-codes'
import type { TenantContext } from '@xid-kit/types'
import { base64UrlDecode, hmacSha256Base64 } from '@xid-kit/crypto'

const TENANT: TenantContext = {
  tenantId: 't_1',
  issuer: 'https://acme.example.test',
  rpId: 'acme.example.test',
  signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
  policy: {},
}

// 测试 pepper(base64url),与 backup-codes.ts hashCode 同算法计算期望哈希。
const PEPPER = base64UrlDecode(Buffer.from('A'.repeat(32)).toString('base64url'))
const TEST_PEPPER = Buffer.from('A'.repeat(32)).toString('base64url')

function expectedHash(code: string): Promise<string> {
  return hmacSha256Base64(PEPPER, code.toUpperCase().trim())
}

function asUnknown<T>(v: unknown): T {
  return v as T
}

type BackupRow = {
  id: string
  tenant_id: string
  user_id: string
  batch_id: string
  code_hash: string
  used: number
  used_at: number | null
  created_at: number
}

// 最小 D1 fake:模拟 backup_codes 的单条批量 INSERT 与单活动 batch trigger。
function makeFakeD1(table: BackupRow[]): D1Database {
  const matchRows = (sql: string, params: unknown[]): BackupRow[] => {
    const lower = sql.toLowerCase()
    if (lower.startsWith('delete')) {
      // 删除所有匹配的行(模拟 delete where tenant_id=? AND user_id=?)
      const stringParams = params.filter((v): v is string => typeof v === 'string')
      const remaining = table.filter(
        (r) => !stringParams.every((v) => Object.values(r as Record<string, unknown>).includes(v)),
      )
      table.splice(0, table.length, ...remaining)
      return []
    }
    if (lower.startsWith('insert')) {
      const fieldCount = params.length / 10
      if (!Number.isInteger(fieldCount)) throw new Error('backup code insert must contain ten rows')
      const inserted: BackupRow[] = []
      for (let index = 0; index < 10; index++) {
        const offset = index * fieldCount
        const row: BackupRow = {
          id: String(params[offset]),
          tenant_id: String(params[offset + 1]),
          user_id: String(params[offset + 2]),
          batch_id: String(params[offset + 3]),
          code_hash: String(params[offset + 4]),
          used: Number(params[offset + 5]),
          used_at: (params[offset + 6] as number | null) ?? null,
          created_at: Number(params[offset + 7]),
        }
        for (let tableIndex = table.length - 1; tableIndex >= 0; tableIndex--) {
          const current = table[tableIndex]
          if (
            current?.tenant_id === row.tenant_id &&
            current.user_id === row.user_id &&
            current.batch_id !== row.batch_id
          ) {
            table.splice(tableIndex, 1)
          }
        }
        table.push(row)
        inserted.push(row)
      }
      return inserted
    }
    if (lower.startsWith('update')) {
      // 条件更新 used=0 的恢复码，返回受影响行模拟 RETURNING。
      const stringParams = params.filter((v): v is string => typeof v === 'string')
      for (const r of table) {
        if (stringParams.includes(r.id) && r.used === 0) {
          r.used = 1
          return [r]
        }
      }
      return []
    }
    // select: 按字符串参数过滤
    const stringParams = params.filter((v): v is string => typeof v === 'string')
    return table.filter((r) => {
      if (stringParams.length === 0) return true
      return stringParams.every((v) => Object.values(r as Record<string, unknown>).includes(v))
    })
  }

  const prepare = (sql: string): unknown => {
    let bound: unknown[] = []
    const stmt = {
      bind: (...p: unknown[]) => {
        bound = p
        return stmt
      },
      raw: async () => {
        const rows = matchRows(sql, bound)
        if (/select\s+count\s*\(\s*\*\s*\)/i.test(sql)) return [[rows.length]]
        return rows.map((r) => Object.values(r))
      },
      all: async () => ({ results: matchRows(sql, bound), success: true, meta: {} }),
      run: async () => {
        // Drizzle DELETE/UPDATE 走 run(),需要在此执行副作用
        matchRows(sql, bound)
        return { results: [], success: true, meta: {} }
      },
    }
    return stmt
  }
  return asUnknown<D1Database>({ prepare, batch: async () => [] })
}

// 预置 returning 行到 table(insertMany 需要 table 中已有行供 returning 读)
async function seedTableWithCodes(
  userId: string,
  batchId: string,
  codes: string[],
): Promise<BackupRow[]> {
  return Promise.all(
    codes.map(async (code, i) => ({
      id: `bc_${i}`,
      tenant_id: 't_1',
      user_id: userId,
      batch_id: batchId,
      code_hash: await expectedHash(code),
      used: 0,
      used_at: null,
      created_at: Date.now(),
    })),
  )
}

// ---- generateBackupCodes ----
describe('generateBackupCodes', () => {
  it('生成 10 个不重复的 8 字符恢复码', async () => {
    const table: BackupRow[] = []
    // 预置 10 行(供 insertMany returning)
    for (let i = 0; i < 10; i++) {
      table.push({
        id: `bc_${i}`,
        tenant_id: 't_1',
        user_id: 'u_1',
        batch_id: 'b_1',
        code_hash: 'h',
        used: 0,
        used_at: null,
        created_at: Date.now(),
      })
    }
    const db = makeFakeD1(table)
    const result = await generateBackupCodes({
      ctx: TENANT,
      d1: db,
      userId: 'u_1',
      pepper: TEST_PEPPER,
      baseIdPrefix: 'bc_',
    })

    expect(result.codes.length).toBe(10)
    expect(typeof result.batchId).toBe('string')
    for (const code of result.codes) {
      expect(code.length).toBe(8)
    }
    const unique = new Set(result.codes)
    expect(unique.size).toBe(10)
  })

  it('重生成时先清空旧批次(delete 被调用)', async () => {
    const table: BackupRow[] = [
      {
        id: 'old_1',
        tenant_id: 't_1',
        user_id: 'u_1',
        batch_id: 'old_batch',
        code_hash: 'h',
        used: 0,
        used_at: null,
        created_at: Date.now(),
      },
    ]
    // 补充 10 个 returning 行
    for (let i = 0; i < 10; i++) {
      table.push({
        id: `bc_${i}`,
        tenant_id: 't_1',
        user_id: 'u_1',
        batch_id: 'b_new',
        code_hash: 'h',
        used: 0,
        used_at: null,
        created_at: Date.now(),
      })
    }
    const db = makeFakeD1(table)
    await generateBackupCodes({
      ctx: TENANT,
      d1: db,
      userId: 'u_1',
      baseIdPrefix: 'bc_',
      pepper: TEST_PEPPER,
    })
    const remaining = table.filter((r) => r.batch_id === 'old_batch')
    expect(remaining.length).toBe(0)
  })

  it('并发重生成后只保留一个十码活动批次', async () => {
    const table: BackupRow[] = []
    const db = makeFakeD1(table)

    const results = await Promise.all([
      generateBackupCodes({
        ctx: TENANT,
        d1: db,
        userId: 'u_1',
        baseIdPrefix: 'bc_',
        pepper: TEST_PEPPER,
      }),
      generateBackupCodes({
        ctx: TENANT,
        d1: db,
        userId: 'u_1',
        baseIdPrefix: 'bc_',
        pepper: TEST_PEPPER,
      }),
    ])

    const activeRows = table.filter((row) => row.user_id === 'u_1')
    const batches = new Set(activeRows.map((row) => row.batch_id))
    expect(activeRows).toHaveLength(10)
    expect(batches).toHaveLength(1)
    expect(results.map((result) => result.batchId)).toContain(activeRows[0]?.batch_id)
  })
})

// ---- verifyAndConsumeBackupCode ----
describe('verifyAndConsumeBackupCode', () => {
  it('正确 code -> ok,codeId 正确', async () => {
    const code = 'ABCD1234'
    const rows = await seedTableWithCodes('u_1', 'b_1', [code])
    const table = [...rows]
    const db = makeFakeD1(table)
    const res = await verifyAndConsumeBackupCode({
      ctx: TENANT,
      d1: db,
      userId: 'u_1',
      code,
      pepper: TEST_PEPPER,
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.codeId).toBe('bc_0')
  })

  it('错误 code -> not_found', async () => {
    const rows = await seedTableWithCodes('u_1', 'b_1', ['ABCD1234'])
    const db = makeFakeD1([...rows])
    const res = await verifyAndConsumeBackupCode({
      ctx: TENANT,
      d1: db,
      userId: 'u_1',
      pepper: TEST_PEPPER,
      code: 'XXXXXXXX',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('not_found')
  })

  it('已用的 code -> already_used', async () => {
    const code = 'ABCD1234'
    const rows = await seedTableWithCodes('u_1', 'b_1', [code])
    const table = rows.map((r) => ({ ...r, used: 1 }))
    const db = makeFakeD1(table)
    const res = await verifyAndConsumeBackupCode({
      ctx: TENANT,
      d1: db,
      userId: 'u_1',
      code,
      pepper: TEST_PEPPER,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('already_used')
  })

  it('大小写不敏感(code.toUpperCase)', async () => {
    const code = 'abcd1234'
    const rows = await seedTableWithCodes('u_1', 'b_1', ['ABCD1234'])
    const db = makeFakeD1([...rows])
    const res = await verifyAndConsumeBackupCode({
      ctx: TENANT,
      d1: db,
      userId: 'u_1',
      code,
      pepper: TEST_PEPPER,
    })
    expect(res.ok).toBe(true)
  })

  it('并发消费同一恢复码仅允许一个请求成功', async () => {
    const code = 'ABCD1234'
    const table = await seedTableWithCodes('u_1', 'b_1', [code])
    const db = makeFakeD1(table)

    const results = await Promise.all([
      verifyAndConsumeBackupCode({
        ctx: TENANT,
        d1: db,
        userId: 'u_1',
        code,
        pepper: TEST_PEPPER,
      }),
      verifyAndConsumeBackupCode({
        ctx: TENANT,
        d1: db,
        userId: 'u_1',
        code,
        pepper: TEST_PEPPER,
      }),
    ])

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.find((result) => !result.ok)).toMatchObject({ reason: 'already_used' })
  })
})

// ---- countRemainingBackupCodes ----
describe('countRemainingBackupCodes', () => {
  it('返回未用数量', async () => {
    const rows: BackupRow[] = [
      {
        id: 'bc_0',
        tenant_id: 't_1',
        user_id: 'u_1',
        batch_id: 'b',
        code_hash: 'h1',
        used: 0,
        used_at: null,
        created_at: Date.now(),
      },
      {
        id: 'bc_1',
        tenant_id: 't_1',
        user_id: 'u_1',
        batch_id: 'b',
        code_hash: 'h2',
        used: 1,
        used_at: Date.now(),
        created_at: Date.now(),
      },
      {
        id: 'bc_2',
        tenant_id: 't_1',
        user_id: 'u_1',
        batch_id: 'b',
        code_hash: 'h3',
        used: 0,
        used_at: null,
        created_at: Date.now(),
      },
    ]
    // 测试替身只保留未使用行,使 count 查询的结果独立于布尔参数解析。
    const unusedRows = rows.filter((r) => r.used === 0)
    const db = makeFakeD1(unusedRows)
    const count = await countRemainingBackupCodes({ ctx: TENANT, d1: db, userId: 'u_1' })
    expect(count).toBe(2)
  })
})
