// ParStore:RFC9126 PAR,request_uri 60s 有效,一次性。
// 参数服务端存储,authorization request 只传 request_uri。
// 见 oidc-oauth rule / docs/design/03-oidc-oauth.md。
//
// DO name = tenantId,一个租户一个 DO 实例,串行保证。
// request_uri 格式: urn:ietf:params:oauth:request_uri:{random_id}
// 操作:
//   POST /store   { requestUri, params, expiresAt }  -> 存入
//   POST /consume { requestUri }                      -> 取出并删除(一次性)
//   POST /cleanup                                     -> 删除已过期条目(alarm 触发)

export type ParParams = Record<string, string>

type ParEntry = {
  params: ParParams
  expiresAt: number
}

type StoreBody = {
  requestUri: string
  params: ParParams
  expiresAt: number
}

type ConsumeBody = {
  requestUri: string
}

// TTL 上限 60s,alarm 清理过期条目
const MAX_TTL_MS = 60_000

export class ParStore {
  private readonly state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method !== 'POST') {
      return jsonError(405, 'method_not_allowed', 'Method Not Allowed')
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, 'invalid_request', 'Invalid JSON body')
    }

    if (url.pathname === '/store') {
      return this.handleStore(body)
    }
    if (url.pathname === '/consume') {
      return this.handleConsume(body)
    }
    if (url.pathname === '/cleanup') {
      return this.handleCleanup()
    }

    return jsonError(404, 'not_found', 'Unknown path')
  }

  async alarm(): Promise<void> {
    await this.handleCleanup()
  }

  private async handleStore(body: unknown): Promise<Response> {
    if (!isStoreBody(body)) {
      return jsonError(
        400,
        'invalid_request',
        'Missing required fields: requestUri, params, expiresAt',
      )
    }

    const now = Date.now()
    const ttl = body.expiresAt - now

    if (ttl <= 0 || ttl > MAX_TTL_MS) {
      return jsonError(400, 'invalid_request', `expiresAt must be within ${MAX_TTL_MS}ms from now`)
    }

    const entry: ParEntry = {
      params: body.params,
      expiresAt: body.expiresAt,
    }

    await this.state.storage.put(body.requestUri, entry)

    // 确保 alarm 在最近的过期时间触发
    const currentAlarm = await this.state.storage.getAlarm()
    if (currentAlarm === null || body.expiresAt < currentAlarm) {
      await this.state.storage.setAlarm(body.expiresAt)
    }

    return jsonOk({ stored: true })
  }

  private async handleConsume(body: unknown): Promise<Response> {
    if (!isConsumeBody(body)) {
      return jsonError(400, 'invalid_request', 'Missing required field: requestUri')
    }

    const entry = await this.state.storage.get<ParEntry>(body.requestUri)

    if (entry === undefined) {
      return jsonError(404, 'invalid_request', 'request_uri not found or already consumed')
    }

    if (Date.now() > entry.expiresAt) {
      await this.state.storage.delete(body.requestUri)
      return jsonError(400, 'expired_token', 'request_uri has expired')
    }

    // 一次性:取出后立即删除
    await this.state.storage.delete(body.requestUri)

    return jsonOk({ params: entry.params })
  }

  private async handleCleanup(): Promise<Response> {
    const now = Date.now()
    const all = await this.state.storage.list<ParEntry>()
    const toDelete: string[] = []

    for (const [key, entry] of all) {
      if (entry.expiresAt <= now) {
        toDelete.push(key)
      }
    }

    if (toDelete.length > 0) {
      await this.state.storage.delete(toDelete)
    }

    // 若还有未过期条目,设置下一次 alarm
    const remaining = await this.state.storage.list<ParEntry>()
    let nextAlarm: number | null = null
    for (const [, entry] of remaining) {
      if (nextAlarm === null || entry.expiresAt < nextAlarm) {
        nextAlarm = entry.expiresAt
      }
    }

    if (nextAlarm !== null) {
      await this.state.storage.setAlarm(nextAlarm)
    }

    return jsonOk({ deleted: toDelete.length })
  }
}

// --- 类型守卫 ---

function isStoreBody(v: unknown): v is StoreBody {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o['requestUri'] === 'string' &&
    typeof o['params'] === 'object' &&
    o['params'] !== null &&
    typeof o['expiresAt'] === 'number'
  )
}

function isConsumeBody(v: unknown): v is ConsumeBody {
  if (typeof v !== 'object' || v === null) return false
  return typeof (v as Record<string, unknown>)['requestUri'] === 'string'
}

// --- 响应工具 ---

function jsonOk(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: code, error_description: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
