// 每日用量维护:当月 MAU 快照、月初归档上月 MAU、补清过期 MeteringDO 月份、滚动清理旧聚合。

import { eachActiveTenant } from './active-tenants'

// MeteringDO RPC stub(取最终 MAU 数值)。
type MeteringCountStub = {
  getMau(tenantId: string, yearMonth: string): Promise<number>
  evictMonth(yearMonth: string): Promise<void>
}

type UsageMonthlyInput = {
  tenantId: string
  yearMonth: string
  mau: number
  archivedAt: string
}

const METERING_EVICT_PAGE_SIZE = 50

// 上月 "YYYY-MM"(UTC)。
export function getPrevYearMonth(now: Date = new Date()): string {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() // 0-based,当前月
  // 上一个月:m===0 时跨年
  const prev = m === 0 ? new Date(Date.UTC(y - 1, 11, 1)) : new Date(Date.UTC(y, m - 1, 1))
  const py = prev.getUTCFullYear()
  const pm = String(prev.getUTCMonth() + 1).padStart(2, '0')
  return `${py}-${pm}`
}

// 当月第一天只归档上月,避免每天重复上报同一周期。
export function shouldArchivePrevMonth(now: Date = new Date()): boolean {
  return now.getUTCDate() === 1
}

async function upsertUsageMonthly(env: Env, input: UsageMonthlyInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage_monthly (tenant_id, year_month, mau, archived_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (tenant_id, year_month) DO UPDATE SET mau = MAX(usage_monthly.mau, excluded.mau), archived_at = excluded.archived_at`,
  )
    .bind(input.tenantId, input.yearMonth, input.mau, input.archivedAt)
    .run()
}

function meteringStub(env: Env, tenantId: string): DurableObjectStub & MeteringCountStub {
  return env.METERING.get(
    env.METERING.idFromName(`metering:${tenantId}`),
  ) as unknown as DurableObjectStub & MeteringCountStub
}

// MAU 归档:从 MeteringDO 取上月最终 MAU,写 usage_monthly。
export async function reportMonthlyMau(env: Env, now: Date = new Date()): Promise<void> {
  if (!shouldArchivePrevMonth(now)) return
  const yearMonth = getPrevYearMonth(now)
  const archivedAt = now.toISOString()
  await eachActiveTenant(env, async (tenantId) => {
    const stub = meteringStub(env, tenantId)
    const mau = await stub.getMau(tenantId, yearMonth)
    await upsertUsageMonthly(env, { tenantId, yearMonth, mau, archivedAt })
    await stub.evictMonth(yearMonth)
  })
}

// 月初归档失败或租户已非 active 时,上月 DO 计数不会被 reportMonthlyMau 清掉。
// 每日按 usage_monthly 有用量的租户补清两个月前的月份,不依赖单次月初运行成功。
export async function evictStaleMeteringMonth(env: Env, now: Date = new Date()): Promise<void> {
  const staleYearMonth = getPrevYearMonth(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
  )
  let cursor: string | null = null
  while (true) {
    const where: string = cursor === null ? '' : 'AND tenant_id > ?'
    const params: unknown[] =
      cursor === null
        ? [staleYearMonth, METERING_EVICT_PAGE_SIZE]
        : [staleYearMonth, cursor, METERING_EVICT_PAGE_SIZE]
    const rows: D1Result<{ tenant_id: string }> = await env.DB.prepare(
      `SELECT tenant_id FROM usage_monthly
         WHERE year_month = ? AND mau > 0 ${where}
         ORDER BY tenant_id
         LIMIT ?`,
    )
      .bind(...params)
      .all<{ tenant_id: string }>()
    if (rows.results.length === 0) return
    for (const { tenant_id } of rows.results) {
      await meteringStub(env, tenant_id).evictMonth(staleYearMonth)
    }
    cursor = rows.results[rows.results.length - 1]?.tenant_id ?? null
    if (rows.results.length < METERING_EVICT_PAGE_SIZE) return
  }
}

// 当月快照:platform billing/stats 读取 usage_monthly 当月行,每日补齐 active tenant 当前 MAU。
export async function snapshotCurrentMonthMau(env: Env, now: Date = new Date()): Promise<void> {
  const yearMonth = now.toISOString().slice(0, 7)
  const archivedAt = now.toISOString()
  await eachActiveTenant(env, async (tenantId) => {
    const mau = await meteringStub(env, tenantId).getMau(tenantId, yearMonth)
    await upsertUsageMonthly(env, { tenantId, yearMonth, mau, archivedAt })
  })
}

export async function cleanupOldMonthlyUsage(env: Env, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 1))
  const cutoffYearMonth = cutoff.toISOString().slice(0, 7)
  await hardDeleteOldMonthlyUsage(env, cutoffYearMonth)
}

// 物理删除只用于按保留期滚动清理聚合计量事实。审计事件和身份资源不走此路径。
export async function hardDeleteOldMonthlyUsage(env: Env, cutoffYearMonth: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM usage_monthly WHERE year_month < ?`).bind(cutoffYearMonth).run()
}

export async function runMonthlyUsageMaintenance(env: Env, now: Date = new Date()): Promise<void> {
  await snapshotCurrentMonthMau(env, now)
  await reportMonthlyMau(env, now)
  await evictStaleMeteringMonth(env, now)
  if (shouldArchivePrevMonth(now)) {
    await cleanupOldMonthlyUsage(env, now)
  }
}
