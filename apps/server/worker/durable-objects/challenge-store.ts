// ChallengeStore:WebAuthn/OTP/magic-link challenge,TTL 5-10min,验证后销毁一次性。
// 四验证之 challenge:存 DO 强一致,消费后销毁,不可重复消费。
// 见 webauthn rule / docs/design/01-authentication.md 第 1 节。

import { SAML_ASSERTION_REPLAY_MAX_TTL_MS } from '../lib/ttl'

// challenge 记录存储格式
type ChallengeRecord = {
  value: string
  expiresAt: number // ms since epoch
}

// HTTP 路由约定:
//   POST /create  body: { key, value, ttlMs }  -> 201 {}
//   POST /consume body: { key }                 -> 200 { value } | 404 | 410
//   POST /peek    body: { key }                 -> 200 { value } | 404 | 410
//   POST /claim   body: { key, value, ttlMs }    -> 201 | 409 | 400(ttlMs 越界)

const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5min
const MAX_TTL_MS = 10 * 60 * 1000 // 10min
// 重放集要保留到被占用凭证的整个有效期结束,上限单独放宽;越界直接拒绝,不回退默认值。
const MAX_CLAIM_TTL_MS = SAML_ASSERTION_REPLAY_MAX_TTL_MS
const ALARM_LAG_MS = 60 * 1000 // 1min 后触发 alarm 兜底清理
const MAX_DELETE_KEYS = 128 // storage.delete 单次 key 上限

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

  // alarm:单次扫描批量清理已过期 key,按剩余最早过期时间 + lag 再调度
  async alarm(): Promise<void> {
    const now = Date.now()
    const all = await this.ctx.storage.list<ChallengeRecord>()
    const expired: string[] = []
    let nextExpiry: number | null = null
    for (const [k, rec] of all) {
      if (rec.expiresAt <= now) {
        expired.push(k)
      } else if (nextExpiry === null || rec.expiresAt < nextExpiry) {
        nextExpiry = rec.expiresAt
      }
    }
    for (let i = 0; i < expired.length; i += MAX_DELETE_KEYS) {
      await this.ctx.storage.delete(expired.slice(i, i + MAX_DELETE_KEYS))
    }
    if (nextExpiry !== null) {
      await this.ctx.storage.setAlarm(nextExpiry + ALARM_LAG_MS)
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

    if (
      ttlMs !== undefined &&
      (typeof ttlMs !== 'number' ||
        !Number.isFinite(ttlMs) ||
        ttlMs <= 0 ||
        ttlMs > MAX_CLAIM_TTL_MS)
    ) {
      return jsonError(400, 'invalid_request', 'ttlMs out of range')
    }

    const existing = await this.ctx.storage.get<ChallengeRecord>(key)
    if (existing !== undefined && existing.expiresAt > Date.now()) {
      return jsonError(409, 'replay_detected', 'Challenge already claimed')
    }
    if (existing !== undefined) await this.ctx.storage.delete(key)

    const resolvedTtl = ttlMs ?? DEFAULT_TTL_MS
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
