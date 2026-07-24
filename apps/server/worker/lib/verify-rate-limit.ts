// 认证 verify 链路失败限流(anti-abuse rule 阈值表,01 章 7)。
// 账户级失败 10 次/15min(指数退避)+ IP 级失败 50 次/min(锁 1h),计数走 RateLimitStore DO。
// preCheck 在验证前拒绝已锁定的 account/ip;recordFailure 在验签失败后累加计数。
// 成功路径不累加(不调 recordFailure),account 维度的退避档随成功登录由调用方按需 reset。

import { POLICIES } from '../durable-objects/rate-limit-store'
import { AppError } from './errors'

type RlPolicy = (typeof POLICIES)[keyof typeof POLICIES]

const ACCOUNT_KEY = (tenantId: string, scope: string, account: string) =>
  `verify:acct:${tenantId}:${scope}:${account}`
const IP_KEY = (tenantId: string, scope: string, ip: string) =>
  `verify:ip:${tenantId}:${scope}:${ip}`

// DO 内 check 接口:超限返回 allowed=false(已超阈值,本次也计入超限)。
async function callRateLimit(env: Env, key: string, policy: RlPolicy): Promise<boolean> {
  const ns = env.RATE_LIMITER
  const stub = ns.get(ns.idFromName(key))
  const res = await stub.fetch('https://rate-limit/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, policy }),
  })
  const result = (await res.json()) as { allowed: boolean }
  return result.allowed
}

export type VerifyRateLimitInput = {
  env: Env
  tenantId: string
  // 区分不同 verify 端点(otp / magic_link / passkey),避免计数互相污染。
  scope: string
  // 账户标识(target / userId / credentialId),无法确定时传 null 仅按 IP 限。
  account: string | null
  ip: string | null
}

// verify 端点失败限流:任一维度超限即抛 rate_limited。失败后由调用方再调 recordFailure 累加。
// 设计:本函数累加 IP 计数(每次 verify 都计 IP),account 计数仅在确有 account 时累加。
// 注:DO check 即 incrementAndCheck,因此区分 preCheck/recordFailure 易重复计数;
// 这里采用单点 recordVerifyAttempt:每次 verify 调用一次,超限拒绝,语义为"窗口内尝试次数限制"。
export async function enforceVerifyRateLimit(input: VerifyRateLimitInput): Promise<void> {
  const { env, tenantId, scope, account, ip } = input
  if (ip) {
    const ipAllowed = await callRateLimit(env, IP_KEY(tenantId, scope, ip), POLICIES.IP_FAILURE)
    if (!ipAllowed) throw new AppError('rate_limited')
  }
  if (account) {
    const acctAllowed = await callRateLimit(
      env,
      ACCOUNT_KEY(tenantId, scope, account),
      POLICIES.ACCOUNT_FAILURE,
    )
    if (!acctAllowed) throw new AppError('rate_limited')
  }
}
