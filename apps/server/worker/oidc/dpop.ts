// DPoP endpoint 封装(03 章 9.8、RFC9449):调 protocol verifyDpopProof/verifyDpopForResource
// 做 proof 自洽校验,本层补 jti 防重放(OAuthFlowDO 缓存 (htu, jti),TTL=时间窗)。
// 任一失败返回 invalid_dpop_proof;jti 命中 -> 重放拒绝(单次使用)。

import { verifyDpopForResource, verifyDpopProof } from '@xid-kit/protocol'
import type { DpopVerified } from '@xid-kit/protocol'
import type { Result, XidError } from '@xid-kit/types'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { DPOP_PROOF_WINDOW_SEC } from '../lib/ttl'
import { claimReplayKey } from './replay-claim'

function dpopStub(c: Context<XidHonoEnv>): DurableObjectStub {
  const ctx = c.get('tenant')
  const ns = c.env.OAUTH_STATE
  return ns.get(ns.idFromName(`dpop:${ctx.tenantId}`))
}

// 把 (htu, jti) 原子 claim 到 OAuthFlowDO，DO 内部拒绝任何未过期的重复 key。
async function claimJti(
  c: Context<XidHonoEnv>,
  htu: string,
  jti: string,
): Promise<Result<true, XidError>> {
  const claim = await claimReplayKey({
    stub: dpopStub(c),
    key: `${htu}#${jti}`,
    ttlMs: DPOP_PROOF_WINDOW_SEC * 1000,
  })
  if (!claim.ok) return { ok: false, error: claim.error }
  if (!claim.claimed) return replayError()
  return { ok: true, value: true }
}

function replayError(): Result<never, XidError> {
  return {
    ok: false,
    error: { code: 'invalid_dpop_proof', message: 'DPoP jti replayed', httpStatus: 400 },
  }
}

// /token 端点 DPoP 校验:proof 自洽 + jti 防重放,产出 jkt 写 cnf.jkt。
export async function verifyTokenDpop(
  c: Context<XidHonoEnv>,
  proof: string,
): Promise<Result<DpopVerified, XidError>> {
  const ctx = c.get('tenant')
  const result = await verifyDpopProof({
    proof,
    expectedHtm: 'POST',
    expectedHtu: `${ctx.issuer}/token`,
    now: Math.floor(Date.now() / 1000),
  })
  if (!result.ok) return result
  const fresh = await claimJti(c, result.value.htu, result.value.jti)
  if (!fresh.ok) return fresh
  return result
}

// 资源端点(/userinfo)DPoP 校验:proof + ath 绑定 access token + jkt 与绑定 token 一致。
export async function verifyResourceDpop(
  c: Context<XidHonoEnv>,
  input: { proof: string; htu: string; accessToken: string; boundJkt: string },
): Promise<Result<DpopVerified, XidError>> {
  const result = await verifyDpopForResource({
    proof: input.proof,
    expectedHtm: 'GET',
    expectedHtu: input.htu,
    now: Math.floor(Date.now() / 1000),
    accessToken: input.accessToken,
    boundJkt: input.boundJkt,
  })
  if (!result.ok) return result
  const fresh = await claimJti(c, result.value.htu, result.value.jti)
  if (!fresh.ok) return fresh
  return result
}
