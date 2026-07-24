// daily cron 纯函数单元测试:上月归档窗口判断。
import { describe, expect, it } from 'vitest'
import { getPrevYearMonth, shouldArchivePrevMonth } from '../daily'

describe('getPrevYearMonth', () => {
  it('returns previous month within same year', () => {
    expect(getPrevYearMonth(new Date('2026-06-15T00:00:00Z'))).toBe('2026-05')
  })

  it('rolls back to December of previous year in January', () => {
    expect(getPrevYearMonth(new Date('2026-01-10T00:00:00Z'))).toBe('2025-12')
  })
})

describe('shouldArchivePrevMonth', () => {
  it('returns true only on the first UTC day of month', () => {
    expect(shouldArchivePrevMonth(new Date('2026-06-01T12:00:00Z'))).toBe(true)
    expect(shouldArchivePrevMonth(new Date('2026-06-02T00:00:00Z'))).toBe(false)
  })
})
