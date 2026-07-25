// RateLimitStore: 按租户/账户/IP 维度限流,强一致防滥用。
// 计数器存 DO SQLite storage,TTL 自动过期。
// 阈值表(anti-abuse rule):
//   账户失败: 10次/15min,指数退避 5/15/30/60min
//   IP 失败:  50次/min,锁 1h
//   OTP 发送: 1次/min/接收方
// 见 docs/design/01-authentication.md 第 7 节。

import type { Result } from '@xid-kit/types'

// 策略定义(阈值表)
export type RateLimitPolicy = {
  windowMs: number
  maxRequests: number
  // 触发限流后锁定时长(毫秒),0 = 仅窗口自然过期
  lockDurationMs: number
  // 指数退避阶梯(毫秒);设置后超限按 backoff_count 取阶梯,忽略 lockDurationMs
  backoffStepsMs?: readonly number[]
}

export type CheckResult = {
  allowed: boolean
  // 距离解锁或窗口重置的秒数(allowed=false 时有效)
  retryAfter: number
  count: number
}

export type RateLimitWindow = {
  key: string
  policy: RateLimitPolicy
  increment?: number
}

export type ReserveWindowsResult = {
  allowed: boolean
  retryAfter: number
  counts: number[]
}

// 账户登录失败指数退避阶梯(单位 ms),anti-abuse rule 阈值
const ACCOUNT_BACKOFF_STEPS_MS = [
  5 * 60 * 1000, // 5min
  15 * 60 * 1000, // 15min
  30 * 60 * 1000, // 30min
  60 * 60 * 1000, // 60min
] as const

// 内置策略常量
export const POLICIES = {
  // 账户级登录失败: 10次/15min,触发后按退避阶梯 5/15/30/60min 升级
  ACCOUNT_FAILURE: {
    windowMs: 15 * 60 * 1000,
    maxRequests: 10,
    lockDurationMs: 0,
    backoffStepsMs: ACCOUNT_BACKOFF_STEPS_MS,
  },
  // IP 级失败: 50次/min,锁 1h
  IP_FAILURE: {
    windowMs: 60 * 1000,
    maxRequests: 50,
    lockDurationMs: 60 * 60 * 1000,
  },
  // OTP 发送: 1次/min/接收方
  OTP_SEND: {
    windowMs: 60 * 1000,
    maxRequests: 1,
    lockDurationMs: 0,
  },
  // DCR 动态注册(RFC7591): 10次/h/IP,防匿名滥用注册
  DCR_REGISTER: {
    windowMs: 60 * 60 * 1000,
    maxRequests: 10,
    lockDurationMs: 60 * 60 * 1000,
  },
} as const satisfies Record<string, RateLimitPolicy>

// storage key helpers
const entryKey = (key: string) => `rl:${key}`
const lockKey = (key: string) => `lock:${key}`
const backoffKey = (key: string) => `backoff_count:${key}`

type StoredEntry = {
  count: number
  windowStart: number
}

export class RateLimitStore {
  private readonly state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const action = url.pathname.replace(/^\//, '')

    if (action === 'check') {
      const body = (await request.json()) as {
        key: string
        policy: RateLimitPolicy
        count?: number
      }
      const count = body.count ?? 1
      if (!Number.isInteger(count) || count < 1) {
        return Response.json({ error: 'count must be a positive integer' }, { status: 400 })
      }
      const result = await this.checkAndIncrement(body.key, body.policy, count)
      return Response.json(result)
    }

    if (action === 'reserve') {
      const body = (await request.json()) as { windows?: RateLimitWindow[] }
      if (!Array.isArray(body.windows) || body.windows.length === 0) {
        return Response.json({ error: 'windows must be a non-empty array' }, { status: 400 })
      }
      try {
        return Response.json(await this.reserveWindows(body.windows))
      } catch (error) {
        const message = error instanceof Error ? error.message : 'invalid reservation'
        return Response.json({ error: message }, { status: 400 })
      }
    }

    if (action === 'reset') {
      const body = (await request.json()) as { key: string }
      await this.reset(body.key)
      return Response.json({ ok: true })
    }

    return new Response('Not Found', { status: 404 })
  }

  // checkAndIncrement: DO 单线程保证计数原子,可按批量预留配额且无 race condition。
  async checkAndIncrement(
    key: string,
    policy: RateLimitPolicy,
    increment: number = 1,
  ): Promise<CheckResult> {
    const now = Date.now()

    const lockExpiry = await this.state.storage.get<number>(lockKey(key))
    if (lockExpiry !== undefined && now < lockExpiry) {
      return {
        allowed: false,
        retryAfter: Math.ceil((lockExpiry - now) / 1000),
        count: policy.maxRequests,
      }
    }

    const stored = await this.state.storage.get<StoredEntry>(entryKey(key))
    const windowStart =
      stored !== undefined && now - stored.windowStart < policy.windowMs ? stored.windowStart : now

    const currentCount =
      stored !== undefined && now - stored.windowStart < policy.windowMs ? stored.count : 0

    const newCount = currentCount + increment

    if (newCount > policy.maxRequests) {
      const lockMs = await this.resolveLockMs(key, policy)
      if (lockMs > 0) {
        await this.state.storage.put(lockKey(key), now + lockMs)
        return { allowed: false, retryAfter: Math.ceil(lockMs / 1000), count: newCount }
      }

      const windowRemaining = policy.windowMs - (now - windowStart)
      return { allowed: false, retryAfter: Math.ceil(windowRemaining / 1000), count: newCount }
    }

    await this.state.storage.put(entryKey(key), {
      count: newCount,
      windowStart,
    })

    return {
      allowed: true,
      retryAfter: 0,
      count: newCount,
    }
  }

  // 多窗口发送配额必须在同一 DO 请求内先检查再提交，避免 hour 拒绝时消耗 minute 配额。
  async reserveWindows(windows: readonly RateLimitWindow[]): Promise<ReserveWindowsResult> {
    const now = Date.now()
    const keys = new Set<string>()
    const candidates: Array<{
      key: string
      count: number
      windowStart: number
      policy: RateLimitPolicy
      allowed: boolean
      retryAfter: number
    }> = []

    for (const window of windows) {
      const increment = window.increment ?? 1
      if (!window.key || !Number.isInteger(increment) || increment < 1) {
        throw new Error('window key and increment must be valid')
      }
      if (keys.has(window.key)) throw new Error('combined reservation keys must be unique')
      keys.add(window.key)
      if (window.policy.lockDurationMs !== 0 || window.policy.backoffStepsMs?.length) {
        throw new Error('combined reservation only supports natural-expiry windows')
      }

      const stored = await this.state.storage.get<StoredEntry>(entryKey(window.key))
      const isCurrentWindow =
        stored !== undefined && now - stored.windowStart < window.policy.windowMs
      const windowStart = isCurrentWindow ? stored.windowStart : now
      const currentCount = isCurrentWindow ? stored.count : 0
      const count = currentCount + increment
      const allowed = count <= window.policy.maxRequests
      candidates.push({
        key: window.key,
        count,
        windowStart,
        policy: window.policy,
        allowed,
        retryAfter: allowed ? 0 : Math.ceil((window.policy.windowMs - (now - windowStart)) / 1000),
      })
    }

    const rejected = candidates.find((candidate) => !candidate.allowed)
    if (rejected) {
      return {
        allowed: false,
        retryAfter: rejected.retryAfter,
        counts: candidates.map((candidate) => candidate.count),
      }
    }

    for (const candidate of candidates) {
      await this.state.storage.put(entryKey(candidate.key), {
        count: candidate.count,
        windowStart: candidate.windowStart,
      })
    }
    return { allowed: true, retryAfter: 0, counts: candidates.map((candidate) => candidate.count) }
  }

  // resolveLockMs: 超限时算本次锁定时长(同一 DO 请求内原子)。
  // 有 backoffStepsMs 则按 backoff_count 取阶梯并自增计数,否则用固定 lockDurationMs。
  private async resolveLockMs(key: string, policy: RateLimitPolicy): Promise<number> {
    const steps = policy.backoffStepsMs
    if (steps === undefined || steps.length === 0) {
      return policy.lockDurationMs
    }
    const count = (await this.state.storage.get<number>(backoffKey(key))) ?? 0
    const index = Math.min(count, steps.length - 1)
    await this.state.storage.put(backoffKey(key), count + 1)
    return steps[index] as number
  }

  // reset: 登录成功后清除账户失败计数、锁定、退避阶梯(真正重置退避档)
  async reset(key: string): Promise<Result<void>> {
    await this.state.storage.delete(entryKey(key))
    await this.state.storage.delete(lockKey(key))
    await this.state.storage.delete(backoffKey(key))
    return { ok: true, value: undefined }
  }
}
