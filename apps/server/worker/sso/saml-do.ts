// SAML 一次性消费集(AuthnRequest ID 防重放 + Assertion ID 防重放),复用 ChallengeStore DO(强一致一次性)。
// AuthnRequest ID(SP-initiated):/login 时 markOnce 存,ACS 时 consumeOnce 取并删,InResponseTo 比对(8.7 step 4)。
// Assertion ID(8.7 step 6):验签通过后 claim,已被占用即重放;占位保留到断言可接受期结束。
// SessionIndex 映射走 D1(saml-session-bindings.ts);SLO 一次性状态见 saml-logout-state.ts。

import { MAX_SAML_CLOCK_SKEW_MS } from '@xid-kit/saml'
import { defaultLandingPathFor } from '@xid-kit/types'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { SAML_ASSERTION_REPLAY_MAX_TTL_MS } from '../lib/ttl'
import type { XidHonoEnv } from '../lib/types'
import { claimReplayKey, consumeOnce, markOnce } from './saml-once'

export { consumeOnce, markOnce } from './saml-once'
export type {
  OutboundSamlLogoutRequestContext,
  OutboundSamlLogoutTarget,
  SamlLogoutRequestReplayInput,
} from './saml-logout-state'
export {
  consumeOutboundLogoutRequestContext,
  isLogoutRequestReplay,
  releaseLogoutRequestReplay,
  storeOutboundLogoutRequestContext,
} from './saml-logout-state'
export type {
  ConsumedSamlSessionBinding,
  OutboundSamlSessionBinding,
  SamlSessionBinding,
  TrackedOutboundSamlSession,
} from './saml-session-bindings'
export {
  peekOutboundSamlSessionsForUser,
  resolveInboundSamlSessionByNameId,
  resolveInboundSamlSessionIndex,
  resolveOutboundSamlSessionIndex,
  restoreConsumedSamlSessionBindings,
  storeInboundSamlSessionIndex,
  trackOutboundSamlSession,
} from './saml-session-bindings'

export type SamlAuthnRequestContext = {
  tenantId: string
  continuePath: string
  applicationClientId: string | null
}

// AuthnRequest ID 存(SP-initiated /login),key 隔离到 connection。
export async function storeAuthnRequestId(
  c: Context<XidHonoEnv>,
  connectionId: string,
  requestId: string,
  context?: SamlAuthnRequestContext,
): Promise<void> {
  await markOnce(
    c.env,
    `saml:req:${connectionId}:${requestId}`,
    context ? JSON.stringify(context) : '1',
  )
}

// 校验 InResponseTo 是我们发出且未消费的 AuthnRequest ID(一次性消费,防重放)。
export async function consumeAuthnRequestId(
  c: Context<XidHonoEnv>,
  connectionId: string,
  inResponseTo: string,
): Promise<boolean> {
  return (await consumeOnce(c.env, `saml:req:${connectionId}:${inResponseTo}`)) !== null
}

export async function consumeAuthnRequestContext(
  c: Context<XidHonoEnv>,
  connectionId: string,
  inResponseTo: string,
): Promise<SamlAuthnRequestContext | null> {
  const value = await consumeOnce(c.env, `saml:req:${connectionId}:${inResponseTo}`)
  if (value === null) return null
  if (value === '1') {
    return {
      tenantId: '',
      continuePath: defaultLandingPathFor(c.get('tenant')),
      applicationClientId: null,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (cause) {
    throw new AppError('server_error', { cause })
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>)['tenantId'] !== 'string' ||
    typeof (parsed as Record<string, unknown>)['continuePath'] !== 'string' ||
    ((parsed as Record<string, unknown>)['applicationClientId'] !== null &&
      typeof (parsed as Record<string, unknown>)['applicationClientId'] !== 'string')
  ) {
    throw new AppError('server_error')
  }
  return parsed as SamlAuthnRequestContext
}

// notOnOrAfter 是内核算出的断言可接受期上界:SAML 2.0 取 Conditions 与 SubjectConfirmationData 两个
// NotOnOrAfter 中较早者(Conditions 缺省时只看后者),SAML 1.1 取 Conditions。两者都要满足才接受,
// 所以占位保留到这个时刻加最大 skew 即覆盖整个可接受期。
export function assertionReplayTtlMs(notOnOrAfter: number, now: number): number {
  return notOnOrAfter + MAX_SAML_CLOCK_SKEW_MS - now
}

// Assertion ID 重放检测:ChallengeStore 单次 claim 成功表示首次出现。
export async function isAssertionReplay(
  c: Context<XidHonoEnv>,
  connectionId: string,
  assertionId: string,
  notOnOrAfter: number,
): Promise<boolean> {
  const key = `saml:assertion:${connectionId}:${assertionId}`
  const ttlMs = assertionReplayTtlMs(notOnOrAfter, Date.now())
  if (!Number.isSafeInteger(notOnOrAfter) || ttlMs <= 0) {
    throw new AppError('assertion_expired', { httpStatus: 403 })
  }
  // 截短保留时间会重新打开重放窗口,所以有效期过长的断言整体拒绝。
  if (ttlMs > SAML_ASSERTION_REPLAY_MAX_TTL_MS) {
    throw new AppError('assertion_expired', {
      httpStatus: 403,
      longMessage: 'saml:assertion_lifetime_exceeds_replay_window',
    })
  }
  return claimReplayKey(c.env, key, ttlMs)
}
