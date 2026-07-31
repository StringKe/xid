// OAuthFlowDO:OAuth state/nonce/PKCE + /authorize 未登录时暂存 OIDC 参数。
// state/nonce 防 CSRF;authorization_code 一次性;jti 防重放;consume 后失效。
// 见 oidc-oauth rule / docs/design/03-oidc-oauth.md。

// OAuth 流程记录:state + nonce + PKCE code_challenge + 暂存 OIDC 参数
type OAuthFlowRecord = {
  state: string
  nonce?: string
  codeChallenge?: string
  codeChallengeMethod?: 'S256'
  tenantId?: string
  connectionId?: string
  provider?: string
  codeVerifier?: string
  redirectAfterLogin?: string
  returnToOrigin?: string
  createdAt?: number
  interactionStartedAt?: number
  // 暂存的 /authorize 请求参数(未登录时挂起,登录后恢复,见 06 章 authorize 状态机)
  pendingParams?: AuthorizePendingParams
  expiresAt: number // ms since epoch
}

// /authorize 暂存参数(login_hint_id 场景)
type AuthorizePendingParams = {
  clientId: string
  redirectUri: string
  scope: string
  responseType: string
  loginHint?: string
  prompt?: string
  acrValues?: string
  responseMode?: string
  resource?: string
}

// HTTP 路由约定:
//   POST /store   body: OAuthFlowRecord(不含 expiresAt) + ttlMs  -> 201 {}
//   POST /consume body: { state }                                 -> 200 { record } | 404 | 410
//   POST /claim   body: { state, ttlMs }                          -> 201 | 409

const DEFAULT_TTL_MS = 10 * 60 * 1000 // 10min
const MAX_TTL_MS = 30 * 60 * 1000 // 30min 上限(含 login 等待时间)
const ALARM_LAG_MS = 60 * 1000 // alarm 兜底偏移

// 验证 store 请求输入,成功返回 null,失败返回错误 Response
function validateStoreInput(input: Record<string, unknown>): Response | null {
  const { state, codeChallengeMethod } = input
  if (typeof state !== 'string' || state.length === 0) {
    return jsonError(400, 'invalid_request', 'state is required')
  }
  // code_challenge_method 只接受 S256(见 oidc-oauth rule:PKCE 强制 S256 only,拒 plain)
  if (codeChallengeMethod !== undefined && codeChallengeMethod !== 'S256') {
    return jsonError(400, 'invalid_request', 'code_challenge_method must be S256')
  }
  return null
}

// 从已验证 input 构建 OAuthFlowRecord
function buildRecord(input: Record<string, unknown>, expiresAt: number): OAuthFlowRecord {
  const {
    state,
    nonce,
    codeChallenge,
    pendingParams,
    tenantId,
    connectionId,
    provider,
    codeVerifier,
    redirectAfterLogin,
    returnToOrigin,
    createdAt,
    interactionStartedAt,
  } = input
  const record: OAuthFlowRecord = { state: state as string, expiresAt }
  if (typeof nonce === 'string' && nonce.length > 0) record.nonce = nonce
  if (typeof codeChallenge === 'string' && codeChallenge.length > 0) {
    record.codeChallenge = codeChallenge
    record.codeChallengeMethod = 'S256'
  }
  if (typeof tenantId === 'string' && tenantId.length > 0) record.tenantId = tenantId
  if (typeof connectionId === 'string' && connectionId.length > 0) {
    record.connectionId = connectionId
  }
  if (typeof provider === 'string' && provider.length > 0) record.provider = provider
  if (typeof codeVerifier === 'string' && codeVerifier.length > 0) {
    record.codeVerifier = codeVerifier
  }
  if (typeof redirectAfterLogin === 'string' && redirectAfterLogin.length > 0) {
    record.redirectAfterLogin = redirectAfterLogin
  }
  if (typeof returnToOrigin === 'string' && returnToOrigin.length > 0) {
    record.returnToOrigin = returnToOrigin
  }
  if (typeof createdAt === 'number' && Number.isFinite(createdAt)) record.createdAt = createdAt
  if (typeof interactionStartedAt === 'number' && Number.isFinite(interactionStartedAt)) {
    record.interactionStartedAt = interactionStartedAt
  }
  if (pendingParams !== undefined && typeof pendingParams === 'object' && pendingParams !== null) {
    record.pendingParams = pendingParams as AuthorizePendingParams
  }
  return record
}

export class OAuthFlowDO {
  private readonly ctx: DurableObjectState

  constructor(state: DurableObjectState) {
    this.ctx = state
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === 'POST' && path === '/store') {
      return this.handleStore(request)
    }
    if (request.method === 'POST' && path === '/consume') {
      return this.handleConsume(request)
    }
    if (request.method === 'POST' && path === '/claim') {
      return this.handleClaim(request)
    }
    return new Response('Not Found', { status: 404 })
  }

  // alarm:惰性清理过期 state
  async alarm(): Promise<void> {
    const now = Date.now()
    const all = await this.ctx.storage.list<OAuthFlowRecord>()
    const expired: string[] = []
    for (const [k, rec] of all) {
      if (rec.expiresAt <= now) {
        expired.push(k)
      }
    }
    if (expired.length > 0) {
      await this.ctx.storage.delete(expired)
    }
    const remaining = await this.ctx.storage.list()
    if (remaining.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_LAG_MS)
    }
  }

  private async handleStore(request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, 'invalid_request', 'Request body must be JSON')
    }

    const input = body as Record<string, unknown>
    const validationErr = validateStoreInput(input)
    if (validationErr !== null) return validationErr

    const { ttlMs } = input
    const resolvedTtl =
      typeof ttlMs === 'number' && ttlMs > 0 && ttlMs <= MAX_TTL_MS ? ttlMs : DEFAULT_TTL_MS
    const expiresAt = Date.now() + resolvedTtl
    const record = buildRecord(input, expiresAt)

    await this.ctx.storage.put(record.state, record)

    // 兜底 alarm:取 min(现有 alarm, 本记录过期时间),保证最早过期记录有兜底
    const target = expiresAt + ALARM_LAG_MS
    const current = await this.ctx.storage.getAlarm()
    if (current === null || target < current) {
      await this.ctx.storage.setAlarm(target)
    }

    return new Response(null, { status: 201 })
  }

  private async handleConsume(request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, 'invalid_request', 'Request body must be JSON')
    }

    const { state } = body as Record<string, unknown>
    if (typeof state !== 'string' || state.length === 0) {
      return jsonError(400, 'invalid_request', 'state is required')
    }

    // DO 单线程串行:read-then-delete 原子语义,防重放
    const record = await this.ctx.storage.get<OAuthFlowRecord>(state)
    if (record === undefined) {
      return jsonError(404, 'invalid_request', 'State not found')
    }

    if (record.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(state)
      return jsonError(410, 'invalid_request', 'State expired')
    }

    // 消费后立即删除,同一 state 不可重复使用
    await this.ctx.storage.delete(state)

    return new Response(JSON.stringify({ record }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // claim 在同一 DO 事件中判断并写入，供 jti 与一次性凭证重放防护使用。
  private async handleClaim(request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, 'invalid_request', 'Request body must be JSON')
    }

    const input = body as Record<string, unknown>
    const validationErr = validateStoreInput(input)
    if (validationErr !== null) return validationErr

    const state = input['state'] as string
    const existing = await this.ctx.storage.get<OAuthFlowRecord>(state)
    if (existing !== undefined && existing.expiresAt > Date.now()) {
      return jsonError(409, 'replay_detected', 'State already claimed')
    }
    if (existing !== undefined) await this.ctx.storage.delete(state)

    const ttlMs = input['ttlMs']
    const resolvedTtl =
      typeof ttlMs === 'number' && ttlMs > 0 && ttlMs <= MAX_TTL_MS ? ttlMs : DEFAULT_TTL_MS
    const expiresAt = Date.now() + resolvedTtl
    const record = buildRecord(input, expiresAt)
    await this.ctx.storage.put(record.state, record)

    const target = expiresAt + ALARM_LAG_MS
    const current = await this.ctx.storage.getAlarm()
    if (current === null || target < current) {
      await this.ctx.storage.setAlarm(target)
    }
    return new Response(null, { status: 201 })
  }
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
