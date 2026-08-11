// RateLimitStore 业务限流入口:DO 不可达时 fail-closed 抛 server_error,禁止降级放行。
// DO 按 key 分片,单实例故障只影响该账户/IP 维度。

import type { RateLimitPolicy, RateLimitWindow } from '../durable-objects/rate-limit-store'
import { AppError } from './errors'

export type RateLimitDecision = {
  allowed: boolean
  retryAfter: number
  count: number
}

type RateLimitStoreResponse = {
  allowed?: unknown
  retryAfter?: unknown
  count?: unknown
}

function parseRateLimitDecision(value: RateLimitStoreResponse): RateLimitDecision | null {
  if (typeof value.allowed !== 'boolean') return null
  return {
    allowed: value.allowed,
    retryAfter: typeof value.retryAfter === 'number' ? value.retryAfter : 0,
    count: typeof value.count === 'number' ? value.count : 0,
  }
}

// cause 仅进服务端日志,客户端统一 server_error(不泄露限流器内部状态)。
function rateLimitUnavailable(cause?: unknown): never {
  throw new AppError('server_error', { cause })
}

// 先查 HTTP 状态再解析 body:DO 故障常返回非 JSON,先 parse 会得到 SyntaxError 或误读 allowed:true。
async function postToRateLimitStore(
  env: Env,
  doName: string,
  action: 'check' | 'reserve' | 'reset',
  body: unknown,
): Promise<RateLimitStoreResponse> {
  const ns = env.RATE_LIMITER
  const stub = ns.get(ns.idFromName(doName))
  const res = await stub.fetch(`https://rate-limit/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status !== 200) rateLimitUnavailable()

  let payload: unknown
  try {
    payload = await res.json()
  } catch (error) {
    rateLimitUnavailable(error)
  }
  if (typeof payload !== 'object' || payload === null) rateLimitUnavailable()
  return payload as RateLimitStoreResponse
}

// count 是批量消耗单位(如批量邀请);省略会把 N 条请求计成 1 次。
export async function checkRateLimitStore(
  env: Env,
  key: string,
  policy: RateLimitPolicy,
  options: { count?: number } = {},
): Promise<RateLimitDecision> {
  const payload = await postToRateLimitStore(env, key, 'check', {
    key,
    policy,
    count: options.count ?? 1,
  })

  const decision = parseRateLimitDecision(payload)
  if (!decision) rateLimitUnavailable()
  return decision
}

// 多窗口配额在一次 DO 调用内原子 reserve,避免小时窗拒绝却已烧掉分钟配额;基础设施故障用 500 而非 429。
export async function reserveRateLimitWindows(
  env: Env,
  reservationKey: string,
  windows: readonly RateLimitWindow[],
): Promise<void> {
  const payload = await postToRateLimitStore(env, reservationKey, 'reserve', { windows })

  if (typeof payload.allowed !== 'boolean') rateLimitUnavailable()
  if (!payload.allowed) throw new AppError('rate_limited')
}

export async function resetRateLimitStore(env: Env, key: string): Promise<void> {
  await postToRateLimitStore(env, key, 'reset', { key })
}
