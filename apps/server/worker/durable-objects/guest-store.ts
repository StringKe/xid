// GuestStore:guest(匿名访客)anonKey -> guest user id 绑定的串行 check-and-set。
// 实例名 {tenantId}:{anonKey}(调用方派生),DO 单线程保证同一 anonKey 并发请求只绑定一个 user。
// 绑定 TTL 由调用方按租户 session policy 推导传入,alarm 到期惰性清理。
// 见 docs/design/01-authentication.md guest 模式、cloudflare-bindings rule(强一致状态入 DO)。

// 绑定记录存储格式(每实例一条,实例本身已按 tenant:anonKey 分片)。
type GuestBindingRecord = {
  userId: string
  expiresAt: number // ms since epoch
}

// HTTP 路由约定:
//   POST /lookup body: {}                    -> 200 { userId } | 404
//   POST /bind   body: { userId, ttlMs }     -> 200 { userId, created }
//   POST /unbind body: {}                    -> 204
// bind 是 check-and-set:已有未过期绑定返回既有 userId(created=false),调用方据此续签而非建号。

const BINDING_KEY = 'binding'
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30d(ttlMs 应由调用方必传,此处只兜底)
const ALARM_LAG_MS = 60 * 1000 // 1min 后触发 alarm 兜底清理

export class GuestStore {
  private readonly ctx: DurableObjectState

  constructor(state: DurableObjectState) {
    this.ctx = state
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === 'POST' && path === '/lookup') {
      return this.handleLookup()
    }
    if (request.method === 'POST' && path === '/bind') {
      return this.handleBind(request)
    }
    if (request.method === 'POST' && path === '/unbind') {
      await this.ctx.storage.delete(BINDING_KEY)
      return new Response(null, { status: 204 })
    }
    return new Response('Not Found', { status: 404 })
  }

  // alarm:惰性清理过期绑定;记录仍在则再调度一次。
  async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<GuestBindingRecord>(BINDING_KEY)
    if (record !== undefined && record.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(BINDING_KEY)
      return
    }
    if (record !== undefined) {
      await this.ctx.storage.setAlarm(record.expiresAt + ALARM_LAG_MS)
    }
  }

  private async liveBinding(): Promise<GuestBindingRecord | undefined> {
    const record = await this.ctx.storage.get<GuestBindingRecord>(BINDING_KEY)
    if (record === undefined) return undefined
    if (record.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(BINDING_KEY)
      return undefined
    }
    return record
  }

  private async handleLookup(): Promise<Response> {
    const record = await this.liveBinding()
    if (record === undefined) {
      return new Response('Not Found', { status: 404 })
    }
    return Response.json({ userId: record.userId })
  }

  private async handleBind(request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
    const { userId, ttlMs } = body as Record<string, unknown>
    if (typeof userId !== 'string' || userId.length === 0) {
      return new Response('userId is required', { status: 400 })
    }

    // 事务内 check-and-set:并发同一实例的两个 bind 只有一个能写入,
    // 另一个读到胜出者的既有绑定(created=false),调用方丢弃自己新建的用户。
    const resolvedTtl = typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS
    const outcome = await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<GuestBindingRecord>(BINDING_KEY)
      if (existing !== undefined && existing.expiresAt > Date.now()) {
        return { userId: existing.userId, created: false, expiresAt: existing.expiresAt }
      }
      const expiresAt = Date.now() + resolvedTtl
      await txn.put(BINDING_KEY, { userId, expiresAt } satisfies GuestBindingRecord)
      return { userId, created: true, expiresAt }
    })

    if (outcome.created) {
      const current = await this.ctx.storage.getAlarm()
      if (current === null || outcome.expiresAt + ALARM_LAG_MS < current) {
        await this.ctx.storage.setAlarm(outcome.expiresAt + ALARM_LAG_MS)
      }
    }
    return Response.json({ userId: outcome.userId, created: outcome.created })
  }
}
