// Single entry point for every RateLimitStore DO call (check and reserve alike).
// Rate limiting is the third layer of abuse defense (the business layer). Treating an unreachable
// DO as "allowed" would remove brute force, OTP bombing and DCR spam protection at once, so this
// module fails closed: a non-200 status, a non-JSON body, or a missing / non-boolean allowed field
// all raise server_error instead of letting the request through.
// The DO is sharded by key (idFromName(key)), so one flaky instance affects a single account or IP
// dimension and never every user, which is why there is no degraded pass-through path.

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

// The internal reason stays in cause (server logs only). The client always sees a plain
// server_error, so rate limiter internals never leak (enumeration defense).
function rateLimitUnavailable(cause?: unknown): never {
  throw new AppError('server_error', { cause })
}

// Single transport for every RateLimitStore call. The HTTP status is checked before the body is
// read: a DO failure usually answers with a non-JSON error page, so parsing first would surface a
// raw SyntaxError instead of a typed AppError, and a failure body that still carries
// allowed:true would be read as a pass.
async function postToRateLimitStore(
  env: Env,
  doName: string,
  action: 'check' | 'reserve',
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

// count carries the batch size for callers that consume more than one unit per request (bulk
// invitations). Dropping it would silently degrade a 30-invitation batch into one counted unit.
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

// Multi-window send quotas (1/min + 5/h) reserve every window inside one DO call so an hour-window
// rejection cannot burn the minute quota. Infrastructure faults MUST NOT surface as rate_limited:
// 429 tells the caller to slow down, while a broken DO is a 500 that should page an operator.
export async function reserveRateLimitWindows(
  env: Env,
  reservationKey: string,
  windows: readonly RateLimitWindow[],
): Promise<void> {
  const payload = await postToRateLimitStore(env, reservationKey, 'reserve', { windows })

  if (typeof payload.allowed !== 'boolean') rateLimitUnavailable()
  if (!payload.allowed) throw new AppError('rate_limited')
}
