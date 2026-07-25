// SessionDO: per-user active session id set,撤销先更新 DO 内存/storage 再返回。
// 调用方异步落 D1,DO 保证单 user session 操作串行避免竞态。
// JWT 60s 窗口内仍可生效(见 cloudflare-bindings rule 会话存储方案)。
// 见 docs/design/05-users-sessions.md 第 8 节。

import type { Result } from '@xid-kit/types'

const SESSIONS_KEY = 'sessions'
const GENERATION_KEY = 'generation'

type SessionSet = Set<string>

export class SessionDO {
  private readonly state: DurableObjectState
  // 内存缓存,避免每次操作都回 storage
  private sessions: SessionSet | null = null
  private generation: number | null = null
  private initialized = false

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const action = url.pathname.replace(/^\//, '')

    if (action === 'add') {
      const { sessionId, expectedGeneration } = (await request.json()) as {
        sessionId: string
        expectedGeneration?: number
      }
      const result = await this.addSession(sessionId, expectedGeneration)
      return Response.json(result)
    }

    if (action === 'generation') {
      return Response.json({ generation: await this.currentGeneration() })
    }

    if (action === 'revoke') {
      const { sessionId } = (await request.json()) as { sessionId: string }
      const result = await this.revokeSession(sessionId)
      return Response.json(result)
    }

    if (action === 'revoke-all') {
      const result = await this.revokeAll()
      return Response.json(result)
    }

    if (action === 'revoke-all-except') {
      const { sessionId } = (await request.json()) as { sessionId: string }
      const result = await this.revokeAllExcept(sessionId)
      return Response.json(result)
    }

    if (action === 'list') {
      const sessions = await this.listActive()
      return Response.json({ sessions })
    }

    if (action === 'is-active') {
      const { sessionId } = (await request.json()) as { sessionId: string }
      const active = await this.isActive(sessionId)
      return Response.json({ active })
    }

    return new Response('Not Found', { status: 404 })
  }

  // DO 单线程: fetch 串行处理,以下方法不需要额外锁

  // addSession 只接受 revoke-all 前读取到的 generation，避免旧签发重新激活会话。
  async addSession(
    sessionId: string,
    expectedGeneration?: number,
  ): Promise<Result<{ accepted: boolean }>> {
    const set = await this.loadSessions()
    if (expectedGeneration !== undefined && expectedGeneration !== this.generation) {
      return { ok: true, value: { accepted: false } }
    }
    set.add(sessionId)
    await this.persist(set)
    return { ok: true, value: { accepted: true } }
  }

  async revokeSession(sessionId: string): Promise<Result<{ revoked: boolean }>> {
    const set = await this.loadSessions()
    const existed = set.has(sessionId)
    set.delete(sessionId)
    await this.persist(set)
    return { ok: true, value: { revoked: existed } }
  }

  // revokeAll: 清空全部 active session(登出所有设备)
  async revokeAll(): Promise<Result<{ count: number }>> {
    const set = await this.loadSessions()
    const count = set.size
    set.clear()
    this.generation = (this.generation ?? 0) + 1
    await this.persist(set)
    return { ok: true, value: { count } }
  }

  async revokeAllExcept(sessionId: string): Promise<Result<{ count: number }>> {
    const set = await this.loadSessions()
    let count = 0
    for (const activeSessionId of set) {
      if (activeSessionId === sessionId) continue
      set.delete(activeSessionId)
      count += 1
    }
    this.generation = (this.generation ?? 0) + 1
    await this.persist(set)
    return { ok: true, value: { count } }
  }

  async currentGeneration(): Promise<number> {
    await this.loadSessions()
    return this.generation ?? 0
  }

  async listActive(): Promise<string[]> {
    const set = await this.loadSessions()
    return Array.from(set)
  }

  // isActive: 准实时检查(DO 内存 + storage,无网络往返)
  async isActive(sessionId: string): Promise<boolean> {
    const set = await this.loadSessions()
    return set.has(sessionId)
  }

  private async loadSessions(): Promise<SessionSet> {
    if (this.initialized && this.sessions !== null) {
      return this.sessions
    }

    const stored = await this.state.storage.get<string[]>(SESSIONS_KEY)
    this.sessions = new Set(stored ?? [])
    this.generation = (await this.state.storage.get<number>(GENERATION_KEY)) ?? 0
    this.initialized = true
    return this.sessions
  }

  private async persist(set: SessionSet): Promise<void> {
    this.sessions = set
    await Promise.all([
      this.state.storage.put(SESSIONS_KEY, Array.from(set)),
      this.state.storage.put(GENERATION_KEY, this.generation ?? 0),
    ])
  }
}
