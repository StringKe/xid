// jti / 一次性凭证的重放占位统一入口。OAuthFlowDO `/claim` 在单个 DO 事件内判断并写入:
// 201 = 本次首次占用,409 = 未过期的 key 已被占用(重放)。
//
// 其余任何状态码都意味着协调层本身出了问题:此时既无法证明 key 没被用过,也无法保证占位已落盘。
// 把它当成"占用成功"会让重放防护静默失效(攻击者只要让 DO 报错就能重放 assertion / auth_req_id),
// 把它当成"重放"又会把可重试的基础设施故障伪装成协议错误。所以单独区分成 server_error,fail closed。

import type { XidError } from '@xid-kit/types'

export type ReplayClaimResult =
  | { ok: true; claimed: true }
  | { ok: true; claimed: false }
  | { ok: false; error: XidError }

export async function claimReplayKey(input: {
  stub: DurableObjectStub
  key: string
  ttlMs: number
}): Promise<ReplayClaimResult> {
  const claimed = await input.stub.fetch('https://oauth-flow-do/claim', {
    method: 'POST',
    body: JSON.stringify({ state: input.key, ttlMs: input.ttlMs }),
  })
  if (claimed.status === 201) return { ok: true, claimed: true }
  if (claimed.status === 409) return { ok: true, claimed: false }
  return {
    ok: false,
    error: {
      code: 'server_error',
      message: 'replay protection unavailable',
      httpStatus: 500,
    },
  }
}
