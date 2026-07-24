// API client 测试:XidError 解析(结构化/非结构化)、401 回调、credentials/method 透传。
// node 环境无浏览器 fetch 真实网络,stub globalThis.fetch 断言请求装配与响应映射。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../api'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createApiClient', () => {
  it('成功响应返回 ok=true 与解析后的 value', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { user: { id: 'u1' } }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createApiClient()
    const result = await client.get<{ user: { id: string } }>('/v1/me')

    expect(result).toEqual({ ok: true, value: { user: { id: 'u1' } } })
  })

  it('结构化错误体映射为 XidError(code/message/longMessage/meta)', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(422, {
        code: 'validation_failed',
        message: 'Validation failed. Please check your input.',
        longMessage: 'Email is invalid.',
        meta: { paramName: 'email' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const client = createApiClient()
    const result = await client.post('/v1/users', { email: 'bad' })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'validation_failed',
        message: 'Validation failed. Please check your input.',
        httpStatus: 422,
        longMessage: 'Email is invalid.',
        meta: { paramName: 'email' },
      },
    })
  })

  it('非结构化错误体(HTML/空)模糊到 server_error,不外泄内部细节', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('<html>gateway error</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const client = createApiClient()
    const result = await client.get('/v1/me')

    expect(result).toEqual({
      ok: false,
      error: { code: 'server_error', message: '', httpStatus: 502 },
    })
  })

  it('401 触发 onUnauthorized 回调', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(401, { code: 'unauthorized', message: 'Authentication is required.' }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const onUnauthorized = vi.fn<() => void>()

    const client = createApiClient({ onUnauthorized })
    await client.get('/v1/me')

    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('网络层失败返回 service_unavailable 兜底', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    const client = createApiClient()
    const result = await client.get('/v1/me')

    expect(result).toEqual({
      ok: false,
      error: { code: 'service_unavailable', message: '', httpStatus: 0 },
    })
  })

  it('请求始终带 credentials=include 与 JSON body', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, {}))
    vi.stubGlobal('fetch', fetchMock)

    const client = createApiClient()
    await client.post('/auth/sign-out', { reason: 'manual' })

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.credentials).toBe('include')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ reason: 'manual' }))
  })
})
