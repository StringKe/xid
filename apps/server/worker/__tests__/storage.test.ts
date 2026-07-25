// GET /storage/logos/* 公开读取路由测试:worker 自 serve R2 logo(见 storage.ts)。
// 覆盖:200 + contentType 白名单 + immutable 缓存头;svg CSP 禁脚本;非白名单类型降级 octet-stream;
//       对象不存在 -> 404。
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { XidHonoEnv } from '../lib/types'
import { registerStorageRoutes } from '../storage'

function asUnknown<T>(v: unknown): T {
  return v as T
}

type StoredObject = { body: string; contentType?: string }

function makeStorage(objects: Record<string, StoredObject>): R2Bucket {
  return asUnknown<R2Bucket>({
    get: async (key: string) => {
      const hit = objects[key]
      if (!hit) return null
      return {
        body: new Response(hit.body).body,
        httpMetadata: hit.contentType ? { contentType: hit.contentType } : {},
      }
    },
  })
}

function request(objects: Record<string, StoredObject>, path: string): Promise<Response> {
  const app = new Hono<XidHonoEnv>()
  registerStorageRoutes(app)
  return app.request(
    `https://xid.dev${path}`,
    {},
    asUnknown<Env>({ STORAGE: makeStorage(objects) }),
  )
}

describe('GET /storage/logos/*', () => {
  it('命中对象 -> 200 + contentType + immutable 缓存头 + nosniff', async () => {
    const key = 'logos/t_1/org_1/uuid-1'
    const res = await request(
      { [key]: { body: 'png-bytes', contentType: 'image/png' } },
      `/storage/${key}`,
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBeNull()
    expect(await res.text()).toBe('png-bytes')
  })

  it('svg -> 带 Content-Security-Policy: script-src none', async () => {
    const key = 'logos/t_1/org_1/uuid-svg'
    const res = await request(
      { [key]: { body: '<svg/>', contentType: 'image/svg+xml' } },
      `/storage/${key}`,
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('content-security-policy')).toBe("script-src 'none'")
  })

  it('非白名单 contentType -> 降级 application/octet-stream(防同域存储型 XSS)', async () => {
    const key = 'logos/t_1/org_1/uuid-html'
    const res = await request(
      { [key]: { body: '<script>alert(1)</script>', contentType: 'text/html' } },
      `/storage/${key}`,
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('无 httpMetadata -> 降级 application/octet-stream', async () => {
    const key = 'logos/t_1/org_1/uuid-nometa'
    const res = await request({ [key]: { body: 'raw' } }, `/storage/${key}`)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
  })

  it('对象不存在 -> 404', async () => {
    const res = await request({}, '/storage/logos/t_1/org_1/missing')

    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('not_found')
  })
})
