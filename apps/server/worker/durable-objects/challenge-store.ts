// ChallengeStore:WebAuthn/OTP/magic-link challenge,TTL 5-10min,验证后销毁一次性。
// 四验证之 challenge:存 DO 强一致,消费后销毁,不可重复消费。
// 见 webauthn rule / docs/design/01-authentication.md 第 1 节。

// challenge 记录存储格式
type ChallengeRecord = {
  value: string
  expiresAt: number // ms since epoch
}

// HTTP 路由约定:
//   POST /create  body: { key, value, ttlMs }  -> 201 {}
//   POST /consume body: { key }                 -> 200 { value } | 404 | 410
//   POST /peek    body: { key }                 -> 200 { value } | 404 | 410
//   POST /claim   body: { key, value, ttlMs }    -> 201 | 409

const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5min
const MAX_TTL_MS = 10 * 60 * 1000 // 10min
const ALARM_LAG_MS = 60 * 1000 // 1min 后触发 alarm 兜底清理

export class ChallengeStore {
  private readonly ctx: DurableObjectState

  constructor(state: DurableObjectState) {
    this.ctx = state
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === 'POST' && path === '/create') {
      return this.handleCreate(request)
    }
    if (request.method === 'POST' && path === '/consume') {
      return this.handleConsume(request)
    }
    if (request.method === 'POST' && path === '/peek') {
      return this.handlePeek(request)
    }
    if (request.method === 'POST' && path === '/claim') {
      return this.handleClaim(request)
    }
    return new Response('Not Found', { status: 404 })
  }

  // alarm:惰性清理所有已过期 key
  async alarm(): Promise<void> {
    const now = Date.now()
    const all = await this.ctx.storage.list<ChallengeRecord>()
    const expired: string[] = []
    for (const [k, rec] of all) {
      if (rec.expiresAt <= now) {
        expired.push(k)
      }
    }
    if (expired.length > 0) {
      await this.ctx.storage.delete(expired)
    }
    // 若仍有记录则再调度一次 alarm
    const remaining = await this.ctx.storage.list()
    if (remaining.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_LAG_MS)
    }
  }

  private async handleCreate(request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, 'invalid_request', 'Request body must be JSON')
    }

    const { key, value, ttlMs } = body as Record<string, unknown>
    if (typeof key !== 'string' || key.length === 0) {
      return jsonError(400, 'invalid_request', 'key is required')
    }
    if (typeof value !== 'string' || value.length === 0) {
      return jsonError(400, 'invalid_request', 'value is required')
    }

    const resolvedTtl =
      typeof ttlMs === 'number' && ttlMs > 0 && ttlMs <= MAX_TTL_MS ? ttlMs : DEFAULT_TTL_MS
    const expiresAt = Date.now() + resolvedTtl

    const record: ChallengeRecord = { value, expiresAt }
    await this.ctx.storage.put(key, record)
    await this.scheduleAlarm(expiresAt + ALARM_LAG_MS)

    return new Response(null, { status: 201 })
  }

  // scheduleAlarm:取 min(现有 alarm, target),保证最早过期记录有兜底清理
  private async scheduleAlarm(target: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    if (current === null || target < current) {
      await this.ctx.storage.setAlarm(target)
    }
  }

  private async handlePeek(request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, 'invalid_request', 'Request body must be JSON')
    }

    const { key } = body as Record<string, unknown>
    if (typeof key !== 'string' || key.length === 0) {
      return jsonError(400, 'invalid_request', 'key is required')
    }

    const record = await this.ctx.storage.get<ChallengeRecord>(key)
    if (record === undefined) {
      return jsonError(404, 'challenge_invalid', 'Challenge not found')
    }
    if (record.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(key)
      return jsonError(410, 'challenge_invalid', 'Challenge expired')
    }

    return new Response(JSON.stringify({ value: record.value }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  private async handleConsume(request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, 'invalid_request', 'Request body must be JSON')
    }

    const { key } = body as Record<string, unknown>
    if (typeof key !== 'string' || key.length === 0) {
      return jsonError(400, 'invalid_request', 'key is required')
    }

    // 原子读取并删除:DO 单线程保证不可重复消费
    const record = await this.ctx.storage.get<ChallengeRecord>(key)
    if (record === undefined) {
      return jsonError(404, 'challenge_invalid', 'Challenge not found')
    }

    if (record.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(key)
      return jsonError(410, 'challenge_invalid', 'Challenge expired')
    }

    // 消费后立即删除(一次性不可重放)
    await this.ctx.storage.delete(key)

    return new Response(JSON.stringify({ value: record.value }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // claim 为重放集提供原子首次写入，不允许 create 的覆盖语义泄漏到断言 ID。
  private async handleClaim(request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, 'invalid_request', 'Request body must be JSON')
    }

    const { key, value, ttlMs } = body as Record<string, unknown>
    if (typeof key !== 'string' || key.length === 0) {
      return jsonError(400, 'invalid_request', 'key is required')
    }
    if (typeof value !== 'string' || value.length === 0) {
      return jsonError(400, 'invalid_request', 'value is required')
    }

    const existing = await this.ctx.storage.get<ChallengeRecord>(key)
    if (existing !== undefined && existing.expiresAt > Date.now()) {
      return jsonError(409, 'replay_detected', 'Challenge already claimed')
    }
    if (existing !== undefined) await this.ctx.storage.delete(key)

    const resolvedTtl =
      typeof ttlMs === 'number' && ttlMs > 0 && ttlMs <= MAX_TTL_MS ? ttlMs : DEFAULT_TTL_MS
    const expiresAt = Date.now() + resolvedTtl
    await this.ctx.storage.put(key, { value, expiresAt })
    await this.scheduleAlarm(expiresAt + ALARM_LAG_MS)
    return new Response(null, { status: 201 })
  }
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
