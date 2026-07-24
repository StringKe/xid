// platform/shared 分页解析单元测试。
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { XidHonoEnv } from '../../lib/types'
import { MAX_PLATFORM_PAGE_SIZE, parsePlatformPagination } from '../shared'

async function ctxForQuery(query: string) {
  const app = new Hono<XidHonoEnv>()
  let c!: Parameters<typeof parsePlatformPagination>[0]
  app.get('/probe', (ctx) => {
    c = ctx
    return ctx.text('ok')
  })
  await app.request(`https://xid.dev/probe?${query}`)
  return c
}

describe('parsePlatformPagination', () => {
  it('uses fallback limit when query missing or invalid', async () => {
    const c = await ctxForQuery('')
    expect(parsePlatformPagination(c, 20)).toEqual({ limit: 20, cursor: null })
  })

  it('clamps limit to platform max and minimum 1', async () => {
    const over = await ctxForQuery(`limit=${MAX_PLATFORM_PAGE_SIZE + 50}`)
    expect(parsePlatformPagination(over, 20).limit).toBe(MAX_PLATFORM_PAGE_SIZE)

    const zero = await ctxForQuery('limit=0')
    expect(parsePlatformPagination(zero, 30).limit).toBe(1)
  })

  it('passes through cursor query param', async () => {
    const c = await ctxForQuery('limit=15&cursor=abc123')
    expect(parsePlatformPagination(c, 20)).toEqual({ limit: 15, cursor: 'abc123' })
  })
})
