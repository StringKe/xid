// 认证 verify 链路失败限流(anti-abuse rule 阈值表,01 章 7)。
// 账户级失败 10 次/15min(指数退避)+ IP 级失败 50 次/min(锁 1h),计数走 RateLimitStore DO。
// account 维度的退避档随成功登录由调用方按需 reset。

import { POLICIES } from '../durable-objects/rate-limit-store'
import { AppError } from './errors'
import { checkRateLimitStore } from './rate-limit'

type RlPolicy = (typeof POLICIES)[keyof typeof POLICIES]

const ACCOUNT_KEY = (tenantId: string, scope: string, account: string) =>
  `verify:acct:${tenantId}:${scope}:${account}`
const IP_KEY = (tenantId: string, scope: string, ip: string) =>
  `verify:ip:${tenantId}:${scope}:${ip}`

// DO 内 check 接口:超限返回 allowed=false(已超阈值,本次也计入超限)。
async function callRateLimit(env: Env, key: string, policy: RlPolicy): Promise<boolean> {
  const result = await checkRateLimitStore(env, key, policy)
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

// verify 端点限流:任一维度超限即抛 rate_limited。
// 累加 IP 计数(每次 verify 都计 IP),account 计数仅在确有 account 时累加。
// DO 的 check 就是 check-and-increment,拆成"验证前预检 + 失败后累加"会双计,
// 因此每次 verify 只调本函数一次,语义是"窗口内尝试次数限制"而非"失败次数限制"。
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
