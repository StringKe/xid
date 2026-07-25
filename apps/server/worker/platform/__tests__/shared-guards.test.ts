// platform/shared 补充单元测试:顶层 org 过滤与分页边界。
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { isNull } from 'drizzle-orm'
import { schema } from '@xid-kit/db'
import type { XidHonoEnv } from '../../lib/types'
import { MAX_PLATFORM_PAGE_SIZE, parsePlatformPagination, topLevelOrgFilter } from '../shared'

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

describe('topLevelOrgFilter', () => {
  it('filters organizations with null parent_org_id', () => {
    const filter = topLevelOrgFilter()
    expect(filter).toEqual(isNull(schema.organizations.parentOrgId))
  })
})

describe('parsePlatformPagination edge cases', () => {
  it('parses NaN limit as fallback', async () => {
    const c = await ctxForQuery('limit=abc')
    expect(parsePlatformPagination(c, 25).limit).toBe(25)
  })

  it('caps limit at MAX_PLATFORM_PAGE_SIZE', async () => {
    const c = await ctxForQuery(`limit=${MAX_PLATFORM_PAGE_SIZE + 1}`)
    expect(parsePlatformPagination(c, 20).limit).toBe(MAX_PLATFORM_PAGE_SIZE)
  })
})
