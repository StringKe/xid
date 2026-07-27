// 类型化 API client:对接同源 Worker 的 /v1 Management API 与 OIDC/auth 端点。
// 错误契约对照 worker/middleware/error.ts 的对外 body:{ code, message, longMessage?, meta }。
// credentials:'include' 携带 session cookie(05 章 8);401 经 onUnauthorized 回调统一处理(登出/重定向)。
// 解析后的失败一律为 @xid-kit/types 的 XidError(契约冻结),页面用 code 走 lingui 文案、meta.paramName 映射表单字段。

import type { Result, XidError, XidErrorCode } from '@xid-kit/types'

// 网络/解析层无法归类时的兜底 code(沿用错误契约 union,不臆造新 code)。
const NETWORK_ERROR_CODE: XidErrorCode = 'service_unavailable'
const UNKNOWN_ERROR_CODE: XidErrorCode = 'server_error'

// HTTP 方法白名单(as const union,不用 enum)。
const HTTP_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const
type HttpMethod = (typeof HTTP_METHODS)[number]

export type ApiRequestOptions = {
  method?: HttpMethod
  // 结构化 body(JSON 序列化);GET/DELETE 通常省略。
  body?: unknown
  // 附加查询参数(值会 URL 编码);undefined/null 项跳过。
  query?: Record<string, string | number | boolean | null | undefined>
  // 额外请求头(不覆盖 Accept/Content-Type 默认值的语义)。
  headers?: Record<string, string>
  // 取消信号(超时/卸载),透传给 fetch。
  signal?: AbortSignal
}

export type ApiClientConfig = {
  // 同源默认空串;自托管/自定义域名可注入绝对 base(无尾斜杠)。
  baseUrl?: string
  // 401 统一回调(会话失效):由 AuthProvider 注入,触发登出/跳登录。
  onUnauthorized?: () => void
}

// 判别 Worker 返回体是否为结构化错误形状(对照 error.ts XidApiErrorBody)。
function isErrorBody(value: unknown): value is {
  code: XidErrorCode
  message: string
  longMessage?: string
  meta?: { paramName?: string }
} {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.code === 'string' && typeof v.message === 'string'
}

function toXidError(status: number, body: unknown): XidError {
  if (isErrorBody(body)) {
    const error: XidError = { code: body.code, message: body.message, httpStatus: status }
    if (body.longMessage !== undefined) error.longMessage = body.longMessage
    if (body.meta !== undefined) error.meta = body.meta
    return error
  }
  // 非结构化错误(网关/HTML/空体):模糊到通用 code,不外泄底层细节(枚举防护)。
  return { code: UNKNOWN_ERROR_CODE, message: '', httpStatus: status }
}

function buildUrl(baseUrl: string, path: string, query: ApiRequestOptions['query']): string {
  const url = new URL(`${baseUrl}${path}`, globalThis.location?.origin ?? 'http://localhost')
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value))
    }
  }
  // 同源场景输出相对路径,避免把 origin 写死进请求。
  return baseUrl ? url.toString() : `${url.pathname}${url.search}`
}

async function parseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) return undefined
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

export type ApiClient = {
  request: <T>(path: string, options?: ApiRequestOptions) => Promise<Result<T>>
  get: <T>(path: string, options?: Omit<ApiRequestOptions, 'method' | 'body'>) => Promise<Result<T>>
  post: <T>(
    path: string,
    body?: unknown,
    options?: Omit<ApiRequestOptions, 'method' | 'body'>,
  ) => Promise<Result<T>>
  patch: <T>(
    path: string,
    body?: unknown,
    options?: Omit<ApiRequestOptions, 'method' | 'body'>,
  ) => Promise<Result<T>>
  del: <T>(path: string, options?: Omit<ApiRequestOptions, 'method' | 'body'>) => Promise<Result<T>>
}

export function createApiClient(config: ApiClientConfig = {}): ApiClient {
  const baseUrl = config.baseUrl ?? ''

  async function request<T>(path: string, options: ApiRequestOptions = {}): Promise<Result<T>> {
    const method = options.method ?? 'GET'
    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers }
    const init: RequestInit = {
      method,
      headers,
      // session cookie(05 章 8):同源 SPA 必须带 cookie 才能读已登录上下文。
      credentials: 'include',
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }
    if (options.signal) init.signal = options.signal

    let response: Response
    try {
      response = await fetch(buildUrl(baseUrl, path, options.query), init)
    } catch {
      // 网络层失败(离线/CORS/中断):统一模糊 code,message 留空交给页面走 lingui 文案。
      return { ok: false, error: { code: NETWORK_ERROR_CODE, message: '', httpStatus: 0 } }
    }

    if (response.status === 401) config.onUnauthorized?.()

    const body = await parseBody(response)

    if (!response.ok) return { ok: false, error: toXidError(response.status, body) }

    return { ok: true, value: body as T }
  }

  return {
    request,
    get: (path, options) => request(path, { ...options, method: 'GET' }),
    post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
    patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
    del: (path, options) => request(path, { ...options, method: 'DELETE' }),
  }
}

// 默认同源 client(无 401 回调);AuthProvider 用 createApiClient 注入 onUnauthorized 覆盖。
export const api: ApiClient = createApiClient()
