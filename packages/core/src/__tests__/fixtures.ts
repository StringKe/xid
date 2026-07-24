import type { ClientStateResponse, TokenResponse } from '../api-client'
import type { XidSession, XidUser } from '../types'

// 构造受控 fetch:按 path 返回预设响应,记录调用次数,供刷新去重/缓存命中断言。
export type RouteHandler = (request: { method: string; body: unknown }) => {
  status: number
  json: unknown
}

export type FakeFetch = typeof fetch & { calls: { path: string; method: string }[] }

export function makeFetch(routes: Record<string, RouteHandler>): FakeFetch {
  const calls: { path: string; method: string }[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const path = url.replace(/^https?:\/\/[^/]+/, '') || url
    const method = init?.method ?? 'GET'
    calls.push({ path, method })

    const handler = routes[path]
    if (!handler) return new Response('null', { status: 404 })

    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const result = handler({ method, body })
    return new Response(JSON.stringify(result.json), { status: result.status })
  }) as FakeFetch
  fetcher.calls = calls
  return fetcher
}

export function makeUser(overrides: Partial<XidUser> = {}): XidUser {
  return {
    id: 'user_1',
    primaryEmailAddress: 'a@b.com',
    primaryPhoneNumber: null,
    emailVerified: true,
    firstName: 'Ada',
    lastName: 'Lovelace',
    fullName: 'Ada Lovelace',
    username: null,
    imageUrl: null,
    hasImage: false,
    publicMetadata: {},
    organizationMemberships: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

export function makeSession(overrides: Partial<XidSession> = {}): XidSession {
  return {
    id: 'sess_1',
    status: 'active',
    userId: 'user_1',
    activeOrganizationId: null,
    lastActiveAt: 0,
    expireAt: 10000,
    abandonAt: 10000,
    createdAt: 0,
    ...overrides,
  }
}

export function makeState(overrides: Partial<ClientStateResponse> = {}): ClientStateResponse {
  return {
    activeSessionId: 'sess_1',
    sessions: [makeSession()],
    user: makeUser(),
    ...overrides,
  }
}

export function makeTokenResponse(overrides: Partial<TokenResponse> = {}): TokenResponse {
  // exp 远在未来,leeway 内不触发刷新。
  const jwt = makeJwt({ exp: 9_999_999_999, sub: 'user_1' })
  return { jwt, ...overrides }
}

export function makeJwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'ES256', kid: 'k1' })}.${b64url(payload)}.${b64url('sig')}`
}

// 浏览器标准 base64url 编码(不依赖 Node Buffer,保持包 DOM-pure)。
function b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
