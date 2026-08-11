// 同源 SPA API client:失败一律 XidError;session cookie 经 credentials:'include';401 走 onUnauthorized。

import type { Result, XidError, XidErrorCode } from '@xid-kit/types'

// 网络/解析层无法归类时的兜底,沿用契约 union 不臆造新 code。
const NETWORK_ERROR_CODE: XidErrorCode = 'service_unavailable'
const UNKNOWN_ERROR_CODE: XidErrorCode = 'server_error'

const HTTP_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const
type HttpMethod = (typeof HTTP_METHODS)[number]

export type ApiRequestOptions = {
  method?: HttpMethod
  body?: unknown
  query?: Record<string, string | number | boolean | null | undefined>
  headers?: Record<string, string>
  signal?: AbortSignal
}

export type ApiClientConfig = {
  baseUrl?: string
  onUnauthorized?: () => void
}

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
  // 网关/HTML/空体:模糊通用 code,不外泄底层(枚举防护)。
  return { code: UNKNOWN_ERROR_CODE, message: '', httpStatus: status }
}

function buildUrl(baseUrl: string, path: string, query: ApiRequestOptions['query']): string {
  const url = new URL(`${baseUrl}${path}`, globalThis.location?.origin ?? 'http://localhost')
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value))
    }
  }
  // 同源输出相对路径,避免把 origin 写死进请求。
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

export type ApiErrorObserver = (error: XidError) => void

async function observeResult<T>(
  resultPromise: Promise<Result<T>>,
  observer: ApiErrorObserver,
): Promise<Result<T>> {
  const result = await resultPromise
  if (!result.ok) observer(result.error)
  return result
}

// 只广播失败给跨页面 UI,不重放请求,保留调用方 Result 语义。
export function observeApiClientErrors(client: ApiClient, observer: ApiErrorObserver): ApiClient {
  return {
    request: (path, options) => observeResult(client.request(path, options), observer),
    get: (path, options) => observeResult(client.get(path, options), observer),
    post: (path, body, options) => observeResult(client.post(path, body, options), observer),
    patch: (path, body, options) => observeResult(client.patch(path, body, options), observer),
    del: (path, options) => observeResult(client.del(path, options), observer),
  }
}

export function createApiClient(config: ApiClientConfig = {}): ApiClient {
  const baseUrl = config.baseUrl ?? ''

  async function request<T>(path: string, options: ApiRequestOptions = {}): Promise<Result<T>> {
    const method = options.method ?? 'GET'
    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers }
    const init: RequestInit = {
      method,
      headers,
      // 同源 SPA 依赖 session cookie 读已登录上下文。
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
      // 离线/CORS/中断:模糊 code,message 空串由页面走 lingui。
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

// 默认同源无 401 回调;需要会话失效处理时用 createApiClient 注入 onUnauthorized。
export const api: ApiClient = createApiClient()
